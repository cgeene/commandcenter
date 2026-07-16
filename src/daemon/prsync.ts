import { execFile } from "node:child_process";
import { listAgents } from "../db/agents.js";
import { logEvent } from "../db/events.js";
import {
  getTask,
  tasksNeedingPrReconcile,
  tasksNeedingPrSync,
  updateTask,
  type Task,
} from "../db/tasks.js";
import { notify } from "./notify.js";
import { reviewLoopSweep, reviewMaxCycles } from "./review.js";
import { resumeAgent } from "./resume.js";
import { killAgent } from "./spawn.js";
import { git, removeWorktree } from "./worktree.js";

/**
 * PR lifecycle sync: the human reviews in GitHub, the board follows.
 * - PR merged  -> task done, agents reaped, worktree + local branch pruned
 * - PR closed  -> task blocked (work rejected without merge)
 * - new PR comments / changes requested -> piped to the worker as feedback
 */

export interface PrComment {
  author: string;
  body: string;
  created_at: string;
}

/** A submitted PR review. Unlike a comment it carries a state, which is what
 *  lets us tell an actionable "changes requested" from a bare "approve". */
export interface PrReview {
  author: string;
  body: string;
  /** APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED (uppercased). */
  state: string;
  created_at: string;
}

/** CI check rollup for a PR — how the dashboard badges its health. */
export type CheckRollup = "pass" | "fail" | "pending" | "none";

export interface PrState {
  state: "OPEN" | "MERGED" | "CLOSED";
  reviewDecision: string | null;
  /** Top-level PR comments + inline review comments (never review verdicts). */
  comments: PrComment[];
  /** Submitted reviews with their verdict state; absent when not fetched
   *  (older callers/tests). */
  reviews?: PrReview[];
  /** Rolled-up CI status; absent when not fetched (older callers/tests). */
  checks?: CheckRollup;
  /** GitHub draft state; absent when not fetched (older callers/tests). A
   *  draft PR means the platform's internal review is still pending/rejecting. */
  isDraft?: boolean;
}

const POLL_MS = 120_000;

/** Consecutive prsync failures for one PR before we escalate loudly instead
 *  of logging the same error silently forever (see unicorn-k8s PR #2199). */
export const SYNC_FAIL_THRESHOLD = 3;

export function parsePrUrl(
  url: string,
): { owner: string; repo: string; number: number } | undefined {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : undefined;
}

function gh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout),
    );
  });
}

/** Individual entries in gh's statusCheckRollup — either GitHub Checks
 *  (status/conclusion) or legacy commit statuses (state). */
interface RollupEntry {
  status?: string; // QUEUED | IN_PROGRESS | COMPLETED (CheckRun)
  conclusion?: string; // SUCCESS | FAILURE | ... (CheckRun, once COMPLETED)
  state?: string; // SUCCESS | PENDING | FAILURE | ERROR (StatusContext)
}

/** Collapse a PR's individual checks into one health verdict. Any failure
 *  wins; else any not-yet-complete check makes it pending; else all pass. */
export function computeCheckRollup(entries: RollupEntry[]): CheckRollup {
  if (!entries || entries.length === 0) return "none";
  let pending = false;
  for (const e of entries) {
    const concl = (e.conclusion ?? "").toUpperCase();
    const status = (e.status ?? "").toUpperCase();
    const legacy = (e.state ?? "").toUpperCase();
    if (
      concl === "FAILURE" ||
      concl === "TIMED_OUT" ||
      concl === "CANCELLED" ||
      concl === "ACTION_REQUIRED" ||
      concl === "STARTUP_FAILURE" ||
      legacy === "FAILURE" ||
      legacy === "ERROR"
    ) {
      return "fail";
    }
    // a CheckRun that hasn't reached COMPLETED, or a pending legacy status
    if ((status && status !== "COMPLETED") || legacy === "PENDING") pending = true;
  }
  return pending ? "pending" : "pass";
}

