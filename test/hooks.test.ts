import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sendText = vi.fn(async () => {});
let paneContent = "";

vi.mock("../src/daemon/tmux.js", () => ({
  windowExists: () => true,
  sendText: (...args: unknown[]) => sendText(...args),
  capturePane: () => paneContent,
}));

let tmpDir: string;

const PROMPT_BOX = [
  "╭──────────────────────────────────────────────────────────╮",
  "│ >                                                          │",
  "╰──────────────────────────────────────────────────────────╯",
].join("\n");

const OVERLOAD_ERROR_PANE = [
  "⏺ Update(src/foo.ts)",
  "  ⎿  Updated 3 lines",
  "",
  '⏺ API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
  "",
  PROMPT_BOX,
].join("\n");

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-hooks-"));
  process.env.CC_DATA_DIR = tmpDir;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  paneContent = "";
  sendText.mockClear();
  sendText.mockImplementation(async () => {});
  const { __clearAutoNudgeCountsForTests } = await import("../src/daemon/hooks.js");
  __clearAutoNudgeCountsForTests();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A worker agent with an in_progress task. No tmux_target by default, so
 *  tryAutoNudge/resumeAgent short-circuit to not_live regardless of the
 *  windowExists mock — pass tmux_target for tests exercising pane capture. */
