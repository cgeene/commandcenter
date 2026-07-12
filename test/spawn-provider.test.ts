import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const newWindow = vi.fn((..._args: unknown[]) => {
  throw new Error("runtime launch failed");
});

vi.mock("../src/daemon/tmux.js", () => ({
  newWindow: (...args: unknown[]) => newWindow(...args),
  windowExists: () => false,
  killWindow: vi.fn(),
}));

vi.mock("../src/daemon/worktree.js", () => ({
  createWorktree: () => ({ dir: "/tmp/cc-spawn-worktree", branch: "agent/task-1" }),
  createReviewWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  reviewWorktreeDir: vi.fn(),
}));

vi.mock("../src/daemon/genconfig.js", () => ({
  writeCodexConfig: () => ({ profileFile: "/tmp/commandcenter.config.toml" }),
  writeMcpConfigFile: vi.fn(),
  writeSettingsFile: vi.fn(),
}));

vi.mock("../src/daemon/transcript.js", () => ({
  findProviderTranscript: () => undefined,
}));

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-spawn-provider-"));
  process.env.CC_DATA_DIR = tmpDir;
  newWindow.mockClear();
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
});
