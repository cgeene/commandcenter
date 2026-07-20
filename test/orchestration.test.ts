import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendText = vi.fn(async () => {});
// Controls what the main's pane looks like to the prompt-clear gate. Empty =
// idle/clear (delivery allowed); a draft with an unsubmitted line = busy.
let paneText = "";

vi.mock("../src/daemon/tmux.js", () => ({
  windowExists: () => true,
  capturePane: () => {
    // mainPromptClear fails closed on a capture error, so this models a main
    // whose prompt cannot be confirmed clear (busy / mid-draft).
    if (paneText === "__BUSY__") throw new Error("prompt not clear");
    return paneText;
  },
  sendText: (...args: unknown[]) => sendText(...args),
  sendEnter: vi.fn(),
}));

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-orchestration-"));
  process.env.CC_DATA_DIR = tmpDir;
  sendText.mockClear();
  paneText = "";
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("main-first task delegation", () => {
  it("delivers a portfolio task to the live main with decomposition instructions", async () => {
    const { createAgent } = await import("../src/db/agents.js");
    const { createTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { delegateTaskToMain } = await import("../src/daemon/orchestration.js");
    const main = createAgent({
      kind: "main",
      state: "idle",
      tmux_target: "cc:@main",
    });
    const task = createTask({
      title: "cross repo",
      prompt: "change all affected services",
      repo: "/repos",
      workspace_kind: "portfolio",
      dispatch_mode: "orchestrated",
      open_pr: false,
    });

    expect(await delegateTaskToMain(task.id)).toBe(true);
    expect(sendText).toHaveBeenCalledWith(
      main.tmux_target,
      expect.stringContaining("never spawn the parent"),
    );
    expect(listEvents(10).map((event) => event.kind)).toContain(
      "task.delegated_to_main",
    );
  });

  it("redelivers outstanding parents and recovers an unspawned child", async () => {
    const { createAgent, updateAgent } = await import("../src/db/agents.js");
    const { createTask } = await import("../src/db/tasks.js");
    const { delegatePendingTaskToMain, delegateTaskToMain } = await import(
      "../src/daemon/orchestration.js"
    );
    const firstMain = createAgent({ kind: "main", state: "idle", tmux_target: "cc:@1" });
    const parent = createTask({
      title: "parent",
      prompt: "x",
      repo: "/repos",
      workspace_kind: "portfolio",
      dispatch_mode: "orchestrated",
      open_pr: false,
    });
    createTask({
      title: "child",
      prompt: "x",
      repo: "/repo",
      workspace_kind: "repo",
      dispatch_mode: "orchestrated",
      parent_task_id: parent.id,
    });
    await delegateTaskToMain(parent.id, firstMain);
    updateAgent(firstMain.id, { state: "dead" });
    const secondMain = createAgent({ kind: "main", state: "idle", tmux_target: "cc:@2" });
    sendText.mockClear();

    expect(await delegatePendingTaskToMain(secondMain)).toBe(true);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(String(sendText.mock.calls[0]?.[1])).toContain(`#${parent.id}`);

    const { updateTask } = await import("../src/db/tasks.js");
    updateTask(parent.id, { status: "in_progress" });
    sendText.mockClear();
    expect(await delegatePendingTaskToMain(secondMain)).toBe(true);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(String(sendText.mock.calls[0]?.[1])).toContain("workspace_kind=repo");
  });

  it("does not delegate a task until its blocker is done", async () => {
    const { createAgent } = await import("../src/db/agents.js");
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const { delegatePendingTaskToLiveMain, delegateTaskToMain } = await import(
      "../src/daemon/orchestration.js"
    );
    createAgent({ kind: "main", state: "idle", tmux_target: "cc:@main" });
    const blocker = createTask({ title: "first", prompt: "x", repo: "/r" });
    const waiting = createTask({
      title: "second",
      prompt: "x",
      repo: "/r",
      dispatch_mode: "orchestrated",
      blocked_by: blocker.id,
    });

    expect(await delegateTaskToMain(waiting.id)).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
    updateTask(blocker.id, { status: "done" });
    expect(await delegatePendingTaskToLiveMain()).toBe(true);
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("does NOT clobber a busy main — leaves the task queued for retry", async () => {
    const { createAgent } = await import("../src/db/agents.js");
    const { createTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { delegateTaskToMain } = await import("../src/daemon/orchestration.js");
    createAgent({ kind: "main", state: "idle", tmux_target: "cc:@main" });
    const task = createTask({
      title: "t",
      prompt: "x",
      repo: "/r",
      dispatch_mode: "orchestrated",
      open_pr: false,
    });

    // Main's prompt cannot be confirmed clear (human mid-draft / mid-turn).
    paneText = "__BUSY__";
    expect(await delegateTaskToMain(task.id)).toBe(false);
    // Never injected into the main's pane; surfaced as still-awaiting instead.
    expect(sendText).not.toHaveBeenCalled();
    const kinds = listEvents(10).map((e) => e.kind);
    expect(kinds).toContain("task.awaiting_main");
    expect(kinds).not.toContain("task.delegated_to_main");
  });

  it("does NOT clobber an idle main with a human draft in the composer", async () => {
    const { createAgent } = await import("../src/db/agents.js");
    const { createTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { delegateTaskToMain } = await import("../src/daemon/orchestration.js");
    createAgent({ kind: "main", state: "idle", tmux_target: "cc:@main" });
    const task = createTask({
      title: "t",
      prompt: "x",
      repo: "/r",
      dispatch_mode: "orchestrated",
      open_pr: false,
    });

    // The main is idle, but the human is mid-typing a draft in its composer —
    // exactly the regression this task fixes. The triage prompt must NOT be
    // merged into that draft.
    paneText = [
      "╭────────────────────────────────────────────╮",
      "│ ❯ actually let me rethink the rollout first  │",
      "╰────────────────────────────────────────────╯",
    ].join("\n");
    expect(await delegateTaskToMain(task.id)).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
    const kinds = listEvents(10).map((e) => e.kind);
    expect(kinds).toContain("task.awaiting_main");
    expect(kinds).not.toContain("task.delegated_to_main");
  });

  it("does NOT deliver mid-turn — a working main leaves the task queued", async () => {
    const { createAgent } = await import("../src/db/agents.js");
    const { createTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { delegateTaskToMain } = await import("../src/daemon/orchestration.js");
    // availableMain accepts working|idle, but the triage prompt must never fire
    // mid-turn: a working main defers just like a busy prompt.
    createAgent({ kind: "main", state: "working", tmux_target: "cc:@main" });
    const task = createTask({
      title: "t",
      prompt: "x",
      repo: "/r",
      dispatch_mode: "orchestrated",
      open_pr: false,
    });

    paneText = ""; // prompt is clear; only the working state blocks delivery
    expect(await delegateTaskToMain(task.id)).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
    const kinds = listEvents(10).map((e) => e.kind);
    expect(kinds).toContain("task.awaiting_main");
    expect(kinds).not.toContain("task.delegated_to_main");
  });
});
