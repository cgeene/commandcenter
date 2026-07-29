import { execFile } from "node:child_process";
import os from "node:os";
import { getSchedulerConfig } from "../db/settings.js";
import { localeEnv } from "./locale.js";

/** Wall-clock cap on one verify command's EXECUTION. Time spent queued behind
 *  another verify is not counted against it — the semaphore below is acquired
 *  before the child is spawned. The Stop-hook handler blocks for this long in
 *  the worst case, so hooks.ts's stall sweep is keyed off it. */
export const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Longest a queued verify waits for a slot before it gives up on waiting and
 * runs anyway (recorded as `bypassed_queue`).
 *
 * Fail-open on purpose. A verify that never runs leaves its task parked
 * in_progress with a finished worker until the stall sweep rescues it, which
 * re-runs the command anyway — so refusing to run is strictly worse than
 * running under contention, as long as the contention is recorded (it is; see
 * VerifyLoad) and the wait is bounded. Comfortably longer than one
 * VERIFY_TIMEOUT_MS so a single long-running suite ahead in the queue never
 * trips it.
 */
export const VERIFY_QUEUE_MAX_WAIT_MS = 30 * 60 * 1000;

/** Safety net against a lost wake-up: a waiter re-checks the queue this often
 *  even if nobody signals it. */
const QUEUE_POLL_MS = 5_000;

const VERIFY_MAX_BUFFER = 1024 * 1024;

/**
 * Every setting the daemon reads for itself is CC_-prefixed (see src/config.ts),
 * credentials included: CC_NTFY_TOKEN, CC_JIRA_TOKEN, CC_ANTHROPIC_ADMIN_KEY.
 * The filter denies the prefix instead of naming today's secrets, because a
 * named list goes stale the moment a new one is added — and the failure mode of
 * a stale list is a silently leaked credential.
 */
const DAEMON_ENV_PREFIX = "CC_";

/**
 * Environment for a verify child.
 *
 * A verify_cmd is arbitrary repo code (typically `npm test`) that the daemon
 * spawns from its own process, so an inherited environment hands the operator's
 * real credentials to a whole test suite — and to anything that suite calls.
 * Non-CC_ variables are kept: the command still needs PATH, HOME, the NODE_
 * family and the rest of its toolchain, and a repo's own test prerequisites
 * cannot be enumerated here.
 */
export function verifyEnv(
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (key.startsWith(DAEMON_ENV_PREFIX)) continue;
    filtered[key] = value;
  }
  // Verify output is captured verbatim into events; a C-locale child mangles
  // non-ASCII test output exactly the way it mangles tmux glyphs.
  return localeEnv(filtered);
}

/* ------------------------------------------------------------------ *
 * The verify semaphore.
 *
 * A verify_cmd is arbitrary repo code and is typically the repo's whole test
 * suite. Every worker runs one at its Stop, every reviewer's fix round runs
 * another, and the freshen pass runs its own on the daemon's timer — nothing
 * used to coordinate them, so aggregate verify load scaled linearly with the
 * fleet and a suite that passes on a quiet box could fail purely from
 * contention. A false failure is not free: it spends the task's verify-retry
 * budget and can block a defect-free task.
 *
 * So verify runs are serialized here, at the single exec site both callers go
 * through, rather than in either caller. Concurrency is 1 by default and
 * configurable (scheduler.verify_concurrency) for a box that can afford more.
 * The queue is in-daemon-process memory, which is where all three producers
 * live; a daemon restart drops the queue, and the events a dropped run leaves
 * behind go stale on their own (see verifyInFlight in hooks.ts).
 * ------------------------------------------------------------------ */

/** What the box looked like around one verify run. Recorded on the failure
 *  event so a contention-induced failure can be told from a real defect. */
export interface VerifyLoad {
  /** Peak verify runs executing at once while this one ran, itself included.
   *  1 means the daemon was not running anything else against the box. */
  concurrent: number;
  /** The configured ceiling this run was admitted under. */
  limit: number;
  /** Time spent waiting for a slot. Not counted against VERIFY_TIMEOUT_MS. */
  queued_ms: number;
  /** Time the command itself ran. */
  run_ms: number;
  /** 1-minute load average when the command finished, and the core count to
   *  read it against — `load1 / cores` above ~1 means the box was saturated,
   *  by anything, ours or not. */
  load1: number;
  cores: number;
  /** The wait bound expired and the run started without waiting for a slot, so
   *  `concurrent` may exceed `limit`. */
  bypassed_queue: boolean;
}

export interface VerifyResult {
  ok: boolean;
  output: string;
  load: VerifyLoad;
}

export interface RunVerifyOptions {
  /** Called once, only if the run has to wait, with how many verify runs are
   *  ahead of it. */
  onQueued?: (ahead: number) => void;
  /** Called once the slot is held, immediately before the child is spawned.
   *  hooks.ts logs `verify.started` here and nowhere else: verifyInFlight() and
   *  stalledFinishedWorkers() read that event as "a command is executing right
   *  now", so logging it while the run is still queued would make both lie. */
  onStart?: () => void;
}

interface Slot {
  /** Peak concurrent slot count observed for as long as this one is held. */
  peak: number;
}

interface Waiter {
  /** Set while this waiter is asleep; cleared as it is woken. */
  wake: (() => void) | null;
}

let queueWaitOverrideMs: number | null = null;

