import { execFileSync } from "node:child_process";

/**
 * Test suites running on this box that the daemon did not start.
 *
 * The verify semaphore (verifyenv.ts) serializes the verify_cmd runs the daemon
 * itself spawns. It cannot see the other, larger half of the load: a worker or
 * reviewer that types `npm test` in its own tmux pane. Those never reach
 * runVerifyCommand, so a daemon verify can report `concurrent: 1` — "nothing
 * else was running" — while several agent-side suites saturate the machine.
 *
 * Measured on this box on 2026-07-29: 207 agent-run full suites against 33
 * daemon verify runs, and 9 of the 15 daemon runs that genuinely shared the box
 * with another suite would have been recorded as uncontended. Three of that
 * day's five daemon verify failures fell in that blind spot.
 *
 * The cure is observation, not a lock: agents cannot be made to queue, so this
 * module only counts, and the count rides along in VerifyLoad so a contended
 * failure stays attributable. Every failure path here yields "saw nothing",
 * which reads as an uncontended run — the same answer the daemon gave before
 * this existed.
 */

export interface CommandRow {
  pid: number;
  ppid: number;
  /** Process group. One `npm test` invocation and every worker it forks share
   *  one, which is what lets processes be collapsed back into suite runs. */
  pgid: number;
  /** argv as `ps` renders it. */
  command: string;
}

/** How wide a `ps` snapshot may be before it is abandoned. */
const PS_MAX_BUFFER = 16 * 1024 * 1024;

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/;

export function parseCommandTable(text: string): CommandRow[] {
  const rows: CommandRow[] = [];
  for (const line of text.split("\n")) {
    const m = PS_LINE.exec(line);
    if (!m) continue;
    const [, pid, ppid, pgid, command] = m;
    rows.push({
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pgid),
      command: command.trim(),
    });
  }
  return rows;
}

export function snapshotCommands(): CommandRow[] {
  try {
    return parseCommandTable(
      execFileSync("ps", ["-Ao", "pid=,ppid=,pgid=,args="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: PS_MAX_BUFFER,
      }),
    );
  } catch {
    return [];
  }
}

/** Package managers whose `test` script is conventionally the whole suite. */
const PACKAGE_MANAGERS = new Set(["npm", "yarn", "pnpm", "bun"]);

/** Test runners recognised when invoked as the program itself. */
const RUNNERS = new Set(["vitest", "jest", "mocha"]);

/**
 * Does this argv look like a test-suite run, as opposed to something that
 * merely mentions one?
 *
 * Every rule is anchored at argv[0], which is what keeps a `grep -rn vitest
 * src/` — or the long shell wrapper an agent's command arrives inside — from
 * being counted as a suite. Those wrappers need not match on their own account:
 * job control puts the real runner in the same process group, and the caller
 * groups by pgid.
 */
export function isTestRunnerCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  const argv0 = trimmed.split(/\s+/)[0];
  const base = argv0.slice(argv0.lastIndexOf("/") + 1);
  const rest = trimmed.slice(argv0.length).trim();

  // Vitest renames its processes to `node (vitest)` / `node (vitest 3)`; that
  // title is the only handle on a worker fork, whose real argv is gone.
  if (base === "node" && /^\(vitest\b/.test(rest)) return true;
  if (RUNNERS.has(base)) return true;
  if (PACKAGE_MANAGERS.has(base) && /^(run\s+)?tests?\b/.test(rest)) return true;
  if (base === "npx" && RUNNERS.has(rest.split(/\s+/)[0] ?? "")) return true;
  return false;
}

/** Every pid descended from `rootPid`, that pid included. */
function descendants(procs: readonly CommandRow[], rootPid: number): Set<number> {
  const children = new Map<number, number[]>();
  for (const p of procs) {
    const kids = children.get(p.ppid);
    if (kids) kids.push(p.pid);
    else children.set(p.ppid, [p.pid]);
  }
  const out = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    for (const kid of children.get(queue.pop()!) ?? []) {
      if (out.has(kid)) continue;
      out.add(kid);
      queue.push(kid);
    }
  }
  return out;
}

/**
 * How many distinct test-suite runs are in flight that `ownerPid` is not part
 * of and did not spawn.
 *
 * Counted in process groups rather than processes: one suite forks a worker per
 * core, and it is the number of competing suites that matters.
 *
 * Two exclusions, and both are load-bearing. Descendants cover the daemon's own
 * verify child, which is the run being measured. The owner's own process group
 * covers the case where the daemon is itself running inside a suite — under
 * `vitest` the whole tree shares one group, and those siblings are the caller's
 * own context, not competitors. In the real daemon that group holds nothing but
 * the daemon, so the second rule costs nothing; an agent's suite lives in its
 * own tmux session and group and is still counted.
 */
export function countExternalSuites(
  procs: readonly CommandRow[],
  ownerPid: number,
): number {
  const own = descendants(procs, ownerPid);
  const ownGroup = procs.find((p) => p.pid === ownerPid)?.pgid;
  const groups = new Set<number>();
  for (const p of procs) {
    if (own.has(p.pid)) continue;
    if (ownGroup !== undefined && p.pgid === ownGroup) continue;
    if (!isTestRunnerCommand(p.command)) continue;
    groups.add(p.pgid);
  }
  return groups.size;
}

/** Count concurrent suite runs on the box right now. 0 if `ps` is unreadable. */
export function observeExternalSuites(ownerPid: number = process.pid): number {
  const procs = snapshotCommands();
  if (procs.length === 0) return 0;
  return countExternalSuites(procs, ownerPid);
}
