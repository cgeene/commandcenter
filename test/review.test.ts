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
  const { _setGhRunner } = await import("../src/daemon/prdraft.js");
  _setGhRunner(null); // restore the real gh runner for the next file
});

/** A task in review with a (dead-window) worker agent attached. Defaults to a
 *  normal code task with an open PR — the merge-gated case. Pass open_pr:false
 *  (and no pr_url) for a doc-only task, which has no merge gate. */
async function setupReviewTask(
  fields: { review_cycles?: number; open_pr?: boolean; pr_url?: string | null } = {},
) {
  const { createTask, updateTask } = await import("../src/db/tasks.js");
  const { createAgent } = await import("../src/db/agents.js");
  const openPr = fields.open_pr ?? true;
  const task = createTask({ title: "t", prompt: "x", repo: "/r", open_pr: openPr });
  const worker = createAgent({ kind: "worker", state: "idle", task_id: task.id });
  const prUrl =
    fields.pr_url !== undefined
      ? fields.pr_url
      : openPr
        ? `https://github.com/x/y/pull/${task.id}`
        : null;
  updateTask(task.id, {
    status: "review",
    agent_id: worker.id,
    branch: `agent/task-${task.id}`,
    result_summary: "claims done",
    review_cycles: fields.review_cycles ?? 0,
    pr_url: prUrl,
  });
  return { task, worker };
}

