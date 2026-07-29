import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A few tests here shell out to real git; those have been measured at 3s+
// under full-suite parallel load, uncomfortably close to the 5s default.
// Same budget as the other git-touching test files.
vi.setConfig({ testTimeout: 30_000 });

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
  // The git work in these tests is synchronous, so this worker's event loop
  // can sit blocked for tens of seconds at a time. Node runs the timers phase
  // before the poll phase, so vitest's fixed 60s worker->main RPC timer can
  // fire on a reply that was already delivered but not yet read, failing the
  // run with 'Timeout calling "onTaskUpdate"'. Yield a macrotask so those
  // replies get drained between tests.
  await new Promise((resolve) => setImmediate(resolve));
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
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    const { listEvents } = await import("../src/db/events.js");
    setSchedulerConfig({ review_max_cycles: 2 }); // cap at 2 for this case
    const { task } = await setupReviewTask({ review_cycles: 1 });
    await handleVerdict(task.id, 99, "reject", "still broken");
    const t = getTask(task.id)!;
    expect(t.status).toBe("blocked");
    expect(t.review_verdict).toBe("reject");
    expect(t.review_cycles).toBe(2);
    // the loop-exhausted escalation replaces the old hard block-at-2
    expect(listEvents(10).map((e) => e.kind)).toContain("review.loop_exhausted");
  });

  it("a 2nd rejection below the cap keeps the loop going instead of blocking", async () => {
    const { handleVerdict } = await import("../src/daemon/review.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    setSchedulerConfig({ review_max_cycles: 4 }); // default — a converging loop
    const { task } = await setupReviewTask({ review_cycles: 1 });
    // dead worker -> requeue with notes, NOT block (old behavior blocked here)
    await handleVerdict(task.id, 99, "reject", "still needs work");
    const t = getTask(task.id)!;
    expect(t.status).toBe("queued");
    expect(t.review_cycles).toBe(2);
    expect(t.review_verdict).toBeNull();
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

  // --- a verdict reached while the task was auto-blocked underneath it ------
  // The reviewer spends minutes on a round; the cycle cap or a repeatedly
  // failing verify_cmd can block the task in that window. Discarding a
  // completed review because of it wastes the whole round.

  /** A blocked task with the reviewer that is still judging it alive. `cause`
   *  picks which gate blocked it: the review loop's own cap (which an approve
   *  may lift) or a repeatedly-failing verify_cmd (which it may not). */
  async function setupBlockedWithLiveReviewer(
    fields: Parameters<typeof setupReviewTask>[0] & {
      cause?: "cap" | "verify";
    } = {},
  ) {
    const { createAgent } = await import("../src/db/agents.js");
    const { updateTask } = await import("../src/db/tasks.js");
    const { logEvent } = await import("../src/db/events.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    // Rounds genuinely used up: half of what makes a cap block restorable.
    setSchedulerConfig({ review_max_cycles: 2 });
    const { task, worker } = await setupReviewTask({
      review_cycles: 2,
      ...fields,
    });
    const reviewer = createAgent({
      kind: "reviewer",
      state: "working",
      task_id: task.id,
    });
    updateTask(task.id, { status: "blocked" });
    logEvent(
      (fields.cause ?? "cap") === "verify" ? "task.blocked" : "review.loop_exhausted",
      { taskId: task.id },
    );
    return { task, worker, reviewer };
  }

  it("a live reviewer's approve is accepted while the task sits blocked", async () => {
    const { handleVerdict } = await import("../src/daemon/review.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { task, reviewer } = await setupBlockedWithLiveReviewer({
      review_cycles: 2,
    });
    await handleVerdict(task.id, reviewer.id, "approve", "verified end to end");
    const t = getTask(task.id)!;
    expect(t.review_verdict).toBe("approve");
    expect(t.review_notes).toContain("verified end to end");
    // status re-derived from the verdict: back to review for the merge gate
    expect(t.status).toBe("review");
    const kinds = listEvents(20).map((e) => e.kind);
    expect(kinds).toContain("review.approved");
    expect(kinds).toContain("review.verdict_accepted_while_blocked");
  });

  it("an approve accepted while blocked completes a doc-only task", async () => {
    const { handleVerdict } = await import("../src/daemon/review.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { task, reviewer } = await setupBlockedWithLiveReviewer({
      open_pr: false,
    });
    await handleVerdict(task.id, reviewer.id, "approve", "doc is accurate");
    expect(getTask(task.id)?.status).toBe("done");
  });

  it("a reject accepted while blocked is recorded but leaves the block standing", async () => {
    const { handleVerdict } = await import("../src/daemon/review.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    const { task, reviewer } = await setupBlockedWithLiveReviewer({
      review_cycles: 1,
    });
    setSchedulerConfig({ review_max_cycles: 6 }); // still below the cap
    await handleVerdict(task.id, reviewer.id, "reject", "the fix is incomplete");
    const t = getTask(task.id)!;
    // NOT resurrected into in_progress/queued — whatever blocked it still holds
    expect(t.status).toBe("blocked");
    expect(t.review_verdict).toBe("reject");
    expect(t.review_notes).toContain("incomplete");
    expect(t.review_cycles).toBe(2);
  });

  it("an approve does NOT restore a task whose rounds are not actually used up", async () => {
    const { handleVerdict } = await import("../src/daemon/review.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    // A stale review.loop_exhausted from an earlier episode must not be enough
    // on its own — the durable round count has to agree.
    const { task, reviewer } = await setupBlockedWithLiveReviewer();
    setSchedulerConfig({ review_max_cycles: 6 });
    await handleVerdict(task.id, reviewer.id, "approve", "looks fine");
    expect(getTask(task.id)!.status).toBe("blocked");
    expect(getTask(task.id)!.review_verdict).toBe("approve"); // still recorded
  });

  // Merge safety: an approve says the DIFF is good. It says nothing about a
  // verify_cmd that keeps failing, so it must not lift that block, must not
  // take the PR out of draft, and must not push "ready to merge".
  it("an approve does NOT clear a verify-caused block or ready the PR", async () => {
    const { handleVerdict } = await import("../src/daemon/review.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { _setGhRunner } = await import("../src/daemon/prdraft.js");
    const gh = vi.fn(() => "");
    _setGhRunner(gh); // any gh call at all would be a failure here
    const { task, reviewer } = await setupBlockedWithLiveReviewer({
      cause: "verify",
    });
    await handleVerdict(task.id, reviewer.id, "approve", "the diff itself is fine");

    const t = getTask(task.id)!;
    expect(t.status).toBe("blocked"); // the mechanical gate still holds
    expect(t.review_verdict).toBe("approve"); // but the round is NOT lost
    expect(t.review_notes).toContain("diff itself is fine");
    expect(t.pr_is_draft).not.toBe(0); // never flipped to ready
    expect(gh).not.toHaveBeenCalled();
    const kinds = listEvents(30).map((e) => e.kind);
    expect(kinds).toContain("review.approved_block_kept");
    expect(kinds).not.toContain("pr.marked_ready");
    const pushes = listEvents(30).filter((e) => e.kind === "notify.pushed");
    expect(pushes.map((e) => e.payload ?? "").join()).not.toContain(
      "review_approved_ready",
    );
  });

  // The dangerous shape: the PR is ALREADY out of draft from an earlier
  // approve, so nothing about draft state protects us. prsync re-derives the
  // ready-to-merge push from standing state on every poll, so an approve
  // verdict on a blocked task would otherwise announce a branch whose
  // verification still fails as mergeable.
  it("an approve on a verify-blocked task with a READY PR never announces it mergeable", async () => {
    const { handleVerdict, notifyApprovedReady } = await import(
      "../src/daemon/review.js"
    );
    const { getTask, updateTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { task, reviewer } = await setupBlockedWithLiveReviewer({
      cause: "verify",
    });
    updateTask(task.id, { pr_is_draft: 0 }); // left ready by an earlier round
    const shaBefore = getTask(task.id)!.review_head_sha;

    await handleVerdict(task.id, reviewer.id, "approve", "diff is fine");

    const t = getTask(task.id)!;
    expect(t.status).toBe("blocked");
    expect(t.review_verdict).toBe("approve"); // verdict kept
    // The approval covers no announceable SHA: advancing it would mint a fresh
    // latch key and make the stale approval look current after an unblock.
    expect(t.review_head_sha).toBe(shaBefore);
    // The standing-state push prsync makes every poll must stay silent.
    notifyApprovedReady(t);
    const pushed = listEvents(40)
      .filter((e) => e.kind === "notify.pushed")
      .map((e) => e.payload ?? "")
      .join();
    expect(pushed).not.toContain("review_approved_ready");
  });

  it("suppressing the ready push leaves the latch free for when the block clears", async () => {
    const { notifyApprovedReady, approvedReadyLatchKey } = await import(
      "../src/daemon/review.js"
    );
    const { getTask, updateTask } = await import("../src/db/tasks.js");
    const { setNotificationSettings } = await import("../src/db/settings.js");
    const { notifyLatched } = await import("../src/db/notifylatch.js");
    // A push has to actually be dispatchable, or "the latch stayed free" would
    // hold for the wrong reason. Nothing leaves the process.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
    try {
      setNotificationSettings({ ntfy_url: "http://127.0.0.1:9/sink" });
      const { task } = await setupReviewTask();
      updateTask(task.id, {
        status: "blocked",
        review_verdict: "approve",
        review_head_sha: "abc123",
        pr_is_draft: 0,
      });
      const key = approvedReadyLatchKey(task.id, "abc123");

      notifyApprovedReady(getTask(task.id)!); // suppressed: task is blocked
      expect(notifyLatched(key)).toBe(false);

      // Block cleared by a human — the same standing state must now push,
      // which it can only do if the suppression never consumed the latch.
      updateTask(task.id, { status: "review" });
      notifyApprovedReady(getTask(task.id)!);
      expect(notifyLatched(key)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("an approve does NOT auto-complete a doc-only task blocked for verification", async () => {
    const { handleVerdict } = await import("../src/daemon/review.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { task, reviewer } = await setupBlockedWithLiveReviewer({
      open_pr: false,
      cause: "verify",
    });
    await handleVerdict(task.id, reviewer.id, "approve", "doc reads fine");
    expect(getTask(task.id)!.status).toBe("blocked"); // NOT done
    expect(getTask(task.id)!.review_verdict).toBe("approve");
  });

  it("a task re-blocked by the cap after a verify block is restorable again", async () => {
    const { handleVerdict } = await import("../src/daemon/review.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { logEvent } = await import("../src/db/events.js");
    const { task, reviewer } = await setupBlockedWithLiveReviewer({
      cause: "verify",
    });
    // Verification was fixed and the loop later exhausted its rounds — the
    // most recent gate is the cap, which an approve may lift.
    logEvent("review.loop_exhausted", { taskId: task.id });
    await handleVerdict(task.id, reviewer.id, "approve", "all good now");
    expect(getTask(task.id)!.status).toBe("review");
  });

  it("a dead reviewer's verdict on a blocked task is still refused, loudly", async () => {
    const { handleVerdict } = await import("../src/daemon/review.js");
    const { updateAgent } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    const { task, reviewer } = await setupBlockedWithLiveReviewer();
    updateAgent(reviewer.id, { state: "dead" });
    await expect(
      handleVerdict(task.id, reviewer.id, "approve", "n"),
    ).rejects.toThrow(/blocked/);
    expect(listEvents(20).map((e) => e.kind)).toContain(
      "review.verdict_unsubmittable",
    );
  });

  it("a refused verdict names the real status instead of failing opaquely", async () => {
    const { handleVerdict, ReviewStateError } = await import(
      "../src/daemon/review.js"
    );
    const { updateTask } = await import("../src/db/tasks.js");
    const { task } = await setupReviewTask();
    updateTask(task.id, { status: "cancelled" });
    const err = await handleVerdict(task.id, 99, "approve", "n").catch((e) => e);
    expect(err).toBeInstanceOf(ReviewStateError);
    expect(err.taskStatus).toBe("cancelled");
    expect(err.expectedStatus).toBe("review");
    expect(err.message).toMatch(/cancelled/);
    expect(err.message).toMatch(/review/);
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

  // Task #107 safety invariant: after the scheduler early-reaps an
  // approved-awaiting-merge worker, a post-approve rejection (verdict
  // supersession on a new push) must still recover. The reaped worker is dead
  // but task.agent_id stays set, so applyVerdict's reject branch calls
  // resumeAgent, gets "not_live", and requeues the task (status=queued,
  // agent_id=null) with the notes folded in — the respawn then resumes the
  // persisted session via task.session_id.
  it("a post-approve rejection recovers a reaped (dead) worker via requeue + session-resume", async () => {
    const { handleVerdict } = await import("../src/daemon/review.js");
    const { getTask, updateTask } = await import("../src/db/tasks.js");
    const { updateAgent } = await import("../src/db/agents.js");
    const { _buildWorkerPromptForTest } = await import("../src/daemon/spawn.js");
    const { task, worker } = await setupReviewTask();
    // The worker was approved, then early-reaped: dead window, but agent_id and
    // the resumable session persist on the task.
    updateTask(task.id, { review_verdict: "approve", session_id: "sess-abc" });
    updateAgent(worker.id, { state: "dead", tmux_target: null });

    await handleVerdict(task.id, 99, "reject", "the added guard regressed the happy path");

    const t = getTask(task.id)!;
    expect(t.status).toBe("queued"); // resumeAgent -> not_live -> requeue
    expect(t.agent_id).toBeNull();
    expect(t.review_verdict).toBeNull();
    expect(t.review_notes).toContain("regressed the happy path");
    expect(t.session_id).toBe("sess-abc"); // session preserved for the respawn resume
    const prompt = _buildWorkerPromptForTest(t, `agent/task-${task.id}`);
    expect(prompt).toContain("REJECTED");
    expect(prompt).toContain("happy path");
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
    await maybeAutoReview(task.id);
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
    await maybeAutoReview(task.id);
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
    await maybeAutoReview(task.id);
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
    await maybeAutoReview(task.id);
    const kinds = listEvents(10).map((e) => e.kind);
    expect(kinds).toContain("reviewer.budget_skipped");
    expect(kinds).not.toContain("reviewer.spawn_error");
  });

  it("gives up at the cycle cap — blocks + emits review.loop_exhausted", async () => {
    const { maybeAutoReview } = await import("../src/daemon/review.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { logEvent, listEvents } = await import("../src/db/events.js");
    setSchedulerConfig({ review_max_cycles: 2 });
    const { task } = await setupReviewTask({ review_cycles: 2 });
    logEvent("scheduler.spawned", { taskId: task.id });
    await maybeAutoReview(task.id);
    const kinds = listEvents(10).map((e) => e.kind);
    expect(kinds).not.toContain("reviewer.spawn_error"); // no reviewer spawned
    expect(kinds).toContain("review.loop_exhausted");
    expect(getTask(task.id)?.status).toBe("blocked");
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

describe("prompt wiring", () => {
  /** The three task shapes whose prompts differ, and the builders under test. */
  async function build(kind: "repo" | "branch-only" | "scratch") {
    const { _buildWorkerPromptForTest, _buildResumePromptForTest } = await import(
      "../src/daemon/spawn.js"
    );
    const { buildReviewerPrompt } = await import("../src/prompts/reviewer.js");
    const { createTask } = await import("../src/db/tasks.js");
    const task =
      kind === "scratch"
        ? createTask({
            title: "investigate",
            prompt: "inspect Kubernetes",
            repo: "/scratch/task-ABC123",
            workspace_kind: "scratch",
            open_pr: false,
          })
        : createTask({
            title: "t",
            prompt: "x",
            repo: "/r",
            open_pr: kind !== "branch-only",
          });
    const branch = kind === "scratch" ? null : "agent/task-1";
    return {
      task,
      worker: _buildWorkerPromptForTest(task, branch),
      resume: _buildResumePromptForTest(task),
      reviewer: buildReviewerPrompt(task),
    };
  }

  // Standing instructions every worker gets, whatever the task shape. Asserted
  // per row rather than once, so a regression that drops them from only the
  // scratch path (the shape with its own prompt branch) still fails.
  const STANDING_WORKER = [
    "something the code cannot show",
    "Never write narrative what-this-does comments",
    "provenance belongs in the commit message",
    "re-read every factual statement",
    '"verified/provisioned/live/deployed" claim',
    "an earlier draft, an intention, or another branch",
    "Never control Command Center's terminal infrastructure",
    "do not invoke tmux kill/respawn/send-keys",
  ];

  it.each([
    {
      why: "a normal repo task's worker prompt",
      kind: "repo" as const,
      which: "worker" as const,
      contains: [
        ...STANDING_WORKER,
        "gh pr create --draft",
        "[UNREVIEWED]", // fallback when drafts are unsupported
        "leave its draft/ready state", // fix rounds must not re-draft
        "Do NOT run `gh pr ready`", // the platform owns draft/ready
        "human engineers", // PR body audience
        "--body-file", // avoids inline shell-escaping bugs
        "any decision that needs human attention",
        "<!-- commandcenter task #{id} -->", // invisible traceability trailer
      ],
      absent: ["Do NOT open a PR", 'ending with "commandcenter task #'],
    },
    {
      why: "a branch-only task's worker prompt",
      kind: "branch-only" as const,
      which: "worker" as const,
      contains: [...STANDING_WORKER, "Do NOT open a PR"],
      absent: ["gh pr create"],
    },
    {
      why: "a scratch task's worker prompt",
      kind: "scratch" as const,
      which: "worker" as const,
      contains: [
        ...STANDING_WORKER,
        "not a Git repository",
        "Do not initialize Git",
        "Prefer read-only inspection",
      ],
      absent: ["git push -u origin"],
    },
    {
      why: "a normal repo task's resume prompt",
      kind: "repo" as const,
      which: "resume" as const,
      contains: [
        "gh pr create --draft",
        "leave its draft/ready state",
        "--body-file",
        "<!-- commandcenter task #{id} -->",
      ],
      absent: [],
    },
    {
      why: "a branch-only task's resume prompt",
      kind: "branch-only" as const,
      which: "resume" as const,
      contains: ["Do NOT open a PR"],
      absent: [],
    },
    {
      why: "a normal repo task's reviewer prompt",
      kind: "repo" as const,
      which: "reviewer" as const,
      contains: [
        "This task expects a PR",
        "run relevant tests, builds, typechecks",
        "do not invoke tmux kill/respawn/send-keys",
      ],
      absent: [],
    },
    {
      why: "a branch-only task's reviewer prompt",
      kind: "branch-only" as const,
      which: "reviewer" as const,
      contains: ["BRANCH-ONLY", "A missing PR is NOT a defect"],
      absent: [],
    },
  ])("$why says what it must", async ({ kind, which, contains, absent }) => {
    const built = await build(kind);
    const prompt = built[which];
    for (const needle of contains) {
      expect(prompt, needle).toContain(needle.replace("{id}", String(built.task.id)));
    }
    for (const needle of absent) {
      expect(prompt, needle).not.toContain(needle);
    }
  });

  it("does not grant a scratch worker the PR-creation permission", async () => {
    const { _buildWorkerAllowForTest } = await import("../src/daemon/spawn.js");
    expect(_buildWorkerAllowForTest(null)).not.toContain("Bash(gh pr create*)");
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
