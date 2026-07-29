import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { snapshotProcesses } from "../src/daemon/proctree.js";

// End-to-end proof of the bug this guards against: `tmux kill-window` alone
// leaves anything the pane backgrounded into its own process group running,
// orphaned to pid 1.
//
// It drives a real tmux server, so TMUX_TMPDIR is pointed at a scratch
// directory before anything touches tmux — that moves the default socket the
// daemon code uses, and the whole server is torn down afterwards. Nothing here
// can reach the operator's own tmux session.
const TMPDIR = `/tmp/cc-kw-${process.pid}`;
const SESSION = `cc-test-kw-${process.pid}`;

const tmuxAvailable = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

// The whole file is real-process orchestration: a generous ceiling, but every
// wait below is a polled precondition rather than a fixed delay, so the budget
// tracks machine load instead of being spent on every run.
vi.setConfig({ testTimeout: 60_000 });

function tmux(...args: string[]): string {
  return execFileSync("tmux", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitForExit(pids: number[], timeoutMs = 15_000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pids.some(alive)) return [];
    await new Promise((r) => setTimeout(r, 100));
  }
  return pids.filter(alive);
}

/**
 * Poll until `ready()` returns something truthy, then hand it back.
 *
 * How long tmux takes to start a pane, and how long that pane takes to fork its
 * own children, is unbounded and load-dependent. Every precondition here is
 * WAITED FOR rather than slept past — fixed settling delays are what made this
 * file both slow and load-fragile.
 */
