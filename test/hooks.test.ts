import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sendText = vi.fn(async () => {});
let paneContent = "";
// Per-target overrides so a worker's pane can differ from the main's — the
// catch-up delegator now gates on the main's own prompt being clear, so tests
// that give a worker a waiting pane must still hand the main a clear one.
const paneByTarget = new Map<string, string>();

vi.mock("../src/daemon/tmux.js", () => ({
  windowExists: () => true,
  sendText: (...args: unknown[]) => sendText(...args),
  capturePane: (target: string) => paneByTarget.get(target) ?? paneContent,
}));

let tmpDir: string;

// An empty composer. The marker is the "❯" the TUI actually renders: the pane
// parser identifies the input line by that glyph, so a fixture using a plain
// ">" models a pane with NO composer on it, which is no longer treated as a
// clear prompt (an input line we cannot see is not an input line we know to be
// empty — see notifqueue.promptClarity).
const PROMPT_BOX = [
  "╭──────────────────────────────────────────────────────────╮",
  "│ ❯                                                          │",
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
  paneByTarget.clear();
  sendText.mockClear();
  sendText.mockImplementation(async () => {});
  const {
    __clearAutoNudgeCountsForTests,
    __clearIdleRedelegateForTests,
    __clearBackgroundParkForTests,
  } = await import("../src/daemon/hooks.js");
  __clearAutoNudgeCountsForTests();
  __clearIdleRedelegateForTests();
  __clearBackgroundParkForTests();
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

  it("SessionStart is the readiness handshake for a spawning worker", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { createAgent, getAgent, updateAgent } = await import("../src/db/agents.js");
    const agent = createAgent({ kind: "worker", state: "spawning" });
    await handleHookEvent(agent.id, {
      hook_event_name: "SessionStart",
      session_id: "ready-session",
    });
    // The spawn path may learn the tmux target after the hook arrives; that
    // metadata update must not overwrite readiness back to spawning.
    updateAgent(agent.id, { tmux_target: "cc:@7" });
    expect(getAgent(agent.id)?.state).toBe("working");
  });

  it("SessionStart clears a startup trust wait and delegates an existing worker wait", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const { logEvent, listEvents } = await import("../src/db/events.js");
    const worker = createAgent({
      kind: "worker",
      provider: "codex",
      state: "waiting_input",
      tmux_target: "cc:@1",
    });
    logEvent("agent.startup_permission", { agentId: worker.id });
    const main = createAgent({
      kind: "main",
      provider: "claude",
      state: "waiting_input",
      tmux_target: "cc:@2",
    });
    paneContent = [
      "Would you like to run the following command?",
      "",
      "› 1. Yes, proceed",
      "  2. No",
      "",
      "Press enter to confirm or esc to cancel",
    ].join("\n");
    // The main's own composer is clear, so the catch-up may deliver to it.
    paneByTarget.set("cc:@2", PROMPT_BOX);

    await handleHookEvent(main.id, {
      hook_event_name: "SessionStart",
      session_id: "main-ready",
    });

    expect(getAgent(main.id)?.state).toBe("working");
    expect(sendText).toHaveBeenCalledWith(
      "cc:@2",
      expect.stringContaining(`peek_worker(${worker.id})`),
      // Main-agent delivery is guarded: the composer is re-checked between the
      // keystrokes and Enter so a racing keystroke can't be submitted with it.
      expect.objectContaining({ beforeSubmit: expect.any(Function) }),
    );
    expect(listEvents(20).map((event) => event.kind)).toContain(
      "waiting.delegated",
    );
  });

  it("never delegates a repository trust decision to the main model", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const { logEvent, listEvents } = await import("../src/db/events.js");
    const worker = createAgent({
      kind: "worker",
      provider: "codex",
      state: "waiting_input",
      tmux_target: "cc:@1",
    });
    logEvent("agent.startup_permission", {
      agentId: worker.id,
      payload: { trust: true },
    });
    const main = createAgent({
      kind: "main",
      provider: "claude",
      state: "waiting_input",
      tmux_target: "cc:@2",
    });
    paneContent = [
      "Do you trust the contents of this directory?",
      "",
      "› 1. Yes, continue",
      "  2. No, quit",
      "",
      "Press enter to continue",
    ].join("\n");

    await handleHookEvent(main.id, {
      hook_event_name: "SessionStart",
      session_id: "main-ready",
    });

    expect(getAgent(main.id)?.state).toBe("working");
    expect(sendText).not.toHaveBeenCalled();
    expect(listEvents(20).map((event) => event.kind)).not.toContain(
      "waiting.delegated",
    );
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

  it("an idle main notification stays eligible for the next worker wait", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const { logEvent, listEvents } = await import("../src/db/events.js");
    const worker = createAgent({
      kind: "worker",
      provider: "codex",
      state: "waiting_input",
      tmux_target: "cc:@1",
    });
    logEvent("hook.permissionrequest", {
      agentId: worker.id,
    });
    const main = createAgent({
      kind: "main",
      provider: "claude",
      state: "idle",
      tmux_target: "cc:@2",
    });
    paneContent = [
      "$ go test ./...",
      "",
      "› 1. Yes, proceed (y)",
      "  2. No (esc)",
      "",
      "Press enter to confirm or esc to cancel",
    ].join("\n");
    // The main's own composer is clear, so the catch-up may deliver to it.
    paneByTarget.set("cc:@2", PROMPT_BOX);

    await handleHookEvent(main.id, {
      hook_event_name: "Notification",
      notification_type: "idle_prompt",
      message: "Claude is waiting for your input",
    });

    expect(sendText).toHaveBeenCalledWith(
      "cc:@2",
      expect.stringContaining(`peek_worker(${worker.id})`),
      // Main-agent delivery is guarded: the composer is re-checked between the
      // keystrokes and Enter so a racing keystroke can't be submitted with it.
      expect.objectContaining({ beforeSubmit: expect.any(Function) }),
    );
    expect(getAgent(main.id)?.state).toBe("working");
    expect(
      listEvents(20).filter((event) => event.kind === "waiting.delegated"),
    ).toHaveLength(1);
  });

  it("does NOT deliver a catch-up worker wait while the human is mid-typing in the main", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const { logEvent, listEvents } = await import("../src/db/events.js");
    const worker = createAgent({
      kind: "worker",
      provider: "codex",
      state: "waiting_input",
      tmux_target: "cc:@1",
    });
    logEvent("hook.permissionrequest", { agentId: worker.id });
    const main = createAgent({
      kind: "main",
      provider: "claude",
      state: "idle",
      tmux_target: "cc:@2",
    });
    paneContent = [
      "$ go test ./...",
      "",
      "› 1. Yes, proceed (y)",
      "  2. No (esc)",
      "",
      "Press enter to confirm or esc to cancel",
    ].join("\n");
    // The human is mid-typing a draft in the main's composer — the catch-up
    // must NOT clobber it, even though a worker wait is outstanding.
    paneByTarget.set(
      "cc:@2",
      [
        "╭────────────────────────────────────────────╮",
        "│ ❯ hold on, do not merge that PR yet          │",
        "╰────────────────────────────────────────────╯",
      ].join("\n"),
    );

    await handleHookEvent(main.id, {
      hook_event_name: "Notification",
      notification_type: "idle_prompt",
      message: "Claude is waiting for your input",
    });

    expect(sendText).not.toHaveBeenCalled();
    expect(
      listEvents(20).filter((event) => event.kind === "waiting.delegated"),
    ).toHaveLength(0);
    // The worker is still waiting, so its escalate-to-human page is unaffected.
    expect(getAgent(worker.id)?.state).toBe("waiting_input");
  });

  it("a main permission notification still requires human input", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const main = createAgent({
      kind: "main",
      provider: "claude",
      state: "idle",
      tmux_target: "cc:@2",
    });

    await handleHookEvent(main.id, {
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
      message: "Claude needs permission",
    });

    expect(getAgent(main.id)?.state).toBe("waiting_input");
    expect(sendText).not.toHaveBeenCalled();
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

  it("review-disabled no-PR task completes straight to done on Stop (no reviewer)", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { createTask, updateTask, getTask } = await import("../src/db/tasks.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    const task = createTask({
      title: "report",
      prompt: "x",
      repo: "/r",
      open_pr: false,
      auto_review: false,
    });
    const agent = createAgent({ kind: "worker", state: "working", task_id: task.id });
    updateTask(task.id, {
      status: "in_progress",
      agent_id: agent.id,
      worktree: tmpDir,
      result_summary: "weekly report saved to the doc store",
    });
    await handleHookEvent(agent.id, { hook_event_name: "Stop" });
    expect(getTask(task.id)?.status).toBe("done");
    const kinds = listEvents(20).map((e) => e.kind);
    expect(kinds).toContain("task.autocompleted");
    expect(kinds).not.toContain("task.review");
  });

  it("review-disabled but PR-obligated task still goes to review (merge gate not bypassed)", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { createTask, updateTask, getTask } = await import("../src/db/tasks.js");
    const { createAgent } = await import("../src/db/agents.js");
    // auto_review off but open_pr on (default): the guard must NOT auto-complete.
    const task = createTask({
      title: "code",
      prompt: "x",
      repo: "/r",
      auto_review: false,
    });
    const agent = createAgent({ kind: "worker", state: "working", task_id: task.id });
    updateTask(task.id, {
      status: "in_progress",
      agent_id: agent.id,
      worktree: tmpDir,
      result_summary: "made changes on a branch",
    });
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

describe("idle-prompt suppression for finished workers in review", () => {
  async function liveIdleMain() {
    const { createAgent } = await import("../src/db/agents.js");
    return createAgent({ kind: "main", state: "idle", tmux_target: "cc:@2" });
  }

  const IDLE_PROMPT = {
    hook_event_name: "Notification" as const,
    notification_type: "idle_prompt",
    message: "Claude is waiting for your input",
  };

  it("suppresses the idle ping when a finished worker's task is in review", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { getAgent } = await import("../src/db/agents.js");
    const { getTask, updateTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    paneContent = PROMPT_BOX; // main prompt clear, so a delegation WOULD send
    await liveIdleMain();
    const { task, agent } = await setup();
    updateTask(task.id, { result_summary: "done" });
    await handleHookEvent(agent.id, { hook_event_name: "Stop" }); // → review, hook.stop, idle
    expect(getTask(task.id)?.status).toBe("review");

    await handleHookEvent(agent.id, IDLE_PROMPT);

    expect(getAgent(agent.id)?.state).toBe("idle"); // NOT waiting_input
    expect(sendText).not.toHaveBeenCalled(); // never delegated to the main
    const kinds = listEvents(30).map((e) => e.kind);
    expect(kinds).toContain("waiting.suppressed_in_review");
    expect(kinds).not.toContain("waiting.delegated");
  });

  it("does NOT suppress a permission-menu wait even when the task is in review", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { getAgent } = await import("../src/db/agents.js");
    const { updateTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { task, agent } = await setup();
    updateTask(task.id, { result_summary: "done" });
    await handleHookEvent(agent.id, { hook_event_name: "Stop" }); // → review
    // A permission prompt is a different notification_type — worker is blocked
    // mid-work, so it must still surface even though the task shows review.
    await handleHookEvent(agent.id, {
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
      message: "Claude needs permission to run a command",
    });

    expect(getAgent(agent.id)?.state).toBe("waiting_input");
    const kinds = listEvents(30).map((e) => e.kind);
    expect(kinds).not.toContain("waiting.suppressed_in_review");
  });

  it("does NOT suppress an idle ping while the task is still in_progress", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { getAgent } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    const { agent } = await setup(); // task stays in_progress
    await handleHookEvent(agent.id, { hook_event_name: "Stop" }); // stopped_incomplete, idle
    await handleHookEvent(agent.id, IDLE_PROMPT);

    expect(getAgent(agent.id)?.state).toBe("waiting_input"); // genuinely idle-waiting
    const kinds = listEvents(30).map((e) => e.kind);
    expect(kinds).not.toContain("waiting.suppressed_in_review");
  });

  it("re-enables the ping after a rejection moves the task back to in_progress", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { getAgent, updateAgent } = await import("../src/db/agents.js");
    const { getTask, updateTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { task, agent } = await setup();
    updateTask(task.id, { result_summary: "done" });
    await handleHookEvent(agent.id, { hook_event_name: "Stop" }); // → review
    await handleHookEvent(agent.id, IDLE_PROMPT); // suppressed
    expect(getAgent(agent.id)?.state).toBe("idle");

    // Reject reopens the task; the worker resumes work on a fresh turn (its
    // prior result is cleared until it re-submits).
    updateTask(task.id, { status: "in_progress", review_verdict: null, result_summary: null });
    updateAgent(agent.id, { state: "working" });
    await handleHookEvent(agent.id, { hook_event_name: "Stop" }); // stopped_incomplete
    expect(getTask(task.id)?.status).toBe("in_progress");
    await handleHookEvent(agent.id, IDLE_PROMPT); // now NOT suppressed

    expect(getAgent(agent.id)?.state).toBe("waiting_input");
    const suppressed = listEvents(40).filter(
      (e) => e.kind === "waiting.suppressed_in_review",
    );
    expect(suppressed).toHaveLength(1); // only the first, in-review occurrence
  });

  it("does NOT suppress a REVIEWER's idle ping in review (reviewers must keep escalating)", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    // A reviewer shares the task_id; its task is in review by definition.
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    updateTask(task.id, { status: "review" });
    const reviewer = createAgent({ kind: "reviewer", state: "working", task_id: task.id });
    await handleHookEvent(reviewer.id, { hook_event_name: "Stop" }); // no verdict → reviewerStopped
    await handleHookEvent(reviewer.id, IDLE_PROMPT);

    // Reviewer keeps the normal wait path (idle → waiting_input → escalation),
    // never silenced by the worker-scoped suppression.
    expect(getAgent(reviewer.id)?.state).toBe("waiting_input");
    const kinds = listEvents(30).map((e) => e.kind);
    expect(kinds).not.toContain("waiting.suppressed_in_review");
  });

  it("throttles a repeated idle re-delegation for the same finished turn", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { updateAgent } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    paneContent = PROMPT_BOX; // main prompt clear → first idle_prompt delegates
    await liveIdleMain();
    const { agent } = await setup(); // task in_progress (not suppressed)
    await handleHookEvent(agent.id, { hook_event_name: "Stop" }); // hook.stop, idle
    await handleHookEvent(agent.id, IDLE_PROMPT); // delegate #1 + record dedupe stamp

    // State churns back to idle without a new Stop (same turn); a fresh
    // idle_prompt must not re-delegate within the throttle window.
    updateAgent(agent.id, { state: "idle" });
    await handleHookEvent(agent.id, IDLE_PROMPT); // throttled

    const kinds = listEvents(40).map((e) => e.kind);
    expect(kinds.filter((k) => k === "waiting.delegated")).toHaveLength(1);
    expect(kinds).toContain("waiting.idle_redelegate_throttled");
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

  it("a task WITH a verify_cmd still auto-nudges on a stalled Stop instead of trivially verifying", async () => {
    // A trivially-passing verify_cmd must not be run at all for a stalled
    // turn — running it would falsely mark an untouched turn "done".
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { task, agent } = await setup({ verify_cmd: "true", tmux_target: "cc:@1" });
    paneContent = OVERLOAD_ERROR_PANE;

    await handleHookEvent(agent.id, { hook_event_name: "Stop" });

    expect(sendText).toHaveBeenCalledOnce();
    expect(sendText).toHaveBeenCalledWith("cc:@1", "please continue");
    expect(getTask(task.id)?.status).toBe("in_progress"); // NOT review
    const kinds = listEvents(10).map((e) => e.kind);
    expect(kinds).toContain("agent.auto_nudged");
    expect(kinds).not.toContain("verify.passed");
  });

  it("a verify_cmd task caps at 2 auto-nudges, then falls through to the normal verify-failure path with the stall folded in", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { task, agent } = await setup({ verify_cmd: "false", tmux_target: "cc:@1" });
    paneContent = OVERLOAD_ERROR_PANE;

    await handleHookEvent(agent.id, { hook_event_name: "Stop" }); // auto-nudge 1
    await handleHookEvent(agent.id, { hook_event_name: "Stop" }); // auto-nudge 2
    await handleHookEvent(agent.id, { hook_event_name: "Stop" }); // cap hit: falls through to verify

    expect(sendText).toHaveBeenCalledTimes(3);
    expect(sendText.mock.calls[0][1]).toBe("please continue");
    expect(sendText.mock.calls[1][1]).toBe("please continue");
    // The 3rd call is the pre-existing verify-failure nudge, with the
    // transient-error context folded in rather than silently dropped.
    expect(sendText.mock.calls[2][1]).toMatch(/Verification failed/);
    expect(sendText.mock.calls[2][1]).toMatch(/auto-recovery attempts for a transient error/);

    const events = listEvents(20);
    expect(events.filter((e) => e.kind === "agent.auto_nudged").length).toBe(2);
    expect(events.filter((e) => e.kind === "verify.failed").length).toBe(1);
    expect(getTask(task.id)?.status).toBe("in_progress"); // reopened via the verify nudge, not blocked yet
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

/**
 * A worker that parks between turns while a Monitor watch or a background shell
 * is still running re-wakes itself when that work completes, so its idle_prompt
 * must not reach the orchestrator or start the escalate-to-human timer.
 *
 * The status bars below mirror captures from a live daemon worker (Claude Code
 * v2.1.220, 2026-07-27); the separator is U+00B7.
 */
describe("idle-prompt suppression for workers parked on background work", () => {
  const IDLE_PROMPT = {
    hook_event_name: "Notification" as const,
    notification_type: "idle_prompt",
    message: "Claude is waiting for your input",
  };
  const WORKER_TARGET = "cc:@1";
  const RULE = "─".repeat(100);

  /** An idle composer capped by a status bar, optionally reporting background
   *  work in its own interpunct-delimited segment. */
  function workerPane(indicator: string | null, transcript: string[] = []): string {
    const segments = [
      "⏵⏵ don't ask on",
      ...(indicator ? [indicator] : []),
      "← for agents",
      "↓ to manage",
    ];
    return [
      ...transcript,
      RULE,
      "❯ ",
      RULE,
      `  ${segments.join(" · ")}`,
    ].join("\n");
  }

  /** A live idle main with a clear prompt, so any delegation really would send. */
  async function liveIdleMain() {
    const { createAgent } = await import("../src/db/agents.js");
    paneByTarget.set("cc:@2", PROMPT_BOX);
    return createAgent({ kind: "main", state: "idle", tmux_target: "cc:@2" });
  }

  const MENU_PANE = [
    "╭──────────────────────────────────────────────────────────╮",
    "│ Run the packer build?                                    │",
    "│                                                          │",
    "│ ❯ 1. Yes                                                 │",
    "│   2. No                                                  │",
    "╰──────────────────────────────────────────────────────────╯",
    "  ⏵⏵ don't ask on · 1 shell, 1 monitor · ↓ to manage",
  ].join("\n");

  const DRAFT_PANE = [
    RULE,
    "❯ should I also bump the AMI version?",
    RULE,
    "  ⏵⏵ don't ask on · 1 monitor · ↓ to manage",
  ].join("\n");

  const PERMISSION_PROMPT = {
    hook_event_name: "Notification" as const,
    notification_type: "permission_prompt",
    message: "Claude needs permission to run a command",
  };

  /**
   * The whole suppression decision, one row per input. Parking a worker on its
   * own background work is the ONLY case that may swallow the idle ping —
   * everything else must keep the normal idle -> waiting_input -> escalation
   * path, because suppressing wrongly silences a real wait for the entire park
   * window while staying invisible to both the watchdog and Needs You.
   *
   * Events are read scoped to the row's own agent, since every row makes a fresh
   * one and the log is shared.
   */
  it("suppresses the idle ping only for a worker parked on its own background work", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { getAgent, createAgent } = await import("../src/db/agents.js");
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");

    for (const row of [
      {
        why: "a monitor and a shell both running",
        pane: workerPane("1 shell, 1 monitor"),
        state: "idle",
        suppressed: { shells: 1, monitors: 1 },
      },
      { why: "a monitor alone", pane: workerPane("1 monitor"), state: "idle", suppressed: { shells: 0, monitors: 1 } },
      { why: "background shells alone", pane: workerPane("2 shells"), state: "idle", suppressed: { shells: 2, monitors: 0 } },
      // Background work running alongside a decision someone has to make does
      // not make that decision self-resolving.
      { why: "a permission menu up, even with a monitor running", pane: MENU_PANE, state: "waiting_input" },
      { why: "a draft sitting unsent in the composer", pane: DRAFT_PANE, state: "waiting_input" },
      { why: "a status bar reporting no background work", pane: workerPane(null), state: "waiting_input" },
      {
        why: "the indicator merely quoted in the worker's own transcript",
        pane: workerPane(null, [
          "⏺ The status bar renders it as · 1 shell, 1 monitor · between segments.",
          "",
        ]),
        state: "waiting_input",
      },
      // A permission_prompt is a different notification_type and no Stop has
      // fired for this turn — the worker is blocked mid-work, not parked.
      { why: "a mid-work permission notification (no Stop for this turn)", pane: workerPane("1 monitor"), event: PERMISSION_PROMPT, skipStop: true, state: "waiting_input" },
      // Worker-scoped, exactly like the in-review suppression: a reviewer keeps
      // escalating.
      { why: "a REVIEWER parked on background work", pane: workerPane("1 shell, 1 monitor"), as: "reviewer" as const, state: "waiting_input" },
    ]) {
      // A fresh idle main per row: the idle re-delegation is throttled per
      // finished turn, so a main carried over from the previous row would make
      // the next row's delegation assertion fail for the wrong reason.
      await liveIdleMain();
      const since = listEvents(1)[0]?.id ?? 0;
      let agentId: number;
      if (row.as === "reviewer") {
        const task = createTask({ title: "t", prompt: "x", repo: "/r" });
        updateTask(task.id, { status: "review" });
        agentId = createAgent({
          kind: "reviewer",
          state: "working",
          task_id: task.id,
          tmux_target: WORKER_TARGET,
        }).id;
      } else {
        agentId = (await setup({ tmux_target: WORKER_TARGET })).agent.id;
      }
      paneByTarget.set(WORKER_TARGET, row.pane);

      if (!row.skipStop) await handleHookEvent(agentId, { hook_event_name: "Stop" });
      sendText.mockClear(); // ignore anything the Stop path itself sent
      await handleHookEvent(agentId, row.event ?? IDLE_PROMPT);

      expect(getAgent(agentId)?.state, row.why).toBe(row.state);
      // Scoped by event id, not agent: waiting.delegated is recorded against
      // the MAIN agent that receives the delegation, not the parked worker.
      const mine = listEvents(400).filter((e) => e.id > since);
      const suppression = mine.find(
        (e) => e.kind === "waiting.suppressed_active_monitor" && e.agent_id === agentId,
      );
      if (row.suppressed) {
        // Never enters waiting_input, so neither the delegation nor the
        // scheduler's escalate-to-human page (which keys on waiting_input) fires.
        expect(suppression, row.why).toBeDefined();
        expect(JSON.parse(suppression!.payload!), row.why).toEqual(row.suppressed);
        expect(sendText, row.why).not.toHaveBeenCalled();
        expect(mine.map((e) => e.kind), row.why).not.toContain("waiting.delegated");
      } else {
        expect(suppression, row.why).toBeUndefined();
      }
    }
  });

  // Kept out of the table above: the idle re-delegation is throttled per finished
  // turn, so it can only be asserted once per database. Its counterpart — that a
  // SUPPRESSED wait never delegates — is asserted on every suppressed row.
  it("delegates a non-suppressed worker wait to an idle main", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { listEvents } = await import("../src/db/events.js");
    await liveIdleMain();
    const { agent } = await setup({ tmux_target: WORKER_TARGET });
    paneByTarget.set(WORKER_TARGET, workerPane(null)); // no background work to park on

    await handleHookEvent(agent.id, { hook_event_name: "Stop" });
    await handleHookEvent(agent.id, IDLE_PROMPT);

    expect(listEvents(60).map((e) => e.kind)).toContain("waiting.delegated");
  });

  it("never demotes an already-waiting agent to idle (a counting-down escalation must survive)", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { getAgent } = await import("../src/db/agents.js");
    const { listEvents, latestAgentEventTs } = await import("../src/db/events.js");
    await liveIdleMain();
    const { agent } = await setup({ tmux_target: WORKER_TARGET });

    // First idle_prompt: the pane read fails (no background counts visible), so
    // the worker legitimately enters waiting_input and the escalation clock —
    // which the scheduler derives from this wait's hook event — starts running.
    paneByTarget.set(WORKER_TARGET, workerPane(null));
    await handleHookEvent(agent.id, { hook_event_name: "Stop" });
    await handleHookEvent(agent.id, IDLE_PROMPT);
    expect(getAgent(agent.id)?.state).toBe("waiting_input");
    const waitStart = latestAgentEventTs(agent.id, ["hook.notification"]);
    expect(waitStart).toBeTruthy();

    // Repeat idle_prompt for the same wait, and this time the pane DOES read as
    // parked (the earlier capture raced, or a draft was cleared between the two).
    // Suppressing now would silently cancel the in-flight escalation.
    paneByTarget.set(WORKER_TARGET, workerPane("1 shell, 1 monitor"));
    await handleHookEvent(agent.id, IDLE_PROMPT);

    expect(getAgent(agent.id)?.state).toBe("waiting_input"); // NOT demoted to idle
    const kinds = listEvents(40).map((e) => e.kind);
    expect(kinds).not.toContain("waiting.suppressed_active_monitor");
    // The wait episode the watchdog keys on is still on record, so the
    // escalate-to-human timer remains armed.
    expect(latestAgentEventTs(agent.id, ["hook.notification"])).toBeTruthy();
  });

  it("stops suppressing once the park window is exhausted", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { getAgent, updateAgent } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    await liveIdleMain();
    const { agent } = await setup({ tmux_target: WORKER_TARGET });
    paneByTarget.set(WORKER_TARGET, workerPane("1 monitor"));

    await handleHookEvent(agent.id, { hook_event_name: "Stop" });
    await handleHookEvent(agent.id, IDLE_PROMPT); // starts the park clock
    expect(getAgent(agent.id)?.state).toBe("idle");

    // A worker wedged behind a `persistent` monitor would otherwise stay silent
    // forever: an "idle" agent is checked by neither the escalation watchdog
    // (waiting_input only) nor the stall detector (working only).
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 91 * 60_000);
      updateAgent(agent.id, { state: "working" });
      await handleHookEvent(agent.id, { hook_event_name: "Stop" });
      await handleHookEvent(agent.id, IDLE_PROMPT);
    } finally {
      vi.useRealTimers();
    }

    expect(getAgent(agent.id)?.state).toBe("waiting_input");
    const suppressed = listEvents(40).filter(
      (e) => e.kind === "waiting.suppressed_active_monitor",
    );
    expect(suppressed).toHaveLength(1); // only the first park, before expiry
  });

  it("re-arms a fresh park window after the background work finishes", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { getAgent, updateAgent } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    await liveIdleMain();
    const { agent } = await setup({ tmux_target: WORKER_TARGET });

    // Park, then the monitor completes and the worker runs a turn that ends with
    // nothing in flight, then it parks on new background work.
    paneByTarget.set(WORKER_TARGET, workerPane("1 monitor"));
    await handleHookEvent(agent.id, { hook_event_name: "Stop" });
    await handleHookEvent(agent.id, IDLE_PROMPT);

    paneByTarget.set(WORKER_TARGET, workerPane(null));
    updateAgent(agent.id, { state: "working" });
    await handleHookEvent(agent.id, { hook_event_name: "Stop" });
    await handleHookEvent(agent.id, IDLE_PROMPT); // normal wait — clears the clock

    paneByTarget.set(WORKER_TARGET, workerPane("1 shell"));
    updateAgent(agent.id, { state: "working" });
    await handleHookEvent(agent.id, { hook_event_name: "Stop" });
    await handleHookEvent(agent.id, IDLE_PROMPT);

    expect(getAgent(agent.id)?.state).toBe("idle");
    const suppressed = listEvents(60).filter(
      (e) => e.kind === "waiting.suppressed_active_monitor",
    );
    expect(suppressed).toHaveLength(2);
  });
});
