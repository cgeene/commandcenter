import { execFileSync } from "node:child_process";

/**
 * Process-tree teardown for reaped agent panes.
 *
 * `tmux kill-window` kills the pane's shell and hangs up its pty. That is not
 * enough: anything the agent backgrounded into its own process group — a load
 * generator, a watcher, a dev server, a `detached` child of the provider
 * process — keeps running, is reparented to pid 1, and is then invisible to
 * Command Center forever. A reviewer once leaked fourteen busy-loops this way
 * and held the machine at load 100+ for hours.
 *
 * So before the window goes away we take a `ps` snapshot, work out everything
 * that belongs to the pane, and signal the whole set.
 */

export interface ProcRow {
  pid: number;
  ppid: number;
  pgid: number;
  /** Controlling terminal as `ps` names it ("ttys012"), or "" when there is none. */
  tty: string;
  /** Seconds since the process started, from `ps etime`. */
  elapsedSec: number;
}

/** `ps` spellings for "no controlling terminal" (macOS uses ??, Linux ?). */
const NO_TTY = new Set(["??", "?", "-", ""]);

/** Grace between SIGTERM and SIGKILL. Overridable so tests don't sleep. */
function graceMs(): number {
  // A blank or whitespace-only value is "unset", not "zero grace" — Number("")
  // is 0, which would turn SIGTERM into an immediate SIGKILL.
  const configured = process.env.CC_REAP_GRACE_MS?.trim();
  if (!configured) return 3000;
  const raw = Number(configured);
  return Number.isFinite(raw) && raw >= 0 ? raw : 3000;
}

/**
 * Elapsed time as `ps` prints it: `MM:SS`, `HH:MM:SS`, or `DD-HH:MM:SS`.
 * Unparseable input yields Infinity — for the age guard that means "too old to
 * be ours", which is the safe direction.
 */
export function parseElapsed(text: string): number {
  const [days, clock] = text.includes("-")
    ? [Number(text.slice(0, text.indexOf("-"))), text.slice(text.indexOf("-") + 1)]
    : [0, text];
  const parts = clock.split(":").map(Number);
  if (!Number.isFinite(days) || parts.length < 2 || parts.length > 3) return Infinity;
  if (parts.some((n) => !Number.isFinite(n))) return Infinity;
  const [h, m, s] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
  return days * 86400 + h * 3600 + m * 60 + s;
}

/** Normalize a tmux `#{pane_tty}` ("/dev/ttys012") to the `ps` spelling. */
export function normalizeTty(tty: string): string {
  const name = tty.trim().replace(/^\/dev\//, "");
  return NO_TTY.has(name) ? "" : name;
}

export function parseProcessTable(text: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 5) continue; // header, blank, or a shape we don't know
    const [pid, ppid, pgid, tty, etime] = fields;
    const row: ProcRow = {
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pgid),
      tty: normalizeTty(tty),
      elapsedSec: parseElapsed(etime),
    };
    if (!Number.isInteger(row.pid) || !Number.isInteger(row.ppid)) continue;
    if (!Number.isInteger(row.pgid)) continue;
    rows.push(row);
  }
  return rows;
}

export function snapshotProcesses(): ProcRow[] {
  try {
    return parseProcessTable(
      execFileSync("ps", ["-Ao", "pid=,ppid=,pgid=,tty=,etime="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 16 * 1024 * 1024,
      }),
    );
  } catch {
    // No snapshot means no kill list. Falling back to "kill nothing extra" is
    // the only safe failure mode; the window teardown still happens.
    return [];
  }
}

/**
 * The daemon itself and every process it descends from. These must never end
 * up in a kill list, however the tree walk reaches them.
 */
export function selfAncestry(procs: ProcRow[], startPid = process.pid): Set<number> {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const out = new Set<number>();
  let cur: number | undefined = startPid;
  while (cur !== undefined && cur > 1 && !out.has(cur)) {
    out.add(cur);
    cur = byPid.get(cur)?.ppid;
  }
  return out;
}

/**
 * Everything reachable from `seeds` that belongs to the same pane.
 *
 * Two expansions, applied to fixpoint:
 *   - children, transitively — catches a child that called setsid() and so has
 *     its own process group and no tty, as long as its parent is still alive
 *     (which it is, because we snapshot before killing the window);
 *   - process-group siblings — a pgid is system-wide unique to its leader, so
 *     if one member is ours the whole group is ours. This catches a job the
 *     interactive shell put in its own group, and it keeps working after the
 *     members are reparented to pid 1.
 *
 * `protectedPids` is subtracted at every step, and any process group that a
 * protected process belongs to is never expanded — so the walk can't hop from
 * the pane into the daemon's own group.
 */