async function waitFor<T>(
  ready: () => T | undefined,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = ready();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Descendants of `root` in a fresh snapshot, `root` itself excluded. */
function descendants(root: number): number[] {
  const children = new Map<number, number[]>();
  for (const p of snapshotProcesses()) {
    const list = children.get(p.ppid);
    if (list) list.push(p.pid);
    else children.set(p.ppid, [p.pid]);
  }
  const out = new Set<number>();
  const queue = [...(children.get(root) ?? [])];
  while (queue.length > 0) {
    const pid = queue.pop()!;
    if (out.has(pid)) continue;
    out.add(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return [...out];
}

// A pane process that backgrounds a detached child, which itself backgrounds a
// loop — the shape a worker produces with `(while :; do :; done) &` under a
// harness that runs commands in their own session.
const LEAKY = `require('node:child_process').spawn('/bin/sh',['-c','(while :; do sleep 1; done) & sleep 600'],{detached:true,stdio:'ignore'});setTimeout(()=>{},600000)`;
const leakyCommand = `${process.execPath} -e ${JSON.stringify(LEAKY)}`;

// A pane that leaves a job which ignores SIGHUP. Unlike the detached shape
// above, this one stays in the pane's process group — so it is still reachable
// after the pane's own process is gone, which is what the pane_pid fallback is
// for. (A same-group job that does NOT ignore SIGHUP dies with the pty, so this
// is the shape that actually survives a crashed agent.)
const NOHUP_LEAK = `/bin/sh -c 'nohup sleep 594 >/dev/null 2>&1 & exec sleep 595'`;

let dataDir: string;

describe.skipIf(!tmuxAvailable)("killWindow tears down the pane's process tree", () => {
  beforeAll(() => {
    fs.mkdirSync(TMPDIR, { recursive: true });
    process.env.TMUX_TMPDIR = TMPDIR;
    process.env.CC_TMUX_SESSION = SESSION;
    delete process.env.TMUX; // don't let a surrounding tmux hijack the target
    dataDir = fs.mkdtempSync("/tmp/cc-kw-db-");
    process.env.CC_DATA_DIR = dataDir;
  });

  afterAll(async () => {
    const { closeDb } = await import("../src/db/db.js");
    closeDb();
    spawnSync("tmux", ["kill-server"], { stdio: "ignore" });
    fs.rmSync(TMPDIR, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
    delete process.env.CC_TMUX_SESSION;
    delete process.env.TMUX_TMPDIR;
    delete process.env.CC_DATA_DIR;
  });

  it("reproduces the leak: a bare kill-window strands the background children", async () => {
    const { ensureSession } = await import("../src/daemon/tmux.js");
    ensureSession();
    const target = tmux(
      "new-window", "-d", "-t", SESSION,
      "-P", "-F", "#{session_name}:#{window_id}",
      "-c", "/tmp",
      leakyCommand,
    ).trim();
    const panePid = await waitFor(() => {
      const raw = tmux("display-message", "-p", "-t", target, "#{pane_pid}").trim();
      const pid = Number(raw);
      return Number.isInteger(pid) && pid > 1 ? pid : undefined;
    }, "tmux to report the pane pid");
    const strays = await waitFor(() => {
      const found = descendants(panePid);
      return found.length > 0 ? found : undefined;
    }, "the pane's background children to be forked");

    tmux("kill-window", "-t", target);
    // The pane's own process really is gone; what is left is the leak.
    expect(await waitForExit([panePid])).toEqual([]);
    const survivors = strays.filter(alive);
    expect(survivors.length).toBeGreaterThan(0);

    spawnSync("/bin/kill", ["-9", ...survivors.map(String)], { stdio: "ignore" });
    await waitForExit(survivors);
  });

  it("kills the whole tree when the daemon's killWindow tears the window down", async () => {
    const { newWindow, killWindow, paneProcess } = await import("../src/daemon/tmux.js");
    const target = newWindow("kwtest", "/tmp", leakyCommand);
    const pane = await waitFor(() => paneProcess(target) ?? undefined, "the pane to start");
    const strays = await waitFor(() => {
      const found = descendants(pane.pid);
      return found.length > 0 ? found : undefined;
    }, "the pane's background children to be forked");

    const killed = killWindow(target);
    expect(killed).toContain(pane.pid);
    // Not an exact set comparison: the leaf `sleep` respawns every second, so
    // killWindow's own snapshot legitimately differs from the one above. What
    // must hold is that nothing observed before the reap is left running.
    expect(killed.length).toBeGreaterThanOrEqual(3);
    expect(await waitForExit([pane.pid, ...strays])).toEqual([]);
  });

  it("reports no pane process for a window that is gone", async () => {
    // tmux resolves an unknown -t target to the session's *current* window
    // instead of failing, so without the resolved-id check this would hand back
    // a live, unrelated agent's pane pid and get that agent's tree killed.
    const { newWindow, paneProcess } = await import("../src/daemon/tmux.js");
    const bystander = newWindow("bystander", "/tmp", "sleep 600");
    const bystanderPane = await waitFor(
      () => paneProcess(bystander) ?? undefined,
      "the bystander pane to start",
    );

    expect(paneProcess(`${SESSION}:@99999`)).toBeNull();

    const { killWindow } = await import("../src/daemon/tmux.js");
    expect(killWindow(bystander)).toContain(bystanderPane.pid);
  });

  it("reports no pane process for a pane whose command already exited", async () => {
    // A window held open by remain-on-exit keeps reporting the exited pid, and
    // that pid may since have been reused. killWindow must never act on it —
    // cleanup for this case goes through the DB-recorded pane_pid instead (see
    // the killAgent test below).
    const { newWindow, paneProcess, killWindow } = await import("../src/daemon/tmux.js");
    const target = newWindow("deadpane", "/tmp", "sleep 600");
    const pane = await waitFor(() => paneProcess(target) ?? undefined, "the pane to start");
    process.kill(pane.pid, "SIGKILL");
    await waitForExit([pane.pid]);

    // tmux needs a moment to notice the pane's command exited.
    await waitFor(() => (paneProcess(target) === null ? true : undefined),
      "tmux to stop reporting a live pane process");
    expect(killWindow(target)).toEqual([]);
  });

  it("killAgent still kills leftovers when the pane died behind a surviving window", async () => {
    // The crash case: the agent's process is gone, remain-on-exit keeps the
    // window (so windowExists is true), and killWindow can do nothing because
    // the reported pane pid is stale. The pane_pid recorded at spawn is the
    // only handle left, and the reap must use it.
    const { newWindow, paneProcess, windowExists } = await import("../src/daemon/tmux.js");
    const { createAgent, updateAgent, getAgent } = await import("../src/db/agents.js");
    const { killAgent } = await import("../src/daemon/spawn.js");

    const target = newWindow("crashed", "/tmp", NOHUP_LEAK);
    const pane = await waitFor(() => paneProcess(target) ?? undefined, "the pane to start");
    const leftovers = await waitFor(() => {
      const found = snapshotProcesses()
        .filter((p) => p.pgid === pane.pid && p.pid !== pane.pid)
        .map((p) => p.pid);
      return found.length > 0 ? found : undefined;
    }, "the nohup'd job to be forked into the pane's group");

    const agent = createAgent({ kind: "worker", state: "working", tmux_target: target });
    updateAgent(agent.id, { pane_pid: pane.pid });

    // Crash the agent's own process; its nohup'd job keeps running.
    process.kill(pane.pid, "SIGKILL");
    await waitForExit([pane.pid]);
    await waitFor(() => (paneProcess(target) === null ? true : undefined),
      "tmux to stop reporting a live pane process");
    expect(windowExists(target)).toBe(true); // remain-on-exit corpse
    expect(leftovers.filter(alive).length).toBeGreaterThan(0);

    killAgent(agent.id);

    expect(await waitForExit(leftovers)).toEqual([]);
    // pane_pid is cleared once swept, so a repeat kill has nothing to chase.
    expect(getAgent(agent.id)?.pane_pid).toBeNull();
  });
});