export async function fetchPrState(prUrl: string): Promise<PrState> {
  const ref = parsePrUrl(prUrl);
  if (!ref) throw new Error(`not a GitHub PR url: ${prUrl}`);
  const [view, issueComments, reviewComments] = await Promise.all([
    gh(["pr", "view", prUrl, "--json", "state,isDraft,reviewDecision,reviews,statusCheckRollup"]),
    gh(["api", `repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments`]),
    gh(["api", `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments`]),
  ]);
  const v = JSON.parse(view) as {
    state: PrState["state"];
    isDraft?: boolean;
    reviewDecision: string | null;
    reviews?: { author?: { login?: string }; body?: string; state?: string; submittedAt?: string }[];
    statusCheckRollup?: RollupEntry[];
  };
  type RawComment = { user?: { login?: string }; body?: string; created_at?: string };
  const notBot = (author: string) => !author.endsWith("[bot]");
  // Top-level PR comments + inline review comments. Review verdicts are kept
  // separate (see `reviews` below) so their state can gate re-queueing.
  const comments: PrComment[] = [
    ...(JSON.parse(issueComments) as RawComment[]).map((c) => ({
      author: c.user?.login ?? "?",
      body: c.body ?? "",
      created_at: c.created_at ?? "",
    })),
    ...(JSON.parse(reviewComments) as RawComment[]).map((c) => ({
      author: c.user?.login ?? "?",
      body: c.body ?? "",
      created_at: c.created_at ?? "",
    })),
  ]
    .filter((c) => c.body.trim() && c.created_at)
    // CI chatter (codecov[bot], github-actions[bot], ...) is not review
    // feedback — forwarding it would yank the task out of review for nothing.
    .filter((c) => notBot(c.author));
  comments.sort((a, b) => a.created_at.localeCompare(b.created_at));
  // Submitted reviews, kept WITH their state and even when the body is empty:
  // an empty CHANGES_REQUESTED is still actionable, and an empty/trivial
  // APPROVED must be recognizable so we don't re-queue on it. PENDING reviews
  // (no submittedAt) are dropped.
  const reviews: PrReview[] = (v.reviews ?? [])
    .map((r) => ({
      author: r.author?.login ?? "?",
      body: r.body ?? "",
      state: (r.state ?? "").toUpperCase(),
      created_at: r.submittedAt ?? "",
    }))
    .filter((r) => r.created_at && notBot(r.author))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  return {
    state: v.state,
    reviewDecision: v.reviewDecision,
    comments,
    reviews,
    checks: computeCheckRollup(v.statusCheckRollup ?? []),
    isDraft: v.isDraft ?? false,
  };
}

const TRIVIAL_APPROVAL_BODIES = new Set([
  "approve",
  "approved",
  "approving",
  "lgtm",
  "looks good",
  "looks good to me",
  "ship it",
  "shipit",
  "+1",
  "ok",
  "okay",
  "done",
  "thanks",
  "ty",
  "nice",
]);

/** A bare approval acknowledgment ("approve", "lgtm", "👍") carries no change
 *  request. We normalize away punctuation/emoji so "LGTM!" and "👍" collapse to
 *  the empty/known set. Anything with real prose ("approve, but rename X")
 *  falls through as non-trivial. */
function isTrivialApproval(body: string): boolean {
  const normalized = body
    .toLowerCase()
    .replace(/[^a-z0-9+]+/g, " ")
    .trim();
  return normalized === "" || TRIVIAL_APPROVAL_BODIES.has(normalized);
}

/** Does a submitted review count as actionable PR feedback? Key off state AND
 *  body — never state alone:
 *  - CHANGES_REQUESTED is always feedback (even with an empty body).
 *  - Any other verdict (APPROVED/COMMENTED/DISMISSED) is feedback only when its
 *    body carries a real request; an empty or trivial-approval body is a
 *    thumbs-up, not a re-queue trigger. */
export function reviewIsFeedback(r: PrReview): boolean {
  if (r.state === "CHANGES_REQUESTED") return true;
  return r.body.trim() !== "" && !isTrivialApproval(r.body);
}

function reapTaskAgents(task: Task, opts?: { rmWorktree?: boolean }): void {
  for (const a of listAgents({ live: true })) {
    if (a.task_id === task.id && a.kind !== "main") {
      // reviewer worktrees are throwaway — always reap them with the agent
      killAgent(a.id, {
        rmWorktree: a.kind === "reviewer" || (opts?.rmWorktree ?? false),
      });
    }
  }
}