describe("handleVerdict", () => {
  it("approve on an open-PR task keeps it in review for the human to merge", async () => {
    const { handleVerdict } = await import("../src/daemon/review.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { task } = await setupReviewTask(); // merge-gated: open_pr=true + pr_url
    await handleVerdict(task.id, 99, "approve", "checked the diff, all good");
    const t = getTask(task.id)!;
    expect(t.status).toBe("review"); // NOT auto-completed — waits for the merge
    expect(t.review_verdict).toBe("approve");
    expect(t.review_notes).toContain("all good");
    const kinds = listEvents(10).map((e) => e.kind);
    expect(kinds).toContain("review.approved");
    expect(kinds).not.toContain("task.autocompleted");
  });

  it("approve on a doc-only (open_pr=false) task auto-completes it", async () => {
    const { handleVerdict } = await import("../src/daemon/review.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { task } = await setupReviewTask({ open_pr: false }); // no merge gate
    await handleVerdict(task.id, 99, "approve", "doc reads well");
    const t = getTask(task.id)!;
    expect(t.status).toBe("done"); // approve IS completion — nothing to merge
    expect(t.review_verdict).toBe("approve");
    const kinds = listEvents(10).map((e) => e.kind);
    expect(kinds).toContain("task.autocompleted");
    expect(kinds).toContain("review.approved");
  });

  it("approve on a code task whose pr_url isn't recorded yet stays in review", async () => {
    const { handleVerdict } = await import("../src/daemon/review.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    // A worker can reach review with pr_url still null (open_pr=1). Auto-
    // completing here would strand real code on an unmerged branch — the gate
    // is open_pr===0 only, so this waits for the normal merge path instead.
    const { task } = await setupReviewTask({ open_pr: true, pr_url: null });
    await handleVerdict(task.id, 99, "approve", "looks complete");
    expect(getTask(task.id)?.status).toBe("review");
    expect(listEvents(10).map((e) => e.kind)).not.toContain("task.autocompleted");
  });

  it("doc-only auto-completion unblocks its dependents", async () => {
    const { handleVerdict } = await import("../src/daemon/review.js");
    const { createTask, readyTasks } = await import("../src/db/tasks.js");
    const { task } = await setupReviewTask({ open_pr: false });
    const dep = createTask({
      title: "dependent",
      prompt: "x",
      repo: "/r",
      blocked_by: task.id,
    });
    expect(readyTasks().map((t) => t.id)).not.toContain(dep.id); // blocked
    await handleVerdict(task.id, 99, "approve", "ok");
    expect(readyTasks().map((t) => t.id)).toContain(dep.id); // now ready
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

describe("handleVerdict — PR draft state", () => {
  /** A review task that also has an open PR in a given draft state. */
  async function setupPrReviewTask(
    prIsDraft: number | null,
    fields: { review_cycles?: number } = {},
  ) {
    const { updateTask } = await import("../src/db/tasks.js");
    const { task, worker } = await setupReviewTask(fields);
    updateTask(task.id, {
      pr_url: "https://github.com/nylas/repo/pull/7",
      pr_is_draft: prIsDraft,
    });
    return { task, worker };
  }

  it("approve flips the draft PR to ready and emits pr.marked_ready", async () => {
    const { _setGhRunner } = await import("../src/daemon/prdraft.js");
    const { handleVerdict } = await import("../src/daemon/review.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const calls: string[][] = [];
    _setGhRunner(async (args) => {
      calls.push(args);
      return args[1] === "view" ? "feat: do the thing" : "";
    });
    const { task } = await setupPrReviewTask(1);
    await handleVerdict(task.id, 99, "approve", "diff checks out");
    expect(calls.some((a) => a[0] === "pr" && a[1] === "ready" && a[2] !== "--undo")).toBe(true);
    expect(getTask(task.id)?.pr_is_draft).toBe(0);
    expect(listEvents(10).map((e) => e.kind)).toContain("pr.marked_ready");
  });

  it("approve strips an [UNREVIEWED] title prefix from the fallback path", async () => {
    const { _setGhRunner } = await import("../src/daemon/prdraft.js");
    const { handleVerdict } = await import("../src/daemon/review.js");
    const calls: string[][] = [];
    _setGhRunner(async (args) => {
      calls.push(args);
      return args[1] === "view" ? "[UNREVIEWED] feat: do the thing" : "";
    });
    const { task } = await setupPrReviewTask(1);
    await handleVerdict(task.id, 99, "approve", "ok");
    const edit = calls.find((a) => a[1] === "edit");
    expect(edit).toBeDefined();
    expect(edit).toContain("feat: do the thing");
    expect(edit?.join(" ")).not.toContain("[UNREVIEWED]");
  });

  it("approve surfaces a failed ready-flip loudly instead of silently", async () => {
    const { _setGhRunner } = await import("../src/daemon/prdraft.js");
    const { handleVerdict } = await import("../src/daemon/review.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    _setGhRunner(async () => {
      throw new Error("draft PRs not supported on this plan");
    });
    const { task } = await setupPrReviewTask(1);
    await handleVerdict(task.id, 99, "approve", "ok");
    const t = getTask(task.id)!;
    expect(t.review_verdict).toBe("approve"); // approval still recorded
    expect(t.pr_is_draft).toBe(1); // stayed draft — the flip failed
    expect(listEvents(10).map((e) => e.kind)).toContain("pr.ready_failed");
  });

  it("reject re-drafts a PR that is currently ready", async () => {
    const { _setGhRunner } = await import("../src/daemon/prdraft.js");
    const { handleVerdict } = await import("../src/daemon/review.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const calls: string[][] = [];
    _setGhRunner(async (args) => {
      calls.push(args);
      return "";
    });
    const { task } = await setupPrReviewTask(0); // currently ready
    await handleVerdict(task.id, 99, "reject", "the retry test is missing");
    expect(calls.some((a) => a[1] === "ready" && a[2] === "--undo")).toBe(true);
    expect(getTask(task.id)?.pr_is_draft).toBe(1);
    expect(listEvents(20).map((e) => e.kind)).toContain("pr.redrafted");
  });

  it("reject does NOT touch a PR that is already a draft", async () => {
    const { _setGhRunner } = await import("../src/daemon/prdraft.js");
    const { handleVerdict } = await import("../src/daemon/review.js");
    const { listEvents } = await import("../src/db/events.js");
    const calls: string[][] = [];
    _setGhRunner(async (args) => {
      calls.push(args);
      return "";
    });
    const { task } = await setupPrReviewTask(1); // already a draft
    await handleVerdict(task.id, 99, "reject", "still broken");
    expect(calls).toHaveLength(0); // no gh call at all
    expect(listEvents(20).map((e) => e.kind)).not.toContain("pr.redrafted");
  });

  it("reject leaves a never-synced (unknown draft state) PR alone", async () => {
    const { _setGhRunner } = await import("../src/daemon/prdraft.js");
    const { handleVerdict } = await import("../src/daemon/review.js");
    const calls: string[][] = [];
    _setGhRunner(async (args) => {
      calls.push(args);
      return "";
    });
    const { task } = await setupPrReviewTask(null); // unknown
    await handleVerdict(task.id, 99, "reject", "nope");
    expect(calls).toHaveLength(0);
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

describe("open_pr prompt wiring", () => {
  it("worker prompt tells a branch-only task not to open a PR", async () => {
    const { _buildWorkerPromptForTest } = await import("../src/daemon/spawn.js");
    const { createTask } = await import("../src/db/tasks.js");
    const task = createTask({ title: "t", prompt: "x", repo: "/r", open_pr: false });
    const prompt = _buildWorkerPromptForTest(task, "agent/task-1");
    expect(prompt).toContain("Do NOT open a PR");
    expect(prompt).not.toContain("gh pr create");
  });

  it("worker prompt tells a normal task to open a PR", async () => {
    const { _buildWorkerPromptForTest } = await import("../src/daemon/spawn.js");
    const { createTask } = await import("../src/db/tasks.js");
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    const prompt = _buildWorkerPromptForTest(task, "agent/task-1");
    expect(prompt).toContain("gh pr create");
    expect(prompt).not.toContain("Do NOT open a PR");
  });

  it("worker prompt opens the PR as a draft with a fallback", async () => {
    const { _buildWorkerPromptForTest } = await import("../src/daemon/spawn.js");
    const { createTask } = await import("../src/db/tasks.js");
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    const prompt = _buildWorkerPromptForTest(task, "agent/task-1");
    expect(prompt).toContain("gh pr create --draft");
    // graceful fallback: normal PR + [UNREVIEWED] prefix when drafts unsupported
    expect(prompt).toContain("[UNREVIEWED]");
    // fix-round instruction: don't touch draft/ready state of an existing PR
    expect(prompt).toContain("leave its draft/ready state");
    // workers must not run gh pr ready themselves — the platform owns it
    expect(prompt).toContain("Do NOT run `gh pr ready`");
  });

  it("resume prompt tells a normal task to keep new PRs draft and leave existing state alone", async () => {
    const { _buildResumePromptForTest } = await import("../src/daemon/spawn.js");
    const { createTask } = await import("../src/db/tasks.js");
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    const prompt = _buildResumePromptForTest(task);
    expect(prompt).toContain("gh pr create --draft");
    expect(prompt).toContain("leave its draft/ready state");
  });

  it("resume prompt carries the branch-only instruction too", async () => {
    const { _buildResumePromptForTest } = await import("../src/daemon/spawn.js");
    const { createTask } = await import("../src/db/tasks.js");
    const task = createTask({ title: "t", prompt: "x", repo: "/r", open_pr: false });
    const prompt = _buildResumePromptForTest(task);
    expect(prompt).toContain("Do NOT open a PR");
  });

  it("reviewer prompt states a missing PR is not a defect for branch-only tasks", async () => {
    const { buildReviewerPrompt } = await import("../src/prompts/reviewer.js");
    const { createTask } = await import("../src/db/tasks.js");
    const task = createTask({ title: "t", prompt: "x", repo: "/r", open_pr: false });
    const prompt = buildReviewerPrompt(task);
    expect(prompt).toContain("BRANCH-ONLY");
    expect(prompt).toContain("A missing PR is NOT a defect");
  });

  it("reviewer prompt states a PR is expected for normal tasks", async () => {
    const { buildReviewerPrompt } = await import("../src/prompts/reviewer.js");
    const { createTask } = await import("../src/db/tasks.js");
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    const prompt = buildReviewerPrompt(task);
    expect(prompt).toContain("This task expects a PR");
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
