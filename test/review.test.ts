import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-"));
  process.env.CC_DATA_DIR = tmpDir;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A task in review with a (dead-window) worker agent attached. */
async function setupReviewTask(fields: { review_cycles?: number } = {}) {
  const { createTask, updateTask } = await import("../src/db/tasks.js");
  const { createAgent } = await import("../src/db/agents.js");
  const task = createTask({ title: "t", prompt: "x", repo: "/r" });
  const worker = createAgent({ kind: "worker", state: "idle", task_id: task.id });
  updateTask(task.id, {
    status: "review",
    agent_id: worker.id,
    branch: `agent/task-${task.id}`,
    result_summary: "claims done",
    review_cycles: fields.review_cycles ?? 0,
  });
  return { task, worker };
}

describe("handleVerdict", () => {
  it("approve flags the task and keeps it in review for the human", async () => {
    const { handleVerdict } = await import("../src/daemon/review.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { task } = await setupReviewTask();
    await handleVerdict(task.id, 99, "approve", "checked the diff, all good");
    const t = getTask(task.id)!;
    expect(t.status).toBe("review");
    expect(t.review_verdict).toBe("approve");
    expect(t.review_notes).toContain("all good");
    expect(listEvents(10).map((e) => e.kind)).toContain("review.approved");
  });

  it("reject with a dead worker requeues with notes and bumps the cycle", async () => {
    const { handleVerdict } = await import("../src/daemon/review.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { task } = await setupReviewTask();
    await handleVerdict(task.id, 99, "reject", "the retry test was deleted, not fixed");
    const t = getTask(task.id)!;
    expect(t.status).toBe("queued");
    expect(t.agent_id).toBeNull();
    expect(t.review_verdict).toBeNull(); // cleared: next review pass is fresh
    expect(t.review_notes).toContain("retry test");
    expect(t.review_cycles).toBe(1);
  });

  it("reject at the cycle cap blocks the task for the human", async () => {
    const { handleVerdict } = await import("../src/daemon/review.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { task } = await setupReviewTask({ review_cycles: 1 });
    await handleVerdict(task.id, 99, "reject", "still broken");
    const t = getTask(task.id)!;
    expect(t.status).toBe("blocked");
    expect(t.review_verdict).toBe("reject");
    expect(t.review_cycles).toBe(2);
    expect(listEvents(10).map((e) => e.kind)).toContain("review.escalated");
  });

  it("rejects a verdict for a task that is not in review", async () => {
    const { handleVerdict } = await import("../src/daemon/review.js");
    const { updateTask } = await import("../src/db/tasks.js");
    const { task } = await setupReviewTask();
    updateTask(task.id, { status: "in_progress" });
    await expect(handleVerdict(task.id, 99, "approve", "n")).rejects.toThrow(
      /not review/,
    );
  });

  it("rejected notes land in the respawned worker's prompt", async () => {
    const { handleVerdict } = await import("../src/daemon/review.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { _buildWorkerPromptForTest } = await import("../src/daemon/spawn.js");
    const { task } = await setupReviewTask();
    await handleVerdict(task.id, 99, "reject", "handle the empty-input case");
    const prompt = _buildWorkerPromptForTest(getTask(task.id)!, "agent/task-1");
    expect(prompt).toContain("REJECTED");
    expect(prompt).toContain("empty-input case");
  });
});

describe("maybeAutoReview", () => {
  it("attempts a reviewer for ANY task reaching review, manual included", async () => {
    const { maybeAutoReview } = await import("../src/daemon/review.js");
    const { listEvents } = await import("../src/db/events.js");
    const { task } = await setupReviewTask(); // manually created, never scheduler-spawned
    maybeAutoReview(task.id);
    // No real repo/tmux in tests — the attempt surfaces as spawn_error,
    // which proves the gate opened.
    const kinds = listEvents(10).map((e) => e.kind);
    expect(kinds).toContain("reviewer.spawn_error");
  });

  it("skips branches with no commits (report-only tasks)", async () => {
    const { execFileSync } = await import("node:child_process");
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a]);
    g("init", "-q");
    g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    g("branch", "agent/task-x"); // branch at HEAD, zero commits ahead

    const { maybeAutoReview } = await import("../src/daemon/review.js");
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const task = createTask({ title: "t", prompt: "x", repo });
    updateTask(task.id, { status: "review", branch: "agent/task-x" });
    maybeAutoReview(task.id);
    const kinds = listEvents(10).map((e) => e.kind);
    expect(kinds).not.toContain("reviewer.spawned");
    expect(kinds).not.toContain("reviewer.spawn_error");
  });

  it("respects the auto_review kill switch", async () => {
    const { maybeAutoReview } = await import("../src/daemon/review.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    const { logEvent, listEvents } = await import("../src/db/events.js");
    setSchedulerConfig({ auto_review: false });
    const { task } = await setupReviewTask();
    logEvent("scheduler.spawned", { taskId: task.id });
    maybeAutoReview(task.id);
    expect(listEvents(10).map((e) => e.kind)).not.toContain("reviewer.spawn_error");
  });

  it("stops at the daily spawn budget", async () => {
    const { maybeAutoReview } = await import("../src/daemon/review.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    const { logEvent, listEvents } = await import("../src/db/events.js");
    setSchedulerConfig({ daily_spawn_limit: 1 });
    const { task } = await setupReviewTask();
    logEvent("scheduler.spawned", { taskId: task.id });
    logEvent("reviewer.auto_spawned", { taskId: 999 });
    maybeAutoReview(task.id);
    const kinds = listEvents(10).map((e) => e.kind);
    expect(kinds).toContain("reviewer.budget_skipped");
    expect(kinds).not.toContain("reviewer.spawn_error");
  });

  it("gives up after the cycle cap", async () => {
    const { maybeAutoReview } = await import("../src/daemon/review.js");
    const { logEvent, listEvents } = await import("../src/db/events.js");
    const { task } = await setupReviewTask({ review_cycles: 2 });
    logEvent("scheduler.spawned", { taskId: task.id });
    maybeAutoReview(task.id);
    expect(listEvents(10).map((e) => e.kind)).not.toContain("reviewer.spawn_error");
  });
});

describe("verify bypass fix", () => {
  it("a worker moving its own task to review still gets verified", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { createTask, updateTask, getTask } = await import("../src/db/tasks.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    const task = createTask({
      title: "t",
      prompt: "x",
      repo: "/r",
      verify_cmd: "echo boom >&2; false",
    });
    const agent = createAgent({ kind: "worker", state: "working", task_id: task.id });
    // worker set status=review itself via update_my_task, skipping in_progress
    updateTask(task.id, { status: "review", agent_id: agent.id, worktree: tmpDir });
    await handleHookEvent(agent.id, { hook_event_name: "Stop" });
    expect(listEvents(20).map((e) => e.kind)).toContain("verify.failed");
    expect(getTask(task.id)?.status).toBe("blocked"); // no live window -> blocked
  });

  it("does not re-verify a task already verified this cycle", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { logEvent, countTaskEvents } = await import("../src/db/events.js");
    const task = createTask({ title: "t", prompt: "x", repo: "/r", verify_cmd: "true" });
    const agent = createAgent({ kind: "worker", state: "idle", task_id: task.id });
    updateTask(task.id, { status: "review", agent_id: agent.id, worktree: tmpDir });
    logEvent("verify.passed", { taskId: task.id, agentId: agent.id });
    await handleHookEvent(agent.id, { hook_event_name: "Stop" });
    expect(countTaskEvents(task.id, "verify.passed")).toBe(1); // unchanged
  });

  it("re-verifies when work resumed after the last pass (PR feedback cycle)", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { logEvent, countTaskEvents } = await import("../src/db/events.js");
    const task = createTask({ title: "t", prompt: "x", repo: "/r", verify_cmd: "true" });
    const agent = createAgent({ kind: "worker", state: "idle", task_id: task.id });
    updateTask(task.id, { status: "review", agent_id: agent.id, worktree: tmpDir });
    logEvent("verify.passed", { taskId: task.id, agentId: agent.id });
    // PR feedback (or a rejection) resumed the worker — the old pass is stale
    logEvent("task.reopened", { taskId: task.id });
    await handleHookEvent(agent.id, { hook_event_name: "Stop" });
    expect(countTaskEvents(task.id, "verify.passed")).toBe(2); // ran again
  });
});

describe("reviewer stop handling", () => {
  it("flags a reviewer that stopped without submitting a verdict", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    const { task } = { task: createTask({ title: "t", prompt: "x", repo: "/r" }) };
    updateTask(task.id, { status: "review" });
    const reviewer = createAgent({ kind: "reviewer", state: "working", task_id: task.id });
    await handleHookEvent(reviewer.id, { hook_event_name: "Stop" });
    expect(listEvents(10).map((e) => e.kind)).toContain("reviewer.stopped_incomplete");
  });

  it("reaps a reviewer that submitted its verdict", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const { logEvent } = await import("../src/db/events.js");
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    updateTask(task.id, { status: "review" });
    const reviewer = createAgent({ kind: "reviewer", state: "working", task_id: task.id });
    logEvent("review.approved", { taskId: task.id, agentId: reviewer.id });
    await handleHookEvent(reviewer.id, { hook_event_name: "Stop" });
    expect(getAgent(reviewer.id)?.state).toBe("dead");
  });
});