/** Apply a PR's state to its task. Pure of gh — unit-testable. */
export async function applyPrState(taskId: number, pr: PrState): Promise<void> {
  const task = getTask(taskId);
  if (!task || task.status !== "review") return;

  if (pr.state === "MERGED") {
    // A merged PR normally auto-completes its task and unblocks its dependents.
    // The one exception is a deliberate human merge of a rejected/blocked PR
    // (the known override case — see cc PR #20): if the latest verdict is
    // reject or the task burned through its review cycles, never auto-complete
    // it. Leave it for the orchestrator/human to resolve deliberately. (A
    // blocked task is already excluded by the status !== "review" guard above;
    // this is the defensive check for a review-status task that still carries a
    // reject verdict.)
    if (task.review_verdict === "reject" || task.review_cycles >= reviewMaxCycles()) {
      logEvent("pr.merged", {
        taskId,
        payload: { pr_url: task.pr_url, autocompleted: false },
      });
      return;
    }
    reapTaskAgents(task, { rmWorktree: true });
    const fresh = getTask(taskId)!;
    if (fresh.worktree) {
      try {
        removeWorktree(fresh.repo, fresh.worktree);
        updateTask(taskId, { worktree: null });
      } catch {
        /* leave it for manual cleanup */
      }
    }
    if (task.branch && /^agent\/task-\d+$/.test(task.branch)) {
      try {
        git(task.repo, "branch", "-D", task.branch);
      } catch {
        /* branch already gone or still checked out somewhere */
      }
    }
    updateTask(taskId, { status: "done" });
    logEvent("task.autocompleted", {
      taskId,
      payload: { pr_url: task.pr_url, reason: "PR merged" },
    });
    notify(`task #${taskId} auto-completed — PR merged`, task.title, { tags: "tada" });
    return;
  }

  if (pr.state === "CLOSED") {
    // Reap the agents — a blocked task's idle worker would otherwise sit in
    // scheduler capacity forever (nothing else cleans up blocked tasks).
    // The worktree and branch stay for the human to inspect or salvage.
    reapTaskAgents(task);
    updateTask(taskId, {
      status: "blocked",
      review_notes: `PR closed without merging: ${task.pr_url}`,
    });
    logEvent("pr.closed", { taskId, payload: { pr_url: task.pr_url } });
    notify(`task #${taskId} blocked — PR closed without merge`, task.title, {
      priority: "high",
      tags: "x",
    });
    return;
  }

  // OPEN: forward new human feedback. pr_feedback_at is the high-water mark;
  // null means the PR was just created — everything so far is feedback.
  const since = task.pr_feedback_at ?? "";
  const freshComments = pr.comments.filter((c) => c.created_at > since);
  const freshReviews = (pr.reviews ?? []).filter((r) => r.created_at > since);

  // A bare approval is a signal, not feedback. Record it (event + lightweight
  // field) so the dashboard can show "human approved", but never let it
  // re-queue a finished task or overwrite the internal reviewer's notes.
  const approvals = freshReviews.filter(
    (r) => r.state === "APPROVED" && !reviewIsFeedback(r),
  );
  if (approvals.length) {
    const latest = approvals[approvals.length - 1].created_at;
    if ((task.human_approved_at ?? "") < latest) {
      updateTask(taskId, { human_approved_at: latest });
      logEvent("pr.human_approved", {
        taskId,
        payload: { pr_url: task.pr_url, reviewers: approvals.map((a) => a.author) },
      });
    }
  }

  // Only reviews that actually request changes re-queue; approvals are dropped.
  const feedbackReviews = freshReviews.filter(reviewIsFeedback);
  const changesRequested =
    pr.reviewDecision === "CHANGES_REQUESTED" ||
    feedbackReviews.some((r) => r.state === "CHANGES_REQUESTED");

  // Merge comments and actionable reviews into one time-ordered feedback list.
  const fresh = [
    ...freshComments.map((c) => ({ author: c.author, body: c.body, created_at: c.created_at })),
    ...feedbackReviews.map((r) => ({
      author: r.author,
      body: r.body.trim() || `(${r.state.toLowerCase().replace(/_/g, " ")})`,
      created_at: r.created_at,
    })),
  ].sort((a, b) => a.created_at.localeCompare(b.created_at));

  if (fresh.length === 0 && !changesRequested) return;
  if (fresh.length === 0 && changesRequested && task.pr_feedback_at) return; // already forwarded

  // A live adversarial reviewer is judging this exact state — moving the
  // task out of review now would void its verdict mid-flight. The feedback
  // keeps: nothing below is persisted, so the next pass retries.
  const reviewing = listAgents({ live: true }).some(
    (a) => a.kind === "reviewer" && a.task_id === taskId,
  );
  if (reviewing) return;

  const feedback = [
    changesRequested ? "The PR review verdict is CHANGES REQUESTED." : "",
    ...fresh.map((c) => `${c.author}: ${c.body}`),
  ]
    .filter(Boolean)
    .join("\n\n");
  const mark = fresh.length
    ? fresh[fresh.length - 1].created_at
    : new Date().toISOString();

  // Deliver BEFORE persisting: once pr_feedback_at advances these comments
  // are never looked at again, so a failed send must leave it untouched.
  if (task.agent_id) {
    const outcome = await resumeAgent(
      task.agent_id,
      `New feedback on your PR (${task.pr_url}). Address every point, push to the same branch, then update your result_summary and stop.\n\n${feedback}`,
    );
    // Worker is parked on a permission prompt — injected text would answer
    // the menu, not reach the conversation. The wait is already being
    // escalated; retry on a later pass once it's unblocked.
    if (outcome === "waiting_input") return;
    if (outcome === "sent") {
      updateTask(taskId, { status: "in_progress", pr_feedback_at: mark });
      logEvent("pr.feedback", {
        taskId,
        payload: { comments: fresh.length, changes_requested: changesRequested },
      });
      logEvent("task.reopened", { taskId, payload: { reason: "pr feedback" } });
      return;
    }
    // not_live: fall through to requeue
  }

  // notes flow into the respawn prompt, same as a reviewer rejection. Append
  // rather than overwrite — the internal reviewer's evidence (and any earlier
  // PR-feedback round) must survive, else it's lost the moment a human comments.
  const feedbackNote = `PR feedback (${task.pr_url}) — address every point and push to the same branch:\n${feedback}`;
  const notes = task.review_notes
    ? `${task.review_notes}\n\n---\n\n${feedbackNote}`
    : feedbackNote;
  updateTask(taskId, {
    status: "queued",
    agent_id: null,
    pr_feedback_at: mark,
    review_notes: notes,
  });
  logEvent("pr.feedback", {
    taskId,
    payload: { comments: fresh.length, changes_requested: changesRequested },
  });
  logEvent("task.requeued", { taskId, payload: { reason: "pr feedback" } });
}

