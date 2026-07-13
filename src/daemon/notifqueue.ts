import { getAgent, listAgents, type Agent } from "../db/agents.js";
import { logEvent } from "../db/events.js";
import { getSchedulerConfig } from "../db/settings.js";
import {
  clearQueuedNotifications,
  enqueueNotification,
  listQueuedNotifications,
  type QueuedNotification,
} from "../db/notifications.js";
import { notify } from "./notify.js";
import { parsePane } from "./pane.js";
import { resumeAgent } from "./resume.js";
import { capturePane, windowExists } from "./tmux.js";

const PANE_TAIL_LINES = 60;

/**
 * Orchestrator "worker aN is waiting for input" notifications are injected
 * into the MAIN agent's tmux prompt. Doing that while the human is mid-typing
 * there merges the injected text into their draft, and doing it mid-turn is
 * likewise unwanted. This module gates delivery on the main's prompt being
 * genuinely idle-and-empty, queuing otherwise and flushing (batched) when the
 * main next goes idle with a clear prompt.
 *
 * Queuing NEVER touches the waiting worker's state or its hook.notification
 * timestamp, so the scheduler's escalate-to-human page (scheduler.ts watchdog)
 * still fires on time regardless — the page goes to the human's phone, not the
 * prompt, so it is unaffected by any of this.
 */

/** In-memory retry backoff for flushes deferred because the human was typing.
 *  Losing it on restart is harmless — the queued rows persist and the watchdog
 *  simply retries fresh. */
const flushBackoff = new Map<number, { until: number; step: number }>();
const BACKOFF_STEPS_MS = [15_000, 30_000, 60_000, 120_000, 300_000];

/** Test-only: backoff is process-global but agent ids reset per in-memory db. */
export function __clearFlushBackoffForTests(): void {
  flushBackoff.clear();
}

function bumpBackoff(mainId: number, nowMs: number): void {
  const step = Math.min(flushBackoff.get(mainId)?.step ?? 0, BACKOFF_STEPS_MS.length - 1);
  flushBackoff.set(mainId, { until: nowMs + BACKOFF_STEPS_MS[step], step: step + 1 });
}