export function collectProcessTree(
  seeds: readonly ProcRow[],
  procs: readonly ProcRow[],
  protectedPids: ReadonlySet<number>,
): ProcRow[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const children = new Map<number, ProcRow[]>();
  const byPgid = new Map<number, ProcRow[]>();
  for (const p of procs) {
    const siblings = children.get(p.ppid);
    if (siblings) siblings.push(p);
    else children.set(p.ppid, [p]);
    const group = byPgid.get(p.pgid);
    if (group) group.push(p);
    else byPgid.set(p.pgid, [p]);
  }

  const protectedPgids = new Set<number>();
  for (const pid of protectedPids) {
    const row = byPid.get(pid);
    if (row) protectedPgids.add(row.pgid);
  }

  const selected = new Map<number, ProcRow>();
  const queue: ProcRow[] = [];
  const add = (p: ProcRow | undefined): void => {
    if (!p || p.pid <= 1) return;
    if (protectedPids.has(p.pid) || selected.has(p.pid)) return;
    selected.set(p.pid, p);
    queue.push(p);
  };

  for (const seed of seeds) add(byPid.get(seed.pid) ?? seed);
  while (queue.length > 0) {
    const cur = queue.pop()!;
    for (const child of children.get(cur.pid) ?? []) add(child);
    if (!protectedPgids.has(cur.pgid)) {
      for (const sibling of byPgid.get(cur.pgid) ?? []) add(sibling);
    }
  }
  return [...selected.values()];
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // Already gone, or not ours to signal. Either way there is nothing to do.
  }
}

/**
 * SIGKILL whatever is still standing after the grace period. A pid is only
 * killed if it is still present AND still in the process group we recorded —
 * cheap insurance against signalling an unrelated process that happened to
 * reuse the pid.
 *
 * Rechecking recorded pids is all this can usefully do; do not grow it into a
 * re-walk hoping to catch what the original snapshot missed. Measured on the
 * escaped-descendant case: by the time the grace period expires, none of the
 * recorded pids are in the `ps` table any more and the escaped group has been
 * reparented to pid 1 — so a re-walk from here has no live seed to start from
 * and provably reaches nothing new. `killWindow` makes this strictly worse by
 * killing the window immediately, without waiting out the grace.
 */
export function escalateSurvivors(tree: readonly ProcRow[]): number[] {
  if (tree.length === 0) return [];
  const fresh = new Map(snapshotProcesses().map((p) => [p.pid, p]));
  const killed: number[] = [];
  for (const p of tree) {
    const current = fresh.get(p.pid);
    if (!current || current.pgid !== p.pgid) continue;
    signal(p.pid, "SIGKILL");
    killed.push(p.pid);
  }
  return killed;
}

/**
 * Escalations still waiting out their grace period. Held so a daemon shutdown
 * inside the grace window doesn't strand a SIGTERM-ignoring child forever —
 * the very outcome this module exists to prevent.
 */
const pendingEscalations = new Map<NodeJS.Timeout, readonly ProcRow[]>();
let shutdownHooked = false;

/** SIGKILL every pending escalation now, instead of waiting out its timer. */
export function flushPendingEscalations(): number[] {
  const killed: number[] = [];
  for (const [timer, tree] of pendingEscalations) {
    clearTimeout(timer);
    killed.push(...escalateSurvivors(tree));
  }
  pendingEscalations.clear();
  return killed;
}

/**
 * Flush on the way out. The signal handlers are installed only while something
 * is pending and re-raise the signal afterwards, so the daemon's default
 * termination behavior is unchanged.
 */
function hookShutdownFlush(): void {
  if (shutdownHooked) return;
  shutdownHooked = true;
  process.on("exit", () => {
    flushPendingEscalations();
  });
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    // Remove only this handler before re-raising — removeAllListeners would
    // silently disable anyone else's shutdown handler (including vitest's).
    const handler = (): void => {
      flushPendingEscalations();
      process.off(sig, handler);
      process.kill(process.pid, sig);
    };
    process.on(sig, handler);
  }
}