/**
 * Persist a successful sync: cache the PR lifecycle + CI rollup on the task
 * and clear the consecutive-failure streak. The dashboard's PR board reads
 * these columns instead of shelling out to gh on every render.
 */
export function recordSyncSuccess(taskId: number, pr: PrState): void {
  const fields: Partial<Task> = {
    pr_state: pr.state.toLowerCase(),
    pr_checks: pr.checks ?? null,
    pr_synced_at: new Date().toISOString(),
    pr_sync_fails: 0,
  };
  // Only touch pr_is_draft when the caller actually fetched it — older
  // callers/tests omit it, and writing null would clobber a known value.
  if (pr.isDraft !== undefined) fields.pr_is_draft = pr.isDraft ? 1 : 0;
  updateTask(taskId, fields);
}

/**
 * Record a failed sync. The failure count is persisted so the streak survives
 * daemon restarts. We log the error once at the start of a streak (not every
 * 2min), then escalate loudly exactly once when it reaches the threshold —
 * that's the alarm that was missing when unicorn-k8s PR #2199 failed 4x
 * silently.
 */
export function recordSyncFailure(taskId: number, error: string): void {
  const task = getTask(taskId);
  if (!task) return;
  const fails = (task.pr_sync_fails ?? 0) + 1;
  updateTask(taskId, { pr_sync_fails: fails });
  if (fails === 1) {
    logEvent("pr.sync_error", { taskId, payload: { error, fails } });
  } else if (fails === SYNC_FAIL_THRESHOLD) {
    logEvent("pr.sync_broken", {
      taskId,
      payload: { error, fails, pr_url: task.pr_url },
    });
    notify(
      `PR sync broken — task #${taskId}`,
      `${task.title} — ${fails} consecutive sync failures: ${error}`,
      { priority: "high", tags: "warning" },
    );
  }
}