/** Test-only: shrink the wait bound so the fail-open path is reachable without
 *  a 30-minute test. Pass null to restore. */
export function __setVerifyQueueWaitForTests(ms: number | null): void {
  queueWaitOverrideMs = ms;
}

function queueWaitMs(): number {
  return queueWaitOverrideMs ?? VERIFY_QUEUE_MAX_WAIT_MS;
}

const active = new Set<Slot>();
/** FIFO. Only the head may take a freed slot, so a queued verify cannot be
 *  starved by a steady stream of new arrivals. */
const queue: Waiter[] = [];

/** Configured ceiling, floored at 1. Read per acquisition so an operator
 *  raising it does not need a daemon restart. Defaults to 1 if settings are
 *  unreadable (no db yet) — the safe direction. */
export function verifyConcurrencyLimit(): number {
  try {
    const n = getSchedulerConfig().verify_concurrency;
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  } catch {
    return 1;
  }
}

function admit(): Slot {
  const slot: Slot = { peak: 0 };
  active.add(slot);
  for (const held of active) held.peak = Math.max(held.peak, active.size);
  return slot;
}

function wakeHead(): void {
  const head = queue[0];
  if (!head?.wake) return;
  const wake = head.wake;
  head.wake = null;
  wake();
}

function release(slot: Slot): void {
  active.delete(slot);
  wakeHead();
}

async function acquire(
  onQueued?: (ahead: number) => void,
): Promise<{ slot: Slot; queuedMs: number; bypassed: boolean }> {
  if (active.size < verifyConcurrencyLimit() && queue.length === 0) {
    return { slot: admit(), queuedMs: 0, bypassed: false };
  }

  const startedWaiting = Date.now();
  const self: Waiter = { wake: null };
  // Enqueueing and announcing both belong INSIDE the try: onQueued is a caller
  // callback that writes an event, so it can throw, and a waiter left in the
  // queue by a skipped cleanup is permanent. It would be a zombie head — asleep
  // with nobody able to wake it — which makes the fast path below unreachable
  // for every later run, so each one waits out the whole bound and then runs
  // unserialized. That is worse than having no queue at all, and silent.
  try {
    queue.push(self);
    onQueued?.(active.size + queue.length - 1);
    for (;;) {
      if (queue[0] === self && active.size < verifyConcurrencyLimit()) {
        return { slot: admit(), queuedMs: Date.now() - startedWaiting, bypassed: false };
      }
      const remaining = queueWaitMs() - (Date.now() - startedWaiting);
      if (remaining <= 0) {
        return { slot: admit(), queuedMs: Date.now() - startedWaiting, bypassed: true };
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          self.wake = null;
          resolve();
        }, Math.min(remaining, QUEUE_POLL_MS));
        self.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  } finally {
    const at = queue.indexOf(self);
    if (at >= 0) queue.splice(at, 1);
    // A new head may have been waiting behind this one; if there is room it
    // must be woken now, since the release that would have done it is past.
    if (active.size < verifyConcurrencyLimit()) wakeHead();
  }
}

/** Was this run measurably competing with another verify? True only on the
 *  daemon's own self-knowledge (a second run in flight, or a queue bypass) —
 *  never inferred from load average, which a single honest test suite drives
 *  above the core count all by itself. */
export function verifyWasContended(load: VerifyLoad): boolean {
  return load.concurrent > 1 || load.bypassed_queue;
}

/** One-line, human-readable version of a VerifyLoad, for notifications. */
export function verifyLoadNote(load: VerifyLoad): string {
  const parts = [
    `${load.concurrent} verify run${load.concurrent === 1 ? "" : "s"} at once (limit ${load.limit})`,
    `load ${load.load1.toFixed(1)} across ${load.cores} cores`,
    `ran ${Math.round(load.run_ms / 1000)}s`,
  ];
  if (load.queued_ms > 0) parts.push(`queued ${Math.round(load.queued_ms / 1000)}s`);
  if (load.bypassed_queue) parts.push("ran without waiting for a free slot");
  return parts.join(", ");
}

function execVerify(
  cmd: string,
  cwd: string,
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      "sh",
      ["-c", cmd],
      {
        cwd,
        env: verifyEnv(),
        timeout: VERIFY_TIMEOUT_MS,
        maxBuffer: VERIFY_MAX_BUFFER,
      },
      (err, stdout, stderr) => {
        resolve({ ok: !err, output: `${stdout}\n${stderr}`.trim() });
      },
    );
  });
}

/** Run a task's verify_cmd, at most `verify_concurrency` at a time across the
 *  whole daemon. Shared by the Stop-hook transition (hooks.ts) and the freshen
 *  pass (freshen.ts) so both spawn with the same filtered env and both queue
 *  against each other. */
export async function runVerifyCommand(
  cmd: string,
  cwd: string,
  opts: RunVerifyOptions = {},
): Promise<VerifyResult> {
  const { slot, queuedMs, bypassed } = await acquire(opts.onQueued);
  const startedAt = Date.now();
  try {
    opts.onStart?.();
    const { ok, output } = await execVerify(cmd, cwd);
    return {
      ok,
      output,
      load: {
        concurrent: slot.peak,
        limit: verifyConcurrencyLimit(),
        queued_ms: queuedMs,
        run_ms: Date.now() - startedAt,
        load1: os.loadavg()[0],
        cores: os.cpus().length || 1,
        bypassed_queue: bypassed,
      },
    };
  } finally {
    release(slot);
  }
}
