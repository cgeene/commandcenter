import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-cancel-"));
  process.env.CC_DATA_DIR = tmpDir;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("cancelTask", () => {
  it("cancels a queued task", async () => {
    const { cancelTask } = await import("../src/daemon/spawn.js");
    const { createTask, getTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    const r = cancelTask(task.id);
    expect(getTask(task.id)?.status).toBe("cancelled");
    expect(r.killed_agents).toEqual([]);
    expect(listEvents(10).map((e) => e.kind)).toContain("task.cancelled");
  });

  it("kills the live worker AND reviewer, but never the main agent", async () => {
    const { cancelTask } = await import("../src/daemon/spawn.js");
    const { createTask, updateTask, getTask } = await import("../src/db/tasks.js");
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    const worker = createAgent({ kind: "worker", state: "working", task_id: task.id });
    const reviewer = createAgent({ kind: "reviewer", state: "working", task_id: task.id });
    const main = createAgent({ kind: "main", state: "working" });
    updateTask(task.id, { status: "in_progress", agent_id: worker.id });

    const r = cancelTask(task.id);
    expect(getTask(task.id)?.status).toBe("cancelled");
    expect(r.killed_agents.sort()).toEqual([worker.id, reviewer.id].sort());
    expect(getAgent(worker.id)?.state).toBe("dead");
    expect(getAgent(reviewer.id)?.state).toBe("dead");
    expect(getAgent(main.id)?.state).toBe("working");
  });

  it("is idempotent", async () => {
    const { cancelTask } = await import("../src/daemon/spawn.js");
    const { createTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    cancelTask(task.id);
    const r = cancelTask(task.id);
    expect(r.task.status).toBe("cancelled");
    expect(r.killed_agents).toEqual([]);
    const cancels = listEvents(20).filter((e) => e.kind === "task.cancelled");
    expect(cancels.length).toBe(1);
  });

  it("cancelled tasks are never ready to spawn", async () => {
    const { cancelTask } = await import("../src/daemon/spawn.js");
    const { createTask, readyTasks } = await import("../src/db/tasks.js");
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    expect(readyTasks().map((t) => t.id)).toContain(task.id);
    cancelTask(task.id);
    expect(readyTasks().map((t) => t.id)).not.toContain(task.id);
  });

  it("reports open dependents that will never unblock", async () => {
    const { cancelTask } = await import("../src/daemon/spawn.js");
    const { createTask } = await import("../src/db/tasks.js");
    const blocker = createTask({ title: "b", prompt: "x", repo: "/r" });
    const dependent = createTask({
      title: "d",
      prompt: "x",
      repo: "/r",
      blocked_by: blocker.id,
    });
    const r = cancelTask(blocker.id);
    expect(r.open_dependents.map((t) => t.id)).toEqual([dependent.id]);
  });

  it("a verify finishing mid-cancel cannot resurrect the task", async () => {
    const { cancelTask } = await import("../src/daemon/spawn.js");
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { createTask, updateTask, getTask } = await import("../src/db/tasks.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    const task = createTask({
      title: "t",
      prompt: "x",
      repo: "/r",
      verify_cmd: "sleep 0.3", // passes, slowly
    });
    const worker = createAgent({ kind: "worker", state: "working", task_id: task.id });
    updateTask(task.id, {
      status: "in_progress",
      agent_id: worker.id,
      worktree: tmpDir,
    });

    const stop = handleHookEvent(worker.id, { hook_event_name: "Stop" });
    await new Promise((r) => setTimeout(r, 50)); // verify is now running
    cancelTask(task.id);
    await stop;

    expect(getTask(task.id)?.status).toBe("cancelled");
    expect(listEvents(20).map((e) => e.kind)).not.toContain("verify.passed");
  });

  it("retains an approved unpublished snapshot when cancelling without cleanup", async () => {
    const { cancelTask } = await import("../src/daemon/spawn.js");
    const { createTask, getTask, updateTask } = await import("../src/db/tasks.js");
    const task = createTask({
      title: "approved human work",
      prompt: "x",
      repo: "/repo",
      publication_mode: "human",
    });
    updateTask(task.id, {
      status: "review",
      worktree: "/retained/worktree",
      branch: `agent/task-${task.id}`,
      review_verdict: "approve",
      publication_state: "awaiting_human",
      review_snapshot_base: "a".repeat(40),
      review_snapshot_tree: "b".repeat(40),
    });

    const result = cancelTask(task.id);

    expect(result.task).toMatchObject({
      status: "cancelled",
      worktree: "/retained/worktree",
      review_snapshot_base: "a".repeat(40),
      review_snapshot_tree: "b".repeat(40),
    });
    expect(getTask(task.id)?.publication_state).toBe("awaiting_human");
  });

  it("refuses destructive cleanup of approved unpublished work without explicit discard", async () => {
    const { cancelTask, TaskCancellationValidationError } = await import(
      "../src/daemon/spawn.js"
    );
    const { createTask, getTask, updateTask } = await import("../src/db/tasks.js");
    const task = createTask({
      title: "approved human work",
      prompt: "x",
      repo: "/repo",
      publication_mode: "human",
    });
    updateTask(task.id, {
      status: "review",
      worktree: "/sole/copy",
      branch: `agent/task-${task.id}`,
      review_verdict: "approve",
      publication_state: "awaiting_human",
      review_snapshot_base: "a".repeat(40),
      review_snapshot_tree: "b".repeat(40),
    });

    expect(() => cancelTask(task.id, { rmWorktree: true })).toThrow(
      TaskCancellationValidationError,
    );
    expect(getTask(task.id)).toMatchObject({
      status: "review",
      worktree: "/sole/copy",
      review_snapshot_tree: "b".repeat(40),
    });
  });

  it("requires worktree cleanup when explicitly discarding unpublished work", async () => {
    const { cancelTask, TaskCancellationValidationError } = await import(
      "../src/daemon/spawn.js"
    );
    const { createTask } = await import("../src/db/tasks.js");
    const task = createTask({
      title: "approved human work",
      prompt: "x",
      repo: "/repo",
      publication_mode: "human",
    });

    expect(() =>
      cancelTask(task.id, { discardUnpublished: true }),
    ).toThrow(TaskCancellationValidationError);
  });

  it("discards approved unpublished state only when explicitly requested with cleanup", async () => {
    const { cancelTask } = await import("../src/daemon/spawn.js");
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const task = createTask({
      title: "discard approved human work",
      prompt: "x",
      repo: "/repo",
      publication_mode: "human",
    });
    updateTask(task.id, {
      status: "review",
      review_verdict: "approve",
      publication_state: "awaiting_human",
      review_snapshot_base: "a".repeat(40),
      review_snapshot_tree: "b".repeat(40),
    });

    const result = cancelTask(task.id, {
      rmWorktree: true,
      discardUnpublished: true,
    });

    expect(result.task).toMatchObject({
      status: "cancelled",
      worktree: null,
      review_snapshot_base: null,
      review_snapshot_tree: null,
    });
  });

  it("returns 409 before destructive API cleanup without explicit discard", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const { createTask, getTask, updateTask } = await import("../src/db/tasks.js");
    const task = createTask({
      title: "protected through API",
      prompt: "x",
      repo: "/repo",
      publication_mode: "human",
    });
    updateTask(task.id, {
      status: "review",
      worktree: "/sole/copy",
      review_verdict: "approve",
      publication_state: "awaiting_human",
      review_snapshot_base: "a".repeat(40),
      review_snapshot_tree: "b".repeat(40),
    });

    const response = await buildApp().request(`/api/tasks/${task.id}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rm_worktree: true }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error:
        "approved unpublished work would be lost; cancel without removing the worktree, or explicitly discard unpublished work",
    });
    expect(getTask(task.id)).toMatchObject({
      status: "review",
      worktree: "/sole/copy",
      review_snapshot_tree: "b".repeat(40),
    });
  });
});
