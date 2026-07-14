import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PrState } from "../src/daemon/prsync.js";

vi.mock("../src/daemon/tmux.js", () => ({
  windowExists: () => true,
  sendText: async () => {},
  capturePane: () => "",
}));

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-prsync-"));
  process.env.CC_DATA_DIR = tmpDir;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function setupPrTask() {
  const { createTask, updateTask } = await import("../src/db/tasks.js");
  const { createAgent } = await import("../src/db/agents.js");
  const task = createTask({ title: "t", prompt: "x", repo: "/r" });
  const worker = createAgent({ kind: "worker", state: "idle", task_id: task.id });
  updateTask(task.id, {
    status: "review",
    agent_id: worker.id,
    branch: `agent/task-${task.id}`,
    pr_url: "https://github.com/nylas/unicorn-k8s/pull/2198",
  });
  return { task, worker };
}

const open = (over: Partial<PrState> = {}): PrState => ({
  state: "OPEN",
  reviewDecision: null,
  comments: [],
  ...over,
});

describe("parsePrUrl", () => {
  it("parses a GitHub PR url", async () => {
    const { parsePrUrl } = await import("../src/daemon/prsync.js");
    expect(parsePrUrl("https://github.com/nylas/unicorn-k8s/pull/2198")).toEqual({
      owner: "nylas",
      repo: "unicorn-k8s",
      number: 2198,
    });
    expect(parsePrUrl("https://gitlab.com/x/y/pull/1")).toBeUndefined();
  });
});

