import { execFileSync, spawn, type ChildProcess } from "node:child_process";

/**
 * Process-group teardown for the fixtures that drive real processes.
 *
 * Those fixtures deliberately build the production leak shape: a detached
 * `/bin/sh` leads its own process group and backgrounds a keepalive loop inside
 * it. Killing the leader's pid does NOT reap that loop — it is reparented to
 * pid 1 and outlives its leader. Only a process-GROUP kill reaches it.
 *
 * So every group a fixture creates is registered here and torn down as a group
 * in an `afterEach`, which still runs when the test above it failed or timed out
 * before its own cleanup. Cleaning up on the happy path only is what left 130
 * of these loops running on the development machine.
 *
 * That teardown cannot cover a runner that is SIGKILLed or SIGTERMed outright —
 * a reaped agent pane, or a daemon restart, which kills an in-flight verify
 * because the verify child shares the daemon's process group. No `afterEach`
 * and no `process.on("exit")` hook runs on those signals, so the second line of
 * defence is that nothing spawned here may outlive its own bound.
 */

/**
 * Lifetime bounds for the leak shape.
 *
 * The loop MUST outlive its leader: every test built on this fixture depends on
 * the backgrounded loop still running once the leader's pid is gone, which is
 * what makes a pid-list cleanup strand it. Lowering the loop below the leader
 * inverts that and the strandable window silently disappears.
 */
export const KEEPALIVE_LEADER_SEC = 600;
export const KEEPALIVE_LOOP_SEC = 900;

/**
 * The leak shape: a keepalive loop backgrounded out of a short-lived shell.
 *
 * Parameterised so a test can assert the bound behaviourally on a short one
 * rather than waiting out the real 900s.
 */
export function keepaliveLoop(loopSec: number, leaderSec: number): string {
  return (
    `(i=0; while [ $i -lt ${loopSec} ]; do i=$((i+1)); sleep 1; done) &` +
    ` sleep ${leaderSec}`
  );
}

export const KEEPALIVE_LOOP = keepaliveLoop(
  KEEPALIVE_LOOP_SEC,
  KEEPALIVE_LEADER_SEC,
);

/**
 * Quote `text` so a POSIX shell passes it through verbatim.
 *
 * `JSON.stringify` is NOT a substitute here, and using it silently corrupted
 * this fixture once: it produces DOUBLE quotes, inside which a shell still
 * expands `$i` and `$((i+1))`, so the loop reached the far side as
 * `while [  -lt 900 ]` and died on a syntax error in about 18ms. The group then
 * still had two members (leader plus `sleep ${KEEPALIVE_LEADER_SEC}`) and so
 * still looked healthy to a naive occupancy check, while proving nothing.
 */
export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * A `node -e <source>` command line safe to hand to a shell — which is what
 * tmux does with a pane command. Always build it through here rather than
 * interpolating a source string directly; see {@link shellQuote}.
 */
export function nodeEvalCommand(source: string): string {
  return `${process.execPath} -e ${shellQuote(source)}`;
}

/**
 * A node one-liner for a pane process that spawns {@link KEEPALIVE_LOOP} as a
 * `detached` child — its own session and process group, no tty — and then stays
 * up. Nothing but the parent link connects that child to the pane.
 *
 * Pass this to a SHELL only via {@link shellQuote}; as argv it needs no quoting.
 */
export const DETACHED_KEEPALIVE_SOURCE = `require('node:child_process').spawn('/bin/sh',['-c',${JSON.stringify(
  KEEPALIVE_LOOP,
)}],{detached:true,stdio:'ignore'});setTimeout(()=>{},${KEEPALIVE_LEADER_SEC * 1000})`;

interface Row {
  pid: number;
  ppid: number;
  pgid: number;
}

/**
 * Deliberately its own `ps` reader rather than `snapshotProcesses()` from the
 * daemon: teardown has to work even when the module under test is the thing
 * that is broken.
 */
function snapshot(): Row[] {
  try {
    return execFileSync("ps", ["-Ao", "pid=,ppid=,pgid="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    })
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((fields) => fields.length === 3)
      .map((fields) => ({
        pid: Number(fields[0]),
        ppid: Number(fields[1]),
        pgid: Number(fields[2]),
      }))
      .filter((r) => Number.isInteger(r.pid) && Number.isInteger(r.pgid));
  } catch {
    return [];
  }
}

const tracked = new Set<number>();
let selfGroup: number | undefined;
let exitHooked = false;

