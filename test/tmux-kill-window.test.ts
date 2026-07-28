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

// The whole file is real-process orchestration with fixed settling delays.
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

describe.skipIf(!tmuxAvailable)("killWindow tears down the pane's process tree", () => {
  beforeAll(() => {
    fs.mkdirSync(TMPDIR, { recursive: true });
    process.env.TMUX_TMPDIR = TMPDIR;
    process.env.CC_TMUX_SESSION = SESSION;
    delete process.env.TMUX; // don't let a surrounding tmux hijack the target
  });

  afterAll(() => {
    spawnSync("tmux", ["kill-server"], { stdio: "ignore" });
    fs.rmSync(TMPDIR, { recursive: true, force: true });
    delete process.env.CC_TMUX_SESSION;
    delete process.env.TMUX_TMPDIR;
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
    await new Promise((r) => setTimeout(r, 1500));

    const panePid = Number(
      tmux("display-message", "-p", "-t", target, "#{pane_pid}").trim(),
    );
    const strays = descendants(panePid);
    expect(strays.length).toBeGreaterThan(0);

    tmux("kill-window", "-t", target);
    await new Promise((r) => setTimeout(r, 800));
    const survivors = strays.filter(alive);
    expect(survivors.length).toBeGreaterThan(0);

    spawnSync("/bin/kill", ["-9", ...survivors.map(String)], { stdio: "ignore" });
    await waitForExit(survivors);
  });

  it("kills the whole tree when the daemon's killWindow tears the window down", async () => {
    const { newWindow, killWindow, paneProcess } = await import("../src/daemon/tmux.js");
    const target = newWindow("kwtest", "/tmp", leakyCommand);
    await new Promise((r) => setTimeout(r, 1500));

    const pane = paneProcess(target);
    expect(pane).not.toBeNull();
    const strays = descendants(pane!.pid);
    expect(strays.length).toBeGreaterThan(0);

    const killed = killWindow(target);
    expect(killed).toContain(pane!.pid);
    // Not an exact set comparison: the leaf `sleep` respawns every second, so
    // killWindow's own snapshot legitimately differs from the one above. What
    // must hold is that nothing observed before the reap is left running.
    expect(killed.length).toBeGreaterThanOrEqual(3);
    expect(await waitForExit([pane!.pid, ...strays])).toEqual([]);
  });

  it("reports no pane process for a window that is gone", async () => {
    // tmux resolves an unknown -t target to the session's *current* window
    // instead of failing, so without the resolved-id check this would hand back
    // a live, unrelated agent's pane pid and get that agent's tree killed.
    const { newWindow, paneProcess } = await import("../src/daemon/tmux.js");
    const bystander = newWindow("bystander", "/tmp", "sleep 600");
    await new Promise((r) => setTimeout(r, 500));
    const bystanderPane = paneProcess(bystander);
    expect(bystanderPane).not.toBeNull();

    expect(paneProcess(`${SESSION}:@99999`)).toBeNull();

    const { killWindow } = await import("../src/daemon/tmux.js");
    expect(killWindow(bystander)).toContain(bystanderPane!.pid);
  });

  it("reports no pane process for a pane whose command already exited", async () => {
    // A window held open by remain-on-exit keeps reporting the exited pid, and
    // that pid may since have been reused. It must never be acted on.
    const { newWindow, paneProcess, killWindow } = await import("../src/daemon/tmux.js");
    const target = newWindow("deadpane", "/tmp", "sleep 600");
    await new Promise((r) => setTimeout(r, 500));
    const pane = paneProcess(target)!;
    process.kill(pane.pid, "SIGKILL");
    await waitForExit([pane.pid]);
    await new Promise((r) => setTimeout(r, 300));

    expect(paneProcess(target)).toBeNull();
    expect(killWindow(target)).toEqual([]);
  });
});
