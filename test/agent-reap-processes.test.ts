import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Every reap path — cancel, kill_worker, reviewer auto-reap, the watchdog's
// early/terminal reap — funnels through killAgent. These tests pin that it
// tears down the pane's processes, not just its tmux window.
const killWindow = vi.fn((_target: string) => [4001, 4002]);
const windowExists = vi.fn((_target: string) => true);

vi.mock("../src/daemon/tmux.js", () => ({
  killWindow: (target: string) => killWindow(target),
  windowExists: (target: string) => windowExists(target),
  newWindow: vi.fn(),
  paneProcess: () => null,
  capturePane: () => "",
  clearInputLine: () => {},
  sendText: async () => {},
  sendEnter: () => {},
}));

const sweepVanishedPaneGroup = vi.fn((_pgid: number, _ageSec: number) => ({
  outcome: "swept" as const,
  killed: [5001],
}));
vi.mock("../src/daemon/proctree.js", () => ({
  sweepVanishedPaneGroup: (pgid: number, ageSec: number) =>
    sweepVanishedPaneGroup(pgid, ageSec),
}));

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-reapproc-"));
  process.env.CC_DATA_DIR = tmpDir;
  killWindow.mockClear();
  windowExists.mockClear();
  windowExists.mockReturnValue(true);
  sweepVanishedPaneGroup.mockClear();
  sweepVanishedPaneGroup.mockReturnValue({ outcome: "swept", killed: [5001] });
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("killAgent process teardown", () => {
  it("tears down the pane's process tree for a live window", async () => {
    const { killAgent } = await import("../src/daemon/spawn.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    const worker = createAgent({
      kind: "worker",
      state: "working",
      tmux_target: "cc:@4",
    });

    killAgent(worker.id);

    expect(killWindow).toHaveBeenCalledWith("cc:@4");
    expect(sweepVanishedPaneGroup).not.toHaveBeenCalled();
    const killedEvent = listEvents(50).find((e) => e.kind === "agent.killed");
    // The pid list, not a count — a count is not chaseable in a postmortem.
    expect(JSON.parse(killedEvent!.payload!).killed_pids).toEqual([4001, 4002]);
  });

  it("falls back to the pane group when the window survives but its pane is dead", async () => {
    // remain-on-exit keeps the window (windowExists true), but the pane process
    // already exited, so killWindow finds nothing to signal. The recorded
    // pane_pid must still be used — otherwise a crashed agent's leftovers get
    // no cleanup at all.
    const { killAgent } = await import("../src/daemon/spawn.js");
    const { createAgent, updateAgent, getAgent } = await import("../src/db/agents.js");
    const worker = createAgent({
      kind: "worker",
      state: "working",
      tmux_target: "cc:@4",
    });
    updateAgent(worker.id, { pane_pid: 9182 });
    killWindow.mockReturnValueOnce([]); // dead pane behind a live window

    killAgent(worker.id);

    expect(killWindow).toHaveBeenCalledWith("cc:@4");
    expect(sweepVanishedPaneGroup).toHaveBeenCalledTimes(1);
    expect(sweepVanishedPaneGroup.mock.calls[0][0]).toBe(9182);
    expect(getAgent(worker.id)?.pane_pid).toBeNull();
    const { listEvents } = await import("../src/db/events.js");
    const killedEvent = listEvents(50).find((e) => e.kind === "agent.killed");
    expect(JSON.parse(killedEvent!.payload!).pane_sweep).toBe("swept");
  });

  it("records an unreachable sweep on agent.killed so a blind reap is not silent", async () => {
    // The whole point of the outcome: this teardown proved nothing, and the row
    // is about to give up its pane pid anyway. If the verdict is not written
    // down here, a reap that could not see the pane's processes is
    // indistinguishable from one that stopped them.
    const { killAgent } = await import("../src/daemon/spawn.js");
    const { createAgent, updateAgent, getAgent } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    const worker = createAgent({
      kind: "worker",
      state: "working",
      tmux_target: "cc:@4",
    });
    updateAgent(worker.id, { pane_pid: 9182 });
    windowExists.mockReturnValue(false);
    sweepVanishedPaneGroup.mockReturnValue({ outcome: "unreachable", killed: [] });

    killAgent(worker.id);

    const killedEvent = listEvents(50).find((e) => e.kind === "agent.killed");
    const payload = JSON.parse(killedEvent!.payload!);
    expect(payload.pane_sweep).toBe("unreachable");
    expect(payload.killed_pids).toEqual([]);
    // Recorded, and the spent handle still surrendered — the two go together.
    expect(getAgent(worker.id)?.pane_pid).toBeNull();
  });

  it("still sweeps an agent the watchdog already marked dead without sweeping it", async () => {
    // killAgent early-returns for a dead row with no live window. That must not
    // apply while pane_pid is still set: it means nothing ever tore the pane
    // down, and this is the last chance to.
    const { killAgent } = await import("../src/daemon/spawn.js");
    const { createAgent, updateAgent } = await import("../src/db/agents.js");
    const worker = createAgent({ kind: "worker", state: "working", tmux_target: "cc:@4" });
    updateAgent(worker.id, { state: "dead", pane_pid: 9182 });
    windowExists.mockReturnValue(false);

    killAgent(worker.id);

    expect(sweepVanishedPaneGroup).toHaveBeenCalledTimes(1);
    expect(sweepVanishedPaneGroup.mock.calls[0][0]).toBe(9182);
  });

  it("keeps the pane pid when the sweep declines (the pane is still alive)", async () => {
    // Mirrors the watchdog's false-vanish case at the kill path: nothing was
    // swept, so the handle must survive for the agent's eventual real death.
    const { killAgent } = await import("../src/daemon/spawn.js");
    const { createAgent, updateAgent, getAgent } = await import("../src/db/agents.js");
    const worker = createAgent({
      kind: "worker",
      state: "working",
      tmux_target: "cc:@4",
    });
    updateAgent(worker.id, { pane_pid: 9182 });
    windowExists.mockReturnValue(false);
    sweepVanishedPaneGroup.mockReturnValue({ outcome: "declined", killed: [] });

    killAgent(worker.id);

    expect(sweepVanishedPaneGroup).toHaveBeenCalledTimes(1);
    expect(getAgent(worker.id)?.pane_pid).toBe(9182);
  });

  it("releases the pane pid once the sweep reports the handle is spent", async () => {
    const { killAgent } = await import("../src/daemon/spawn.js");
    const { createAgent, updateAgent, getAgent } = await import("../src/db/agents.js");
    const worker = createAgent({
      kind: "worker",
      state: "working",
      tmux_target: "cc:@4",
    });
    updateAgent(worker.id, { pane_pid: 9182 });
    windowExists.mockReturnValue(false);
    sweepVanishedPaneGroup.mockReturnValue({ outcome: "unreachable", killed: [] });

    killAgent(worker.id);

    expect(getAgent(worker.id)?.pane_pid).toBeNull();
  });

  it("early-returns for a dead agent whose pane was already swept", async () => {
    const { killAgent } = await import("../src/daemon/spawn.js");
    const { createAgent, updateAgent } = await import("../src/db/agents.js");
    const worker = createAgent({ kind: "worker", state: "working", tmux_target: "cc:@4" });
    updateAgent(worker.id, { state: "dead", pane_pid: null });
    windowExists.mockReturnValue(false);

    killAgent(worker.id);

    expect(sweepVanishedPaneGroup).not.toHaveBeenCalled();
    expect(killWindow).not.toHaveBeenCalled();
  });

  it("falls back to the recorded pane process group when the window is gone", async () => {
    const { killAgent } = await import("../src/daemon/spawn.js");
    const { createAgent, updateAgent } = await import("../src/db/agents.js");
    const worker = createAgent({
      kind: "worker",
      state: "working",
      tmux_target: "cc:@4",
    });
    updateAgent(worker.id, { pane_pid: 9182 });
    windowExists.mockReturnValue(false);

    killAgent(worker.id);

    expect(killWindow).not.toHaveBeenCalled();
    expect(sweepVanishedPaneGroup).toHaveBeenCalledTimes(1);
    const [pgid, ageSec] = sweepVanishedPaneGroup.mock.calls[0];
    expect(pgid).toBe(9182);
    // The age guard is what stops the sweep hitting a reused pid; it must be a
    // sane, non-negative number of seconds since the agent was spawned.
    expect(ageSec).toBeGreaterThanOrEqual(0);
    expect(ageSec).toBeLessThan(60);
  });

  it("does nothing extra when there is neither a window nor a recorded pane", async () => {
    const { killAgent } = await import("../src/daemon/spawn.js");
    const { createAgent } = await import("../src/db/agents.js");
    const worker = createAgent({ kind: "worker", state: "working" });
    windowExists.mockReturnValue(false);

    killAgent(worker.id);

    expect(killWindow).not.toHaveBeenCalled();
    expect(sweepVanishedPaneGroup).not.toHaveBeenCalled();
  });
});

describe("cancelTask process teardown", () => {
  it("tears down the worker's and the reviewer's process trees", async () => {
    const { cancelTask } = await import("../src/daemon/spawn.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const task = createTask({ title: "t", prompt: "p", repo: "/tmp/repo" });
    const worker = createAgent({
      kind: "worker",
      state: "working",
      task_id: task.id,
      tmux_target: "cc:@10",
    });
    createAgent({
      kind: "reviewer",
      state: "working",
      task_id: task.id,
      tmux_target: "cc:@11",
    });
    updateTask(task.id, { status: "in_progress", agent_id: worker.id });

    cancelTask(task.id);

    expect(killWindow.mock.calls.map(([t]) => t).sort()).toEqual(["cc:@10", "cc:@11"]);
  });
});