/** This process's own group. A group kill on it would take the test runner down. */
function ownGroup(): number {
  if (selfGroup === undefined) {
    selfGroup = snapshot().find((r) => r.pid === process.pid)?.pgid ?? 0;
  }
  return selfGroup;
}

/** Register a process group for the group kill in {@link killTrackedGroups}. */
export function trackProcessGroup(pgid: number): void {
  if (!Number.isInteger(pgid) || pgid <= 1) return;
  if (pgid === ownGroup()) return;
  tracked.add(pgid);
  if (!exitHooked) {
    exitHooked = true;
    // Backstop for a worker that exits without running `afterEach` at all.
    process.on("exit", () => {
      killTrackedGroups();
    });
  }
}

/** Register the process groups that `pids` belong to. */
export function trackGroupsOf(pids: readonly number[]): void {
  if (pids.length === 0) return;
  const wanted = new Set(pids);
  for (const r of snapshot()) if (wanted.has(r.pid)) trackProcessGroup(r.pgid);
}

/** Live members of process group `pgid`. */
export function groupMembers(pgid: number): number[] {
  return snapshot()
    .filter((r) => r.pgid === pgid)
    .map((r) => r.pid);
}

/**
 * True once group `pgid` contains a grandchild of its leader — the `sleep` the
 * backgrounded loop re-forks on every iteration.
 *
 * Occupancy alone cannot distinguish a running loop from a loop that died on a
 * syntax error, because the leader's own foreground `sleep` keeps the count up
 * either way. Only the loop produces a member whose parent is another member,
 * so this is what proves the loop is actually iterating. Matching on the args
 * string instead would be flaky: `ps` renders the child as `(sleep)` while it is
 * still being exec'd.
 */
export function keepaliveLoopIsRunning(pgid: number): boolean {
  const group = snapshot().filter((r) => r.pgid === pgid);
  const pids = new Set(group.map((r) => r.pid));
  return group.some((r) => r.ppid !== pgid && pids.has(r.ppid));
}

/**
 * Spawn {@link KEEPALIVE_LOOP} as its own detached process group and register
 * it. The returned child's pid is also the group id.
 */
export function spawnKeepaliveGroup(): ChildProcess {
  const leader = spawn("/bin/sh", ["-c", KEEPALIVE_LOOP], {
    detached: true,
    stdio: "ignore",
  });
  leader.unref();
  trackProcessGroup(leader.pid!);
  return leader;
}

/**
 * The keepalive group somewhere below `rootPid`, registered for teardown — or
 * undefined while the shape is still incomplete, so this composes with the
 * polling `waitFor` helpers in the test files.
 *
 * Waiting for the group's THIRD member is the point. The leader forks the
 * backgrounded loop a moment after it starts, and a snapshot taken in between
 * sees only the leader; cleaning up from that snapshot kills the leader and
 * strands the loop at pid 1 forever.
 *
 * Three, not two: the leader plus its foreground `sleep` already make two even
 * when the backgrounded loop never started — which is exactly what a shell that
 * ate the loop's `$i` leaves behind. Accepting two let a corrupted fixture look
 * healthy while proving nothing.
 */
export function trackKeepaliveGroupUnder(rootPid: number): number | undefined {
  const procs = snapshot();
  const byParent = new Map<number, Row[]>();
  const groupSize = new Map<number, number>();
  for (const r of procs) {
    const kids = byParent.get(r.ppid);
    if (kids) kids.push(r);
    else byParent.set(r.ppid, [r]);
    groupSize.set(r.pgid, (groupSize.get(r.pgid) ?? 0) + 1);
  }

  const seen = new Set<number>();
  const queue = [...(byParent.get(rootPid) ?? [])];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    if (seen.has(cur.pid)) continue;
    seen.add(cur.pid);
    queue.push(...(byParent.get(cur.pid) ?? []));
    // The detached leader: its own group, with the loop already forked into it.
    if (cur.pgid === cur.pid && (groupSize.get(cur.pgid) ?? 0) >= 3) {
      trackProcessGroup(cur.pgid);
      return cur.pgid;
    }
  }
  return undefined;
}

/**
 * SIGKILL every registered group and forget them. Addressing the group rather
 * than its leader is what makes this work: it reaches members already
 * reparented to pid 1, and it keeps working once the leader itself is gone.
 */
export function killTrackedGroups(): number[] {
  const killed: number[] = [];
  for (const pgid of tracked) {
    try {
      process.kill(-pgid, "SIGKILL");
      killed.push(pgid);
    } catch {
      // The group is already empty.
    }
  }
  tracked.clear();
  return killed;
}