function scheduleEscalation(tree: readonly ProcRow[]): void {
  if (tree.length === 0) return;
  hookShutdownFlush();
  const timer = setTimeout(() => {
    pendingEscalations.delete(timer);
    escalateSurvivors(tree);
  }, graceMs());
  // Never hold the daemon (or a test run) open waiting on the escalation.
  timer.unref?.();
  pendingEscalations.set(timer, tree);
}

export interface PaneProcess {
  /** The pane's shell pid (tmux `#{pane_pid}`). */
  pid: number;
  /** The pane's tty in `ps` spelling, or "" when unknown. */
  tty: string;
}

/**
 * SIGTERM everything that belonged to a live pane as of the snapshot, and
 * schedule a SIGKILL sweep of whatever ignores it. Call this while the pane is
 * still alive — the parent links it walks disappear the moment the pane shell
 * exits.
 *
 * Snapshot-then-signal, and it never re-walks, so one gap remains: a descendant
 * forked into a NEW process group after the snapshot is in neither the SIGTERM
 * set nor `escalateSurvivors`' recheck (that only revisits recorded pids), and
 * having left the session it misses the pty hangup `kill-window` delivers too.
 * Measured on macOS: a pane spawning a `detached` child from inside its own
 * SIGTERM handler left four processes alive in a group that did not exist when
 * the snapshot was taken, surviving the escalation and an explicit
 * `flushPendingEscalations()`.
 *
 * Deliberately not closed. Reaching such a child means re-walking while the
 * pane is still alive — before `kill-window`, on every reap path — and a `ps`
 * snapshot costs ~470ms on this machine (~950 processes), so each extra pass
 * adds about half a second to every teardown.
 *
 * What makes that price not worth paying is that the window needs a process
 * which spawns during its own SIGTERM handling, and neither provider does.
 * Measured by SIGTERMing both real CLIs mid-response, run interactively on a
 * pty as a pane runs them, and watching the process table across the whole
 * teardown: zero processes appeared in either tree after the signal. `claude`
 * does install a SIGTERM handler, but it only logs, emits one telemetry event
 * and exits 143; `codex` dies on the default disposition (signal 15), so it has
 * no handler that could spawn at all. A non-setsid'd child spawned in that
 * window is still killed by the pty hangup regardless. Revisit if a provider
 * gains a shutdown hook, or if hooks are ever configured to run on session end
 * — Command Center registers SessionStart/Stop/Notification only, none of which
 * fire on the way down.
 *
 * Returns the pids that were signalled.
 */
export function terminatePaneTree(pane: PaneProcess): number[] {
  const procs = snapshotProcesses();
  const paneRow = procs.find((p) => p.pid === pane.pid);
  if (!paneRow) return [];

  const protectedPids = selfAncestry(procs);
  // The tmux server is the pane's parent, not its child, so the walk never
  // reaches it — but it is catastrophic to kill, so say so explicitly.
  protectedPids.add(paneRow.ppid);

  const seeds = [paneRow];
  if (pane.tty) {
    // Strays already reparented to pid 1 keep the pane's controlling terminal,
    // which is exclusive to this pane. The pgid expansion above cannot find
    // them (their parent chain is gone), the tty can.
    for (const p of procs) if (p.tty === pane.tty) seeds.push(p);
  }

  const tree = collectProcessTree(seeds, procs, protectedPids);
  for (const p of tree) signal(p.pid, "SIGTERM");
  scheduleEscalation(tree);
  return tree.map((p) => p.pid);
}

/**
 * Members of `panePid`'s process group that plausibly belong to that pane.
 *
 * Pids are reused, so a pid that once identified a pane can later name an
 * unrelated process group. The age check is what separates the two: nothing in
 * the pane's group can have started before the pane itself, so a group that
 * predates the agent is somebody else's and is left alone. A minute of slack
 * covers the gap between `spawned_at` and the pane actually starting, plus
 * `etime`'s one-second granularity.
 */
export function vanishedPaneSeeds(
  panePid: number,
  paneAgeSec: number,
  procs: readonly ProcRow[],
  protectedPids: ReadonlySet<number>,
): ProcRow[] {
  const maxAgeSec = paneAgeSec + 60;
  return procs.filter(
    (p) => p.pgid === panePid && !protectedPids.has(p.pid) && p.elapsedSec <= maxAgeSec,
  );
}