function label(it: { worker_id: number | null; task_id: number | null }): string {
  return `a${it.worker_id}${it.task_id != null ? ` (task #${it.task_id})` : ""}`;
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * The message injected into the main agent. One queued item reproduces the
 * per-worker delegation prompt; several are batched into a single message so
 * the main is pinged once, not machine-gunned.
 */
export function buildDelegateMessage(
  items: Pick<QueuedNotification, "worker_id" | "task_id" | "message">[],
  escalateMinutes: number,
): string {
  if (items.length === 1) {
    const it = items[0];
    return `[commandcenter] ${label(it)} is waiting for input: "${it.message}". peek_worker(${it.worker_id}) to see exactly what it's asking, then try to unblock it yourself via send_to_worker (for a numbered menu send just the digit). Escalate to the human ONLY if it genuinely needs them: credentials, a judgment call that's theirs, or approval for something destructive/outside the worktree. If unresolved after ${escalateMinutes}m the human is paged automatically.`;
  }
  const list = items.map((it) => `${label(it)}: "${clip(it.message, 100)}"`).join("; ");
  return `[commandcenter] ${items.length} workers are waiting for input — ${list}. peek_worker(<id>) each to see what it's asking, then unblock what you can via send_to_worker (for a numbered menu send just the digit). Escalate to the human ONLY for genuine human calls: credentials, a judgment call that's theirs, or approval for something destructive/outside the worktree. Each is paged automatically if unresolved within ${escalateMinutes}m.`;
}

/**
 * True only when the main's composer is safe to inject into: no unsubmitted
 * human draft and no pending permission menu. Capturing the pane is the only
 * way to see a draft the human is mid-typing — agent.state alone can't. A
 * capture failure is treated as "not clear" (fail closed toward queuing).
 */
export function mainPromptClear(target: string): boolean {
  try {
    const pane = parsePane(capturePane(target, PANE_TAIL_LINES));
    return pane.unsubmitted_input === null && pane.pending_permission === null;
  } catch {
    return false;
  }
}

/** Find the one live main agent with a tmux window, whatever its state. */
function liveMain(): Agent | undefined {
  return listAgents({ live: true }).find(
    (a) => a.kind === "main" && a.tmux_target !== null && windowExists(a.tmux_target),
  );
}

/**
 * Route a waiting-worker notification to the main agent: deliver immediately
 * only when the main is idle with a clear prompt, otherwise queue it. With no
 * live main at all, fall back to paging the human directly (unchanged
 * behavior — there is no orchestrator to hand it to).
 */
export async function delegateToMain(worker: Agent, message: string): Promise<void> {
  const main = liveMain();
  const who = label({ worker_id: worker.id, task_id: worker.task_id });

  if (!main || !main.tmux_target) {
    notify(`${who} needs input`, message, { priority: "high", tags: "warning" });
    return;
  }

  const item = { worker_id: worker.id, task_id: worker.task_id, message };

  if (main.state === "idle" && mainPromptClear(main.tmux_target)) {
    const outcome = await resumeAgent(
      main.id,
      buildDelegateMessage([item], getSchedulerConfig().escalate_minutes),
    );
    if (outcome === "sent") {
      logEvent("waiting.delegated", {
        agentId: worker.id,
        taskId: worker.task_id ?? undefined,
        payload: { to: main.id, message },
      });
      return;
    }
    // Raced — the main started a turn or went waiting between the check and
    // the send. Fall through and queue instead of clobbering.
  }

  enqueueNotification({
    mainId: main.id,
    workerId: worker.id,
    taskId: worker.task_id ?? undefined,
    message,
  });
  logEvent("notification.queued", {
    agentId: worker.id,
    taskId: worker.task_id ?? undefined,
    payload: { to: main.id, main_state: main.state },
  });
}

export type FlushResult = "flushed" | "deferred" | "empty" | "not_live";

/**
 * Attempt to flush a main agent's queued notifications as one batched message.
 * Re-checks the prompt immediately before sending (the human may have started
 * typing again since the trigger) and, on a busy prompt or failed send, leaves
 * the queue intact and backs off for the watchdog to retry. Stale entries —
 * workers no longer actually waiting — are dropped rather than delivered.
 *
 * `force` (the Stop-hook path) bypasses the backoff gate; the watchdog path
 * passes `nowMs` and respects it.
 */
export async function flushMainQueue(
  mainId: number,
  opts: { force?: boolean; nowMs?: number } = {},
): Promise<FlushResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const backoff = flushBackoff.get(mainId);
  if (!opts.force && backoff && nowMs < backoff.until) return "deferred";

  const queued = listQueuedNotifications(mainId);
  if (queued.length === 0) {
    flushBackoff.delete(mainId);
    return "empty";
  }

  // Drop entries whose worker is no longer waiting (rescued, done, or gone) —
  // pinging the main about a resolved worker is noise.
  const stale: number[] = [];
  const items = queued.filter((it) => {
    if (it.worker_id == null) return true;
    const w = getAgent(it.worker_id);
    if (w && w.state === "waiting_input") return true;
    stale.push(it.id);
    return false;
  });
  clearQueuedNotifications(stale);
  if (items.length === 0) {
    flushBackoff.delete(mainId);
    return "empty";
  }

  const main = getAgent(mainId);
  if (
    !main ||
    main.state === "dead" ||
    !main.tmux_target ||
    !windowExists(main.tmux_target)
  ) {
    return "not_live";
  }

  if (!mainPromptClear(main.tmux_target)) {
    bumpBackoff(mainId, nowMs);
    return "deferred";
  }

  const message = buildDelegateMessage(items, getSchedulerConfig().escalate_minutes);
  const outcome = await resumeAgent(mainId, message);
  if (outcome !== "sent") {
    bumpBackoff(mainId, nowMs);
    return "deferred";
  }

  clearQueuedNotifications(items.map((it) => it.id));
  flushBackoff.delete(mainId);
  logEvent("notification.flushed", {
    agentId: mainId,
    payload: {
      count: items.length,
      workers: items.map((it) => it.worker_id).filter((w) => w != null),
    },
  });
  return "flushed";
}
