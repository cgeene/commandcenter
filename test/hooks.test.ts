import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-hooks-"));
  process.env.CC_DATA_DIR = tmpDir;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A worker agent with an in_progress task, no tmux window (windowExists → false). */
async function setup(taskFields: { verify_cmd?: string } = {}) {
  const { createTask, updateTask } = await import("../src/db/tasks.js");
  const { createAgent } = await import("../src/db/agents.js");
  const task = createTask({
    title: "t",
    prompt: "x",
    repo: "/r",
    verify_cmd: taskFields.verify_cmd,
  });
  const agent = createAgent({ kind: "worker", state: "working", task_id: task.id });
  updateTask(task.id, {
    status: "in_progress",
    agent_id: agent.id,
    worktree: tmpDir, // real dir so verify_cmd can run
  });
  return { task, agent };
}

describe("hook events", () => {
  it("SessionStart records session id on agent and task", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { getAgent } = await import("../src/db/agents.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { task, agent } = await setup();
    await handleHookEvent(agent.id, {
      hook_event_name: "SessionStart",
      session_id: "sess-123",
    });
    expect(getAgent(agent.id)?.session_id).toBe("sess-123");
    expect(getTask(task.id)?.session_id).toBe("sess-123");
  });

  it("Notification marks the agent waiting_input", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { getAgent } = await import("../src/db/agents.js");
    const { agent } = await setup();
    await handleHookEvent(agent.id, {
      hook_event_name: "Notification",
      message: "needs permission",
    });
    expect(getAgent(agent.id)?.state).toBe("waiting_input");
  });

  it("Stop with no verify_cmd + a result_summary moves the task to review", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { getTask, updateTask } = await import("../src/db/tasks.js");
    const { getAgent } = await import("../src/db/agents.js");
    const { task, agent } = await setup();
    updateTask(task.id, { result_summary: "did the thing, verified by hand" });
    await handleHookEvent(agent.id, { hook_event_name: "Stop" });
    expect(getTask(task.id)?.status).toBe("review");
    expect(getAgent(agent.id)?.state).toBe("idle");
  });

  it("Stop with no verify_cmd and NO result stays in_progress (stopped_incomplete)", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { task, agent } = await setup();
    await handleHookEvent(agent.id, { hook_event_name: "Stop" });
    await handleHookEvent(agent.id, { hook_event_name: "Stop" });
    expect(getTask(task.id)?.status).toBe("in_progress"); // NOT review
    const kinds = listEvents(10).map((e) => e.kind);
    expect(kinds.filter((k) => k === "task.stopped_incomplete").length).toBe(2);
  });

  it("Stop with passing verify_cmd moves the task to review", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { task, agent } = await setup({ verify_cmd: "true" });
    await handleHookEvent(agent.id, { hook_event_name: "Stop" });
    expect(getTask(task.id)?.status).toBe("review");
  });

  it("Stop with failing verify_cmd and no live window blocks the task", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { task, agent } = await setup({ verify_cmd: "echo boom >&2; false" });
    await handleHookEvent(agent.id, { hook_event_name: "Stop" });
    expect(getTask(task.id)?.status).toBe("blocked");
    const kinds = listEvents(20).map((e) => e.kind);
    expect(kinds).toContain("verify.failed");
    expect(kinds).toContain("task.blocked");
  });

  it("ignores events for dead or unknown agents", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { updateAgent, getAgent } = await import("../src/db/agents.js");
    const { agent } = await setup();
    updateAgent(agent.id, { state: "dead" });
    await handleHookEvent(agent.id, { hook_event_name: "Stop" });
    expect(getAgent(agent.id)?.state).toBe("dead");
    await handleHookEvent(9999, { hook_event_name: "Stop" }); // must not throw
  });
});
