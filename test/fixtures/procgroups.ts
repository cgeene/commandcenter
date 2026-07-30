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

/** The leak shape: a keepalive loop backgrounded out of a short-lived shell. */
export const KEEPALIVE_LOOP =
  `(i=0; while [ $i -lt ${KEEPALIVE_LOOP_SEC} ]; do i=$((i+1)); sleep 1; done) &` +
  ` sleep ${KEEPALIVE_LEADER_SEC}`;

/**
 * A node one-liner for a pane process that spawns {@link KEEPALIVE_LOOP} as a
 * `detached` child — its own session and process group, no tty — and then stays
 * up. Nothing but the parent link connects that child to the pane.
 */
export const DETACHED_KEEPALIVE_SOURCE = `require('node:child_process').spawn('/bin/sh',['-c',${JSON.stringify(
  KEEPALIVE_LOOP,
)}],{detached:true,stdio:'ignore'});setTimeout(()=>{},600000)`;

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
 * Waiting for the group's SECOND member is the point. The leader forks the
 * backgrounded loop a moment after it starts, and a snapshot taken in between
 * sees only the leader; cleaning up from that snapshot kills the leader and
 * strands the loop at pid 1 forever.
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
    if (cur.pgid === cur.pid && (groupSize.get(cur.pgid) ?? 0) >= 2) {
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