export type PaneSweepOutcome =
  /** Found leftovers in the recorded group and signalled them, along with
   *  everything reachable from them. The handle has been acted on and is spent. */
  | "swept"
  /** The recorded group held nothing this sweep was allowed to kill, and
   *  nothing further can be learned from this handle — see
   *  `sweepVanishedPaneGroup` for why this is NOT the same as "the pane left
   *  nothing running". The handle is spent either way: a later sweep of the
   *  same pid can only reach the same empty group, so callers should clear it,
   *  but they must not report the pane as confirmed stopped. */
  | "unreachable"
  /** There was no usable handle to look with in the first place, so this is not
   *  a blind reap — it is a reap that never began. Kept distinct from
   *  "unreachable" so that token stays a specific signal: an agent whose
   *  pane pid was never recorded properly is a different problem from a pane
   *  whose descendants escaped the handle. Callers treat it the same way. */
  | "no_handle"
  /** Could not look, or the pane is demonstrably still alive. Nothing was
   *  done and the caller must KEEP the recorded pane pid — it is still the
   *  only handle on this pane, and a later sweep can do better. */
  | "declined";

export interface PaneSweepResult {
  outcome: PaneSweepOutcome;
  /** pids signalled; empty unless `outcome` is "swept". */
  killed: number[];
}

/**
 * Last-resort cleanup for a pane whose process is already gone — a crashed
 * window, a pane corpse behind `remain-on-exit`, or a watchdog reap that
 * arrives after the fact. The parent chain and the tty are both unusable by
 * then; the pane's process group id is the only handle left, and it does
 * survive reparenting to pid 1.
 *
 * `panePid` doubles as that pgid because tmux makes each pane shell a session
 * and group leader. Pids get reused, so a candidate is only accepted if it
 * started no earlier than the pane did — `paneAgeSec` is how long ago the agent
 * was spawned.
 *
 * Reach, measured rather than assumed:
 *  - a leftover still in the pane's process group IS found. In practice that
 *    means one that ignores SIGHUP (`nohup`, or a handler), because the pty
 *    hangup already kills the rest of the group when the pane dies.
 *  - a leftover that called setsid() (a `detached` child, and anything under
 *    it) is NOT found: it left both the process group and the session, and
 *    once its parent is gone nothing on the system still links it to the pane.
 *    macOS offers no way back — `ps -E` will not read another process's
 *    environment, so an inherited marker cannot be matched either. Those are
 *    only reachable while the pane is alive, via terminatePaneTree, which is
 *    why every deliberate reap tears the tree down before the window goes —
 *    within that function's own snapshot limit, documented on it.
 *
 * So an empty result is NOT evidence of an empty pane, and this function must
 * never claim it is. Once the pane shell is gone there is no observation left
 * that distinguishes "the pane really left nothing behind" from "the pane left
 * a setsid'd tree that this handle cannot see" — measured: killing only the
 * pane of a shell whose `detached` child had backgrounded a keepalive loop left
 * four processes alive in the child's own group, and this sweep found none of
 * them. That is why the empty case reports "unreachable" rather than a clean
 * bill of health: callers may drop the spent handle, but a reap they could not
 * see must not be logged as a reap they performed.
 */
export function sweepVanishedPaneGroup(
  panePid: number,
  paneAgeSec: number,
): PaneSweepResult {
  // Not a usable handle in the first place — nothing to chase it with, so
  // nothing to keep and nothing that could have been confirmed.
  if (!Number.isInteger(panePid) || panePid <= 1) {
    return { outcome: "no_handle", killed: [] };
  }
  const procs = snapshotProcesses();
  // No snapshot means no observation at all. Unlike the empty-group case below
  // this one is retryable, so the handle is worth keeping.
  if (procs.length === 0) return { outcome: "declined", killed: [] };

  const paneRow = procs.find((p) => p.pid === panePid);
  // The pane shell is alive and still leads its group: the pane did not vanish
  // at all (a false vanish, or a reap racing a live pane). Leave it to the
  // live-pane path, and leave the recorded pid in place — clearing it here
  // would disarm the sweep for this agent's real death later on.
  if (paneRow && paneRow.pgid === panePid) return { outcome: "declined", killed: [] };

  const protectedPids = selfAncestry(procs);
  const seeds = vanishedPaneSeeds(panePid, paneAgeSec, procs, protectedPids);
  if (seeds.length === 0) return { outcome: "unreachable", killed: [] };

  const tree = collectProcessTree(seeds, procs, protectedPids);
  for (const p of tree) signal(p.pid, "SIGTERM");
  scheduleEscalation(tree);
  return { outcome: "swept", killed: tree.map((p) => p.pid) };
}
