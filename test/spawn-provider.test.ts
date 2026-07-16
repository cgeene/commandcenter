import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const newWindow = vi.fn((..._args: unknown[]) => {
  throw new Error("runtime launch failed");
});
const createWorktree = vi.fn(() => ({
  dir: "/tmp/cc-spawn-worktree",
  branch: "agent/task-1",
}));

vi.mock("../src/daemon/tmux.js", () => ({
  newWindow: (...args: unknown[]) => newWindow(...args),
  windowExists: () => false,
  killWindow: vi.fn(),
}));

vi.mock("../src/daemon/worktree.js", () => ({
  createWorktree: (...args: unknown[]) => createWorktree(...args),
  createReviewWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  reviewWorktreeDir: vi.fn(),
}));

vi.mock("../src/daemon/genconfig.js", () => ({
  writeCodexConfig: () => ({
    profileFile: "/tmp/commandcenter.config.toml",
    inheritedMcpEnvVars: [],
  }),
  writeMcpConfigFile: vi.fn(),
  writeSettingsFile: vi.fn(),
}));

vi.mock("../src/daemon/transcript.js", () => ({
  findProviderTranscript: () => undefined,
}));

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-spawn-provider-"));
  tmpDir = fs.realpathSync(tmpDir);
  process.env.CC_DATA_DIR = tmpDir;
  newWindow.mockClear();
  createWorktree.mockClear();
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("provider worker spawn failure", () => {
  it("restores the queued task and marks the partial agent dead", async () => {
    const { createTask, getTask } = await import("../src/db/tasks.js");
    const { listAgents } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    const { spawnWorker } = await import("../src/daemon/spawn.js");
    const task = createTask({
      title: "t",
      prompt: "x",
      repo: "/r",
      worker_provider: "codex",
    });

    expect(() => spawnWorker(task.id)).toThrow("runtime launch failed");
    expect(String(newWindow.mock.calls[0]?.[2])).toContain(
      "--config 'model_reasoning_effort=\"high\"'",
    );
    expect(getTask(task.id)).toMatchObject({
      status: "queued",
      agent_id: null,
      worker_provider: "codex",
      reasoning_effort: "high",
    });
    expect(listAgents()).toHaveLength(1);
    expect(listAgents()[0]).toMatchObject({ state: "dead", reasoning_effort: "high" });
    expect(listEvents(10).map((event) => event.kind)).toContain("agent.spawn_failed");
  });

  it("launches scratch tasks in their managed non-Git workspace", async () => {
    const { allocateScratchWorkspace } = await import("../src/daemon/workspaces.js");
    const { createTask } = await import("../src/db/tasks.js");
    const { spawnWorker } = await import("../src/daemon/spawn.js");
    const scratch = allocateScratchWorkspace();
    const task = createTask({
      title: "investigate",
      prompt: "inspect it",
      repo: scratch,
      workspace_kind: "scratch",
      dispatch_mode: "orchestrated",
      worker_provider: "codex",
      open_pr: false,
    });

    expect(() => spawnWorker(task.id)).toThrow("runtime launch failed");
    expect(createWorktree).not.toHaveBeenCalled();
    expect(newWindow.mock.calls[0]?.[1]).toBe(scratch);
  });

  it("refuses to spawn an all-repositories parent", async () => {
    const { createTask } = await import("../src/db/tasks.js");
    const { listAgents } = await import("../src/db/agents.js");
    const { spawnWorker } = await import("../src/daemon/spawn.js");
    const task = createTask({
      title: "portfolio",
      prompt: "find the repos",
      repo: "/repos",
      workspace_kind: "portfolio",
      dispatch_mode: "orchestrated",
      open_pr: false,
    });

    expect(() => spawnWorker(task.id)).toThrow(/must create per-repository child tasks/);
    expect(createWorktree).not.toHaveBeenCalled();
    expect(newWindow).not.toHaveBeenCalled();
    expect(listAgents()).toHaveLength(0);
  });

  it("allocates a fresh scratch directory when kill removes and requeues one", async () => {
    const { createAgent } = await import("../src/db/agents.js");
    const { createTask, getTask, updateTask } = await import("../src/db/tasks.js");
    const { allocateScratchWorkspace } = await import("../src/daemon/workspaces.js");
    const { killAgent } = await import("../src/daemon/spawn.js");
    const scratch = allocateScratchWorkspace();
    const task = createTask({
      title: "retry scratch",
      prompt: "inspect it",
      repo: scratch,
      workspace_kind: "scratch",
      open_pr: false,
    });
    const agent = createAgent({
      kind: "worker",
      state: "idle",
      task_id: task.id,
    });
    updateTask(task.id, {
      status: "in_progress",
      agent_id: agent.id,
      worktree: scratch,
    });

    killAgent(agent.id, { requeue: true, rmWorktree: true });
    const requeued = getTask(task.id)!;
    expect(fs.existsSync(scratch)).toBe(false);
    expect(requeued).toMatchObject({ status: "queued", worktree: null });
    expect(requeued.repo).not.toBe(scratch);
    expect(fs.statSync(requeued.repo).isDirectory()).toBe(true);
  });
});