async function setup(taskFields: { verify_cmd?: string; tmux_target?: string } = {}) {
  const { createTask, updateTask } = await import("../src/db/tasks.js");
  const { createAgent } = await import("../src/db/agents.js");
  const task = createTask({
    title: "t",
    prompt: "x",
    repo: "/r",
    verify_cmd: taskFields.verify_cmd,
  });
  const agent = createAgent({
    kind: "worker",
    state: "working",
    task_id: task.id,
    tmux_target: taskFields.tmux_target,
  });
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

describe("transient API error auto-nudge", () => {
  it("Stop with no result_summary and a transient-error pane sends a silent continue, not an escalation", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { getAgent } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    const { task, agent } = await setup({ tmux_target: "cc:@1" });
    paneContent = OVERLOAD_ERROR_PANE;

    await handleHookEvent(agent.id, { hook_event_name: "Stop" });

    expect(sendText).toHaveBeenCalledOnce();
    expect(sendText).toHaveBeenCalledWith("cc:@1", "please continue");
    expect(getTask(task.id)?.status).toBe("in_progress"); // not blocked/review
    expect(getAgent(agent.id)?.state).toBe("working"); // not waiting_input
    const kinds = listEvents(10).map((e) => e.kind);
    expect(kinds).toContain("agent.auto_nudged");
    expect(kinds).not.toContain("task.stopped_incomplete");
  });

  it("does not auto-nudge when the worker merely quoted an API error in prose", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { agent } = await setup({ tmux_target: "cc:@1" });
    paneContent = [
      "⏺ I hit a transient error earlier — the log showed",
      '  "API Error: 529 Overloaded" — but a retry succeeded and tests pass.',
      "",
      "⏺ Bash(npm test)",
      "  ⎿  All tests passed",
      "",
      "╭──────╮",
      "│ >    │",
      "╰──────╯",
    ].join("\n");

    await handleHookEvent(agent.id, { hook_event_name: "Stop" });

    expect(sendText).not.toHaveBeenCalled();
    const kinds = listEvents(10).map((e) => e.kind);
    expect(kinds).not.toContain("agent.auto_nudged");
    expect(kinds).toContain("task.stopped_incomplete");
  });

  it("caps auto-nudges at 2 consecutive stalls, then escalates with the error in the message", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { task, agent } = await setup({ tmux_target: "cc:@1" });
    paneContent = OVERLOAD_ERROR_PANE;

    await handleHookEvent(agent.id, { hook_event_name: "Stop" }); // nudge 1
    await handleHookEvent(agent.id, { hook_event_name: "Stop" }); // nudge 2
    await handleHookEvent(agent.id, { hook_event_name: "Stop" }); // 3rd: falls through

    expect(sendText).toHaveBeenCalledTimes(2);
    expect(getTask(task.id)?.status).toBe("in_progress");
    const events = listEvents(20);
    expect(events.filter((e) => e.kind === "agent.auto_nudged").length).toBe(2);
    expect(events.filter((e) => e.kind === "task.stopped_incomplete").length).toBe(1);
  });

  it("resets the nudge count once the agent produces a clean Stop", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { updateTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { task, agent } = await setup({ tmux_target: "cc:@1" });
    paneContent = OVERLOAD_ERROR_PANE;

    await handleHookEvent(agent.id, { hook_event_name: "Stop" }); // nudge 1
    await handleHookEvent(agent.id, { hook_event_name: "Stop" }); // nudge 2

    // Worker finishes cleanly — the stall streak is over.
    updateTask(task.id, { result_summary: "done" });
    paneContent = "⏺ All set, wrapping up.\n\n╭──╮\n│ >│\n╰──╯";
    await handleHookEvent(agent.id, { hook_event_name: "Stop" });

    // Requeue the task and hit the same stall again — should nudge, not escalate.
    updateTask(task.id, { status: "in_progress", result_summary: null });
    paneContent = OVERLOAD_ERROR_PANE;
    await handleHookEvent(agent.id, { hook_event_name: "Stop" }); // nudge 1 again

    expect(sendText).toHaveBeenCalledTimes(3);
    const events = listEvents(20);
    expect(events.filter((e) => e.kind === "agent.auto_nudged").length).toBe(3);
    expect(events.filter((e) => e.kind === "task.stopped_incomplete").length).toBe(0);
  });

  it("Notification for a transiently-stalled worker auto-nudges instead of marking waiting_input", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { getAgent } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    const { agent } = await setup({ tmux_target: "cc:@1" });
    paneContent = OVERLOAD_ERROR_PANE;

    await handleHookEvent(agent.id, {
      hook_event_name: "Notification",
      message: "waiting for input",
    });

    expect(sendText).toHaveBeenCalledOnce();
    expect(getAgent(agent.id)?.state).toBe("working");
    const kinds = listEvents(10).map((e) => e.kind);
    expect(kinds).toContain("agent.auto_nudged");
    expect(kinds).not.toContain("waiting.delegated");
  });

  it("Notification with no error signature still marks waiting_input as before", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { getAgent } = await import("../src/db/agents.js");
    const { agent } = await setup({ tmux_target: "cc:@1" });
    paneContent = "⏺ Needs your input on something.\n\n╭──╮\n│ >│\n╰──╯";

    await handleHookEvent(agent.id, {
      hook_event_name: "Notification",
      message: "needs permission",
    });

    expect(sendText).not.toHaveBeenCalled();
    expect(getAgent(agent.id)?.state).toBe("waiting_input");
  });

  it("a human/orchestrator send resets the nudge count", async () => {
    const { handleHookEvent, resetAutoNudgeCount } = await import("../src/daemon/hooks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { agent } = await setup({ tmux_target: "cc:@1" });
    paneContent = OVERLOAD_ERROR_PANE;

    await handleHookEvent(agent.id, { hook_event_name: "Stop" }); // nudge 1
    await handleHookEvent(agent.id, { hook_event_name: "Stop" }); // nudge 2

    resetAutoNudgeCount(agent.id); // simulates the /send route's reset

    await handleHookEvent(agent.id, { hook_event_name: "Stop" }); // nudge 1 again, not escalation

    expect(sendText).toHaveBeenCalledTimes(3);
    const events = listEvents(20);
    expect(events.filter((e) => e.kind === "agent.auto_nudged").length).toBe(3);
    expect(events.filter((e) => e.kind === "task.stopped_incomplete").length).toBe(0);
  });
});