describe("applyPrState", () => {
  it("merged approved PR auto-completes the task and unblocks dependents", async () => {
    const { applyPrState } = await import("../src/daemon/prsync.js");
    const { getTask, updateTask, createTask, readyTasks } = await import(
      "../src/db/tasks.js"
    );
    const { listEvents } = await import("../src/db/events.js");
    const { task } = await setupPrTask();
    updateTask(task.id, { review_verdict: "approve" });
    const dep = createTask({
      title: "dependent",
      prompt: "x",
      repo: "/r",
      blocked_by: task.id,
    });
    expect(readyTasks().map((t) => t.id)).not.toContain(dep.id); // gated on task
    await applyPrState(task.id, open({ state: "MERGED" }));
    expect(getTask(task.id)?.status).toBe("done");
    const kinds = listEvents(10).map((e) => e.kind);
    expect(kinds).toContain("task.autocompleted");
    expect(kinds).not.toContain("pr.merged"); // superseded by task.autocompleted
    expect(readyTasks().map((t) => t.id)).toContain(dep.id); // dependent freed
  });

  it("merged PR still auto-completes an un-reviewed task (verdict=null)", async () => {
    const { applyPrState } = await import("../src/daemon/prsync.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { task } = await setupPrTask(); // no verdict recorded
    await applyPrState(task.id, open({ state: "MERGED" }));
    expect(getTask(task.id)?.status).toBe("done");
  });

  it("never auto-completes a rejected task whose PR a human merged deliberately", async () => {
    const { applyPrState } = await import("../src/daemon/prsync.js");
    const { getTask, updateTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { task } = await setupPrTask();
    updateTask(task.id, { review_verdict: "reject" });
    await applyPrState(task.id, open({ state: "MERGED" }));
    const t = getTask(task.id)!;
    expect(t.status).toBe("review"); // left for the orchestrator/human to resolve
    const kinds = listEvents(10).map((e) => e.kind);
    expect(kinds).not.toContain("task.autocompleted");
    expect(kinds).toContain("pr.merged"); // merge recorded for the audit trail
  });

  it("never auto-completes a task that burned through its review cycles", async () => {
    const { applyPrState } = await import("../src/daemon/prsync.js");
    const { getTask, updateTask } = await import("../src/db/tasks.js");
    const { MAX_REVIEW_CYCLES } = await import("../src/daemon/review.js");
    const { task } = await setupPrTask();
    updateTask(task.id, { review_cycles: MAX_REVIEW_CYCLES });
    await applyPrState(task.id, open({ state: "MERGED" }));
    expect(getTask(task.id)?.status).toBe("review");
  });

  it("closed-unmerged PR blocks the task and reaps its worker", async () => {
    const { applyPrState } = await import("../src/daemon/prsync.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { getAgent } = await import("../src/db/agents.js");
    const { task, worker } = await setupPrTask();
    await applyPrState(task.id, open({ state: "CLOSED" }));
    const t = getTask(task.id)!;
    expect(t.status).toBe("blocked");
    expect(t.review_notes).toContain("closed without merging");
    // an idle worker on a blocked task would occupy scheduler capacity forever
    expect(getAgent(worker.id)?.state).toBe("dead");
  });

  it("new comments requeue a dead worker's task with the feedback as notes", async () => {
    const { applyPrState } = await import("../src/daemon/prsync.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { task } = await setupPrTask();
    await applyPrState(
      task.id,
      open({
        comments: [
          { author: "caleb", body: "use a data source here", created_at: "2026-07-04T02:00:00Z" },
        ],
      }),
    );
    const t = getTask(task.id)!;
    expect(t.status).toBe("queued");
    expect(t.review_notes).toContain("use a data source here");
    expect(t.pr_feedback_at).toBe("2026-07-04T02:00:00Z");
  });

  // --- PR review classification (task #84): an approval is not feedback ---

  it("a bare human approval never re-queues and preserves the internal notes", async () => {
    const { applyPrState } = await import("../src/daemon/prsync.js");
    const { getTask, updateTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { task } = await setupPrTask();
    // internal reviewer's evidence that must survive
    updateTask(task.id, { review_notes: "internal reviewer: verified, approve" });
    await applyPrState(
      task.id,
      open({
        reviewDecision: "APPROVED",
        reviews: [
          {
            author: "twongkeeny",
            body: "approve",
            state: "APPROVED",
            created_at: "2026-07-14T16:59:00Z",
          },
        ],
      }),
    );
    const t = getTask(task.id)!;
    expect(t.status).toBe("review"); // NOT re-queued
    expect(t.pr_feedback_at).toBeNull(); // watermark untouched
    expect(t.review_notes).toBe("internal reviewer: verified, approve"); // NOT clobbered
    expect(t.human_approved_at).toBe("2026-07-14T16:59:00Z"); // signal recorded
    const kinds = listEvents(10).map((e) => e.kind);
    expect(kinds).toContain("pr.human_approved");
    expect(kinds).not.toContain("task.requeued");
    expect(kinds).not.toContain("pr.feedback");
  });

  it("an empty-body APPROVED/COMMENTED review is not feedback and is not re-logged each pass", async () => {
    const { applyPrState } = await import("../src/daemon/prsync.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { task } = await setupPrTask();
    const state = open({
      reviewDecision: "APPROVED",
      reviews: [
        { author: "twongkeeny", body: "", state: "APPROVED", created_at: "2026-07-14T16:59:00Z" },
        { author: "bob", body: "   ", state: "COMMENTED", created_at: "2026-07-14T16:58:00Z" },
      ],
    });
    await applyPrState(task.id, state);
    expect(getTask(task.id)?.status).toBe("review");
    await applyPrState(task.id, state); // second pass: same approval, still "fresh"
    // recorded exactly once — no every-2min event spam
    const approved = listEvents(20).map((e) => e.kind).filter((k) => k === "pr.human_approved");
    expect(approved).toHaveLength(1);
  });

  it("an APPROVED review WITH a change request in its body DOES re-queue", async () => {
    const { applyPrState } = await import("../src/daemon/prsync.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { task } = await setupPrTask();
    await applyPrState(
      task.id,
      open({
        reviewDecision: "APPROVED",
        reviews: [
          {
            author: "twongkeeny",
            body: "approve, but please rename the helper",
            state: "APPROVED",
            created_at: "2026-07-14T17:00:00Z",
          },
        ],
      }),
    );
    const t = getTask(task.id)!;
    expect(t.status).toBe("queued");
    expect(t.review_notes).toContain("rename the helper");
    expect(t.pr_feedback_at).toBe("2026-07-14T17:00:00Z");
  });

  it("a CHANGES_REQUESTED review re-queues even with an empty body, appending to notes", async () => {
    const { applyPrState } = await import("../src/daemon/prsync.js");
    const { getTask, updateTask } = await import("../src/db/tasks.js");
    const { task } = await setupPrTask();
    updateTask(task.id, { review_notes: "prior internal evidence" });
    await applyPrState(
      task.id,
      open({
        reviewDecision: "CHANGES_REQUESTED",
        reviews: [
          { author: "twongkeeny", body: "", state: "CHANGES_REQUESTED", created_at: "2026-07-14T17:05:00Z" },
        ],
      }),
    );
    const t = getTask(task.id)!;
    expect(t.status).toBe("queued");
    expect(t.review_notes).toContain("prior internal evidence"); // preserved
    expect(t.review_notes).toContain("CHANGES REQUESTED"); // appended
    expect(t.pr_feedback_at).toBe("2026-07-14T17:05:00Z");
  });

  it("a mixed batch (approval + a real comment) re-queues on the comment and still records the approval", async () => {
    const { applyPrState } = await import("../src/daemon/prsync.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { task } = await setupPrTask();
    await applyPrState(
      task.id,
      open({
        reviewDecision: "APPROVED",
        comments: [
          { author: "caleb", body: "one nit: guard the null case", created_at: "2026-07-14T17:10:00Z" },
        ],
        reviews: [
          { author: "twongkeeny", body: "lgtm", state: "APPROVED", created_at: "2026-07-14T17:09:00Z" },
        ],
      }),
    );
    const t = getTask(task.id)!;
    expect(t.status).toBe("queued");
    expect(t.review_notes).toContain("guard the null case");
    expect(t.review_notes).not.toContain("lgtm"); // the approval is not forwarded as feedback
    expect(t.human_approved_at).toBe("2026-07-14T17:09:00Z");
    expect(listEvents(10).map((e) => e.kind)).toContain("pr.human_approved");
  });

  it("already-forwarded comments are not re-sent", async () => {
    const { applyPrState } = await import("../src/daemon/prsync.js");
    const { getTask, updateTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { task } = await setupPrTask();
    updateTask(task.id, { pr_feedback_at: "2026-07-04T02:00:00Z" });
    await applyPrState(
      task.id,
      open({
        comments: [
          { author: "caleb", body: "old comment", created_at: "2026-07-04T01:00:00Z" },
        ],
      }),
    );
    expect(getTask(task.id)?.status).toBe("review"); // untouched
    expect(listEvents(10).map((e) => e.kind)).not.toContain("pr.feedback");
  });

  it("delivering PR feedback moves a live worker back to working", async () => {
    const { applyPrState } = await import("../src/daemon/prsync.js");
    const { getTask, updateTask } = await import("../src/db/tasks.js");
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const { task } = await setupPrTask();
    const worker = createAgent({
      kind: "worker",
      state: "idle",
      task_id: task.id,
      tmux_target: "cc:@7",
    });
    updateTask(task.id, { agent_id: worker.id });
    await applyPrState(
      task.id,
      open({
        comments: [
          { author: "caleb", body: "fix this", created_at: "2026-07-04T02:00:00Z" },
        ],
      }),
    );
    expect(getTask(task.id)?.status).toBe("in_progress");
    const w = getAgent(worker.id)!;
    expect(w.state).toBe("working");
    // resumed workers must not trip the stall watchdog on pre-resume silence
    expect(w.last_event_at).not.toBeNull();
  });

  it("defers feedback while the worker sits on a permission prompt", async () => {
    const { applyPrState } = await import("../src/daemon/prsync.js");
    const { getTask, updateTask } = await import("../src/db/tasks.js");
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const { task } = await setupPrTask();
    const worker = createAgent({
      kind: "worker",
      state: "waiting_input", // injected text would answer its pending menu
      task_id: task.id,
      tmux_target: "cc:@7",
    });
    updateTask(task.id, { agent_id: worker.id });
    await applyPrState(
      task.id,
      open({
        comments: [
          { author: "caleb", body: "fix this", created_at: "2026-07-04T02:00:00Z" },
        ],
      }),
    );
    const t = getTask(task.id)!;
    expect(t.status).toBe("review"); // untouched
    expect(t.pr_feedback_at).toBeNull(); // watermark NOT advanced — retried next pass
    expect(getAgent(worker.id)?.state).toBe("waiting_input");
  });

  it("defers feedback while an adversarial reviewer is live", async () => {
    const { applyPrState } = await import("../src/daemon/prsync.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { task } = await setupPrTask();
    createAgent({ kind: "reviewer", state: "working", task_id: task.id });
    await applyPrState(
      task.id,
      open({
        comments: [
          { author: "caleb", body: "fix this", created_at: "2026-07-04T02:00:00Z" },
        ],
      }),
    );
    const t = getTask(task.id)!;
    expect(t.status).toBe("review"); // the reviewer's submit_review stays valid
    expect(t.pr_feedback_at).toBeNull();
  });

  it("does nothing for tasks not in review", async () => {
    const { applyPrState } = await import("../src/daemon/prsync.js");
    const { getTask, updateTask } = await import("../src/db/tasks.js");
    const { task } = await setupPrTask();
    updateTask(task.id, { status: "done" });
    await applyPrState(task.id, open({ state: "MERGED" }));
    expect(getTask(task.id)?.status).toBe("done");
  });
});

describe("prSyncPass", () => {
  it("skips a branch-only (open_pr=false) task even if it has a stale pr_url", async () => {
    const { prSyncPass } = await import("../src/daemon/prsync.js");
    const { getTask, updateTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { task } = await setupPrTask();
    updateTask(task.id, { open_pr: 0 });
    await prSyncPass();
    // no gh call attempted -> no sync error, task left untouched
    expect(listEvents(10).map((e) => e.kind)).not.toContain("pr.sync_error");
    expect(getTask(task.id)?.status).toBe("review");
  });
});

describe("tasksNeedingPrSync (candidate selection + backfill)", () => {
  async function mkTask(over: Record<string, unknown> = {}) {
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    updateTask(task.id, over);
    return task.id;
  }

  it("includes done/cancelled tasks whose pr_state was never synced (backfill)", async () => {
    const { tasksNeedingPrSync } = await import("../src/db/tasks.js");
    const done = await mkTask({
      status: "done",
      pr_url: "https://github.com/x/y/pull/1",
    });
    const cancelled = await mkTask({
      status: "cancelled",
      pr_url: "https://github.com/x/y/pull/2",
    });
    const ids = tasksNeedingPrSync().map((t) => t.id);
    // NULL pr_state must be picked up even though the task is terminal-status —
    // this is the pre-existing-row catch-up that PR #9 never ran.
    expect(ids).toContain(done);
    expect(ids).toContain(cancelled);
  });

  it("keeps syncing an OPEN PR but never re-polls a terminal (merged/closed) one", async () => {
    const { tasksNeedingPrSync } = await import("../src/db/tasks.js");
    const open = await mkTask({
      status: "review",
      pr_url: "https://github.com/x/y/pull/3",
      pr_state: "open",
    });
    const merged = await mkTask({
      status: "done",
      pr_url: "https://github.com/x/y/pull/4",
      pr_state: "merged",
    });
    const closed = await mkTask({
      status: "blocked",
      pr_url: "https://github.com/x/y/pull/5",
      pr_state: "closed",
    });
    const ids = tasksNeedingPrSync().map((t) => t.id);
    expect(ids).toContain(open);
    expect(ids).not.toContain(merged); // terminal — polling it again wastes gh quota
    expect(ids).not.toContain(closed);
  });

  it("ignores tasks without a pr_url and branch-only (open_pr=0) tasks", async () => {
    const { tasksNeedingPrSync } = await import("../src/db/tasks.js");
    const noPr = await mkTask({ status: "review" });
    const branchOnly = await mkTask({
      status: "review",
      pr_url: "https://github.com/x/y/pull/6",
      open_pr: 0,
    });
    const ids = tasksNeedingPrSync().map((t) => t.id);
    expect(ids).not.toContain(noPr);
    expect(ids).not.toContain(branchOnly);
  });
});

describe("computeCheckRollup", () => {
  it("empty rollup -> none", async () => {
    const { computeCheckRollup } = await import("../src/daemon/prsync.js");
    expect(computeCheckRollup([])).toBe("none");
  });

  it("all successful checks -> pass", async () => {
    const { computeCheckRollup } = await import("../src/daemon/prsync.js");
    expect(
      computeCheckRollup([
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { state: "SUCCESS" },
      ]),
    ).toBe("pass");
  });

  it("any failure wins over pending/success", async () => {
    const { computeCheckRollup } = await import("../src/daemon/prsync.js");
    expect(
      computeCheckRollup([
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "IN_PROGRESS" },
        { status: "COMPLETED", conclusion: "FAILURE" },
      ]),
    ).toBe("fail");
    expect(computeCheckRollup([{ state: "ERROR" }])).toBe("fail");
  });

  it("an incomplete check with no failures -> pending", async () => {
    const { computeCheckRollup } = await import("../src/daemon/prsync.js");
    expect(
      computeCheckRollup([
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "QUEUED" },
      ]),
    ).toBe("pending");
    expect(computeCheckRollup([{ state: "PENDING" }])).toBe("pending");
  });
});

describe("recordSyncSuccess", () => {
  it("persists the PR lifecycle + CI rollup and clears the failure streak", async () => {
    const { recordSyncSuccess, recordSyncFailure } = await import(
      "../src/daemon/prsync.js"
    );
    const { getTask } = await import("../src/db/tasks.js");
    const { task } = await setupPrTask();
    recordSyncFailure(task.id, "boom"); // seed a streak
    recordSyncSuccess(task.id, open({ state: "OPEN", checks: "pass" }));
    const t = getTask(task.id)!;
    expect(t.pr_state).toBe("open");
    expect(t.pr_checks).toBe("pass");
    expect(t.pr_synced_at).not.toBeNull();
    expect(t.pr_sync_fails).toBe(0);
  });

  it("captures the PR draft state (isDraft true -> 1, false -> 0)", async () => {
    const { recordSyncSuccess } = await import("../src/daemon/prsync.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { task } = await setupPrTask();
    recordSyncSuccess(task.id, open({ isDraft: true }));
    expect(getTask(task.id)?.pr_is_draft).toBe(1);
    recordSyncSuccess(task.id, open({ isDraft: false }));
    expect(getTask(task.id)?.pr_is_draft).toBe(0);
  });

  it("does not clobber a known draft state when isDraft is absent", async () => {
    const { recordSyncSuccess } = await import("../src/daemon/prsync.js");
    const { getTask, updateTask } = await import("../src/db/tasks.js");
    const { task } = await setupPrTask();
    updateTask(task.id, { pr_is_draft: 1 });
    recordSyncSuccess(task.id, open()); // no isDraft on the state
    expect(getTask(task.id)?.pr_is_draft).toBe(1); // untouched
  });
});

describe("recordSyncFailure escalation", () => {
  it("logs sync_error once, then escalates to sync_broken at the threshold", async () => {
    const { recordSyncFailure, SYNC_FAIL_THRESHOLD } = await import(
      "../src/daemon/prsync.js"
    );
    const { getTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { task } = await setupPrTask();

    // fail #1: log once
    recordSyncFailure(task.id, "gh timeout");
    expect(getTask(task.id)?.pr_sync_fails).toBe(1);
    // fail #2: silent (no repeated logging every pass)
    recordSyncFailure(task.id, "gh timeout");
    expect(getTask(task.id)?.pr_sync_fails).toBe(2);
    // fail #3 (== threshold): escalate loudly, exactly once
    recordSyncFailure(task.id, "gh timeout");
    expect(getTask(task.id)?.pr_sync_fails).toBe(SYNC_FAIL_THRESHOLD);
    // fail #4: no further events — it's already surfaced
    recordSyncFailure(task.id, "gh timeout");
    expect(getTask(task.id)?.pr_sync_fails).toBe(4);

    const kinds = listEvents(20).map((e) => e.kind);
    expect(kinds.filter((k) => k === "pr.sync_error")).toHaveLength(1);
    expect(kinds.filter((k) => k === "pr.sync_broken")).toHaveLength(1);
  });

  it("a success between failures resets the streak so it never escalates", async () => {
    const { recordSyncFailure, recordSyncSuccess } = await import(
      "../src/daemon/prsync.js"
    );
    const { getTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { task } = await setupPrTask();
    recordSyncFailure(task.id, "flaky");
    recordSyncFailure(task.id, "flaky");
    recordSyncSuccess(task.id, open()); // recovered
    recordSyncFailure(task.id, "flaky again");
    expect(getTask(task.id)?.pr_sync_fails).toBe(1);
    expect(listEvents(20).map((e) => e.kind)).not.toContain("pr.sync_broken");
  });
});