/**
 * Reconcile terminal PR consequences from cached state — the belt to
 * recordSyncSuccess/applyPrState's suspenders. Those are two separate writes
 * (record pr_state, then apply the consequence), and a daemon crash/restart
 * between them strands the task: pr_state is terminal — so it drops out of
 * tasksNeedingPrSync — yet its consequence (auto-complete on merge, block on
 * close) never fired (task #97, observed 2026-07-16). This pass re-derives the
 * consequence from the cached terminal state on EVERY pass, so a missed
 * transition self-heals on the next one instead of being lost forever.
 *
 * applyPrState is idempotent: once the transition lands the task is no longer in
 * 'review', so its `task.status !== "review"` guard turns a re-run into a no-op.
 * That's what makes running this unconditionally every pass safe. We synthesize
 * a minimal PrState from the cached lifecycle state — applyPrState reads only
 * pr.state on the MERGED/CLOSED paths — so no gh round-trip is needed to heal.
 */
export async function reconcileTerminalPrs(): Promise<void> {
  for (const task of tasksNeedingPrReconcile(reviewMaxCycles())) {
    const state: PrState["state"] = task.pr_state === "merged" ? "MERGED" : "CLOSED";
    try {
      await applyPrState(task.id, { state, reviewDecision: null, comments: [] });
    } catch (err) {
      logEvent("pr.reconcile_error", {
        taskId: task.id,
        payload: {
          error: err instanceof Error ? err.message : String(err),
          pr_state: task.pr_state,
        },
      });
    }
  }
}

export async function prSyncPass(): Promise<void> {
  // Belt (task #97): re-apply any terminal PR consequence a prior pass recorded
  // but never got to act on — e.g. a daemon restart in the window between
  // recording pr_state and applying the consequence. State-based, so it heals
  // regardless of whether this process ever observed the transition delta. Runs
  // first so a stranded task recovers even if the gh poll below errors out.
  await reconcileTerminalPrs();

  // Every task with a live (non-terminal) PR, regardless of task status. This
  // deliberately includes done/cancelled tasks: their PR badge must track the
  // real GitHub state, and a task can be marked done while its PR is still
  // open. recordSyncSuccess caches the state for the dashboard; applyPrState
  // only drives lifecycle transitions for review-status tasks (it no-ops for
  // everything else), so polling a done task's PR is safe. Merged/closed PRs
  // are already filtered out by the query — we never re-poll a terminal PR.
  const candidates = tasksNeedingPrSync();
  for (const task of candidates) {
    try {
      const pr = await fetchPrState(task.pr_url!);
      recordSyncSuccess(task.id, pr);
      await applyPrState(task.id, pr);
    } catch (err) {
      recordSyncFailure(task.id, err instanceof Error ? err.message : String(err));
    }
  }
  // Safety net for the auto-review loop: catch a stale approval (post-approval
  // push with no clean worker Stop) or any review-status task the Stop-hook
  // trigger missed. Each call is a no-op when there is nothing new to review.
  await reviewLoopSweep();
}

export function startPrSync(): void {
  // One-time catch-up: pre-existing rows with a pr_url and NULL/OPEN pr_state
  // (e.g. done/cancelled tasks whose PRs predate the pr_state columns) get
  // synced immediately rather than waiting out the first poll interval. Once
  // each PR reaches a terminal state it drops out of the candidate set, so
  // this never repeatedly re-polls merged/closed PRs.
  prSyncPass().catch((err) => console.error("pr sync (startup catch-up) failed:", err));
  setInterval(() => {
    prSyncPass().catch((err) => console.error("pr sync failed:", err));
  }, POLL_MS);
}
