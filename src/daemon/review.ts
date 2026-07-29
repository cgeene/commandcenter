import { listAgents, type Agent } from "../db/agents.js";
import {
  countEventsToday,
  latestTaskEvent,
  latestTaskEventId,
  logEvent,
} from "../db/events.js";
import { getSchedulerConfig } from "../db/settings.js";
import { getTask, listTasks, updateTask, type Task } from "../db/tasks.js";
import { noteReworkOverCap } from "./capacity.js";
import { notifyEvent } from "./notify.js";
import { markPrDraft, markPrReady } from "./prdraft.js";
import { resumeAgent } from "./resume.js";
import {
  branchHasCommits,
  branchHeadSha,
  DIFF_CHAR_LIMIT,
  hashResult,
} from "./reviewstate.js";
import { killAgent, spawnReviewer, type PriorReviewRound } from "./spawn.js";
import { git } from "./worktree.js";
import {
  approvedSnapshotIsPublished,
  captureReviewSnapshot,
  clearReviewSnapshot,
  reviewSnapshotChanged,
  snapshotHasChanges,
} from "./reviewsnapshot.js";

/** Rejection/round cap before the review⇄fix loop escalates to the human.
 *  Runtime-configurable via the scheduler settings; this reads the live value. */
export function reviewMaxCycles(): number {
  return getSchedulerConfig().review_max_cycles;
}

/** The de-dup key for the approved-and-ready push: one push per approved SHA.
 *  Exported because a mechanical freshen merge CARRIES an approval onto a new
 *  SHA (src/daemon/freshen.ts) and must claim the new key rather than let the
 *  next sweep re-announce work the human was already told about. */
export function approvedReadyLatchKey(
  taskId: number,
  approvedSha: string | null,
): string {
  return `task:${taskId}:approved_ready:${approvedSha ?? "nosha"}`;
}

/**
 * The one push that means "Caleb, act now".
 *
 * A task ENTERING review means the automatic adversarial reviewer is about to
 * run — nothing is asked of a human then. What is worth a phone buzz is the
 * other end of that loop: the reviewer approved AND the PR is open and out of
 * draft, so it is genuinely mergeable. (For human-publication tasks there is no
 * PR yet; the approved working tree is what's waiting.)
 *
 * Both callers re-derive this from standing task state — handleVerdict on the
 * approve edge, and the prsync sweep every couple of minutes — so it is latched
 * on the SHA the approval covers. A re-poll can never re-fire it; a superseded
 * approval that is later re-approved against a new SHA gets a new key and does.
 *
 * Safe to call with any task: everything that isn't approved-and-ready no-ops.
 */
export function notifyApprovedReady(task: Task): void {
  if (task.review_verdict !== "approve") return;
  const awaitingHuman =
    task.publication_mode === "human" &&
    task.workspace_kind === "repo" &&
    task.publication_state === "awaiting_human";
  const prReady =
    task.open_pr !== 0 && Boolean(task.pr_url) && task.pr_is_draft === 0;
  if (!awaitingHuman && !prReady) return;
  // review_head_sha is the SHA (or snapshot tree) the approval covers.
  const once = approvedReadyLatchKey(task.id, task.review_head_sha);
  if (awaitingHuman) {
    notifyEvent(
      "review_approved_ready",
      `task #${task.id} reviewed & approved — your turn to publish`,
      `${task.title}\nThe reviewer approved the uncommitted working tree. Inspect it, then commit, push, and record the PR in Command Center.`,
      { tags: "white_check_mark,eyes", taskId: task.id, once },
    );
    return;
  }
  notifyEvent(
    "review_approved_ready",
    `task #${task.id} reviewed & approved — PR ready to merge`,
    `${task.title}\n${task.pr_url}\nInternal review passed and the PR is out of draft. Merge it, or request changes on GitHub.`,
    { tags: "white_check_mark", taskId: task.id, once },
  );
}

export interface TaskDiff {
  branch: string;
  base: string;
  commits: string;
  stat: string;
  diff: string;
  truncated: boolean;
}

/** Diff of a task's branch against its merge-base with the repo's HEAD. */
export function taskDiff(task: Task): TaskDiff {
  if (!task.branch) throw new Error(`task ${task.id} has no branch`);
  const base = git(task.repo, "merge-base", "HEAD", task.branch).trim();
  const range = `${base}..${task.branch}`;
  const target =
    task.publication_mode === "human" && task.review_snapshot_tree
      ? task.review_snapshot_tree
      : task.branch;
  const commits = git(task.repo, "log", "--oneline", range).trim();
  const stat = git(task.repo, "diff", "--stat", base, target).trim();
  const full = git(task.repo, "diff", base, target);
  const truncated = full.length > DIFF_CHAR_LIMIT;
  return {
    branch: task.branch,
    base,
    commits,
    stat,
    diff: truncated ? full.slice(0, DIFF_CHAR_LIMIT) + "\n... [diff truncated]" : full,
    truncated,
  };
}

/** A reviewable task is one in `review` that produced something to judge: a
 *  repo task needs commits on its branch; a scratch/no-PR task needs only a
 *  result_summary (the reviewer validates via transcript/docs/verify). */
function isReviewable(task: Task): boolean {
  if (task.status !== "review") return false;
  if (task.workspace_kind === "portfolio") return false; // no branch to review
  if (task.workspace_kind === "scratch") return Boolean(task.result_summary);
  if (!task.branch) return false;
  if (
    task.publication_mode === "human" &&
    task.publication_state !== "published"
  ) {
    return snapshotHasChanges(task);
  }
  return branchHasCommits(task);
}

/**
 * Has a `review.skipped_no_pr` already been logged for the task's *current*
 * review episode? The no-PR gate below is re-evaluated on every sweep (~every
 * poll) for a task sitting in `review`, so without this the feed would fill
 * with an identical skip line every couple of minutes. We log it once per time
 * the task enters review: a skip newer than the latest review-entry marker means
 * "already surfaced this episode". Leaving review and coming back (a fix round)
 * produces a fresh marker, so the next skip re-logs.
 */
function noPrSkipAlreadyLogged(taskId: number): boolean {
  const skipped = latestTaskEventId(taskId, ["review.skipped_no_pr"]);
  if (!skipped) return false;
  const entered = latestTaskEventId(taskId, [
    "task.review",
    "verify.passed",
    "task.status",
  ]);
  return !entered || skipped > entered;
}

/** Every live reviewer assigned to this task. The single source of truth for
 *  "someone is judging this right now" — both the double-spawn guard and the
 *  verdict-acceptance check below read it, so they can never disagree. */
function liveReviewers(taskId: number): Agent[] {
  return listAgents({ live: true }).filter(
    (a) => a.kind === "reviewer" && a.task_id === taskId,
  );
}

/** Is there a live reviewer already judging this task? */
function reviewerLive(taskId: number): boolean {
  return liveReviewers(taskId).length > 0;
}

/** Did this exact verdict come from a reviewer the platform still has running
 *  on this task? Work it commissioned and has not retired is never discarded
 *  for a status change that happened underneath it. */
function submittedByLiveReviewer(taskId: number, agentId: number): boolean {
  return liveReviewers(taskId).some((a) => a.id === agentId);
}

/**
 * Is the review loop's own round cap the thing holding this blocked task — as
 * opposed to a mechanical gate (a verify_cmd that keeps failing, a PR closed
 * without merging, a worker's report_blocked)? Only the cap is a gate a
 * reviewer's approve is entitled to lift; the rest are conditions no amount of
 * reading the diff satisfies.
 *
 * Deliberately conservative in both directions, because being wrong here means
 * calling a PR ready to merge when its verification still fails:
 *  - the durable state must say the rounds are genuinely used up, which is the
 *    same condition exhaustLoop and the cap branch block on;
 *  - AND the most recent recorded blocking cause must be the loop. A cause this
 *    list does not know about simply leaves the task blocked, which is the safe
 *    direction — the verdict is still recorded either way.
 */
function blockedByReviewLoop(task: Task): boolean {
  if (task.review_cycles < reviewMaxCycles()) return false;
  const cause = latestTaskEvent(task.id, [
    "review.loop_exhausted",
    "task.blocked",
    "task.status",
    "pr.closed",
  ]);
  return cause?.kind === "review.loop_exhausted";
}

/**
 * A verdict (or other review action) could not be applied because the task is
 * not in a state that accepts it. Surfaced to the caller as a 409 carrying the
 * real status — an opaque 500 costs a reviewer several blind retries and tells
 * neither it nor the orchestrator what to fix.
 */
export class ReviewStateError extends Error {
  constructor(
    message: string,
    readonly taskStatus: string | null,
    readonly expectedStatus = "review",
  ) {
    super(message);
    this.name = "ReviewStateError";
  }
}

/**
 * Auto-spawn budget gate, shared by every reviewer spawn in the loop. Auto
 * reviews draw from the same daily budget as autonomous worker spawns; a skip
 * is surfaced (event + notify) so a review never silently doesn't happen.
 * Returns true when a spawn is allowed.
 */
function withinReviewBudget(task: Task): boolean {
  const cfg = getSchedulerConfig();
  const spent =
    countEventsToday("scheduler.spawned") + countEventsToday("reviewer.auto_spawned");
  if (spent < cfg.daily_spawn_limit) return true;
  logEvent("reviewer.budget_skipped", { taskId: task.id });
  notifyEvent(
    "capacity_or_budget",
    `task #${task.id} was not auto-reviewed`,
    `${task.title} — today's spawn budget is exhausted, so no reviewer started. Nothing is lost; it reviews tomorrow, or run \`agp review ${task.id}\` now.`,
    { priority: "high", tags: "moneybag", taskId: task.id },
  );
  return false;
}

/** Spawn the next reviewer round for a task and record what it is judging so a
 *  later idle re-entry doesn't re-trigger. Emits review.round_started.
 *  `prior` (when the round follows a superseded verdict) lets the reviewer
 *  scope itself to what changed since that verdict — see spawnReviewer. */
function startReviewRound(
  task: Task,
  headSha: string | null,
  prior?: PriorReviewRound,
): void {
  try {
    const { agent } = spawnReviewer(task.id, prior ? { priorRound: prior } : undefined);
    updateTask(task.id, {
      review_head_sha: headSha,
      review_result_hash: hashResult(task.result_summary),
    });
    logEvent("reviewer.auto_spawned", { taskId: task.id, agentId: agent.id });
    logEvent("review.round_started", {
      taskId: task.id,
      agentId: agent.id,
      payload: { round: task.review_cycles + 1, max: reviewMaxCycles() },
    });
  } catch (err) {
    logEvent("reviewer.spawn_error", {
      taskId: task.id,
      payload: { error: err instanceof Error ? err.message : String(err) },
    });
  }
}

/** The loop ran out of automatic rounds: block the task and raise a Needs-You
 *  decision item. Replaces the old hard block-at-2 — a converging loop is
 *  allowed to run up to review_max_cycles rounds first. */
function exhaustLoop(task: Task, rounds: number): void {
  updateTask(task.id, { status: "blocked" });
  logEvent("review.loop_exhausted", {
    taskId: task.id,
    payload: { rounds, max: reviewMaxCycles() },
  });
  notifyEvent(
    "review_exhausted",
    `task #${task.id} blocked — review loop exhausted after ${rounds} rounds`,
    `${task.title}\nThe automatic review⇄fix loop ran out of rounds without converging. Decide: steer it, requeue it, or close it. Last reviewer notes: ${(task.review_notes ?? "").slice(0, 200)}`,
    {
      priority: "high",
      tags: "rotating_light",
      taskId: task.id,
      once: `task:${task.id}:review_exhausted:${rounds}`,
    },
  );
}

/**
 * Invalidate a stale approval (the premature-merge fix). New commits landed on
 * the branch AFTER the approve verdict, so "ready for review" on GitHub no
 * longer means "current HEAD passed internal review". Re-draft the PR, mark the
 * verdict superseded (KEEP the old notes as evidence, appended with the
 * superseding SHA), and count this as a used round. The caller then spawns a
 * fresh reviewer against the new HEAD.
 */
async function supersedeApproval(task: Task, headSha: string): Promise<void> {
  if (task.open_pr !== 0 && task.pr_url && task.pr_is_draft === 0) {
    try {
      await markPrDraft(task.pr_url);
      updateTask(task.id, { pr_is_draft: 1 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logEvent("pr.redraft_failed", {
        taskId: task.id,
        payload: { pr_url: task.pr_url, error: msg, reason: "superseded approval" },
      });
      notifyEvent(
        "pr_state_mismatch",
        `task #${task.id} — stale approval, but the PR still shows READY`,
        `${task.title}\nNew commits landed after the approval and 'gh pr ready --undo' failed: ${msg}\nConvert it back to a draft yourself so an un-reviewed HEAD isn't merged:\n${task.pr_url}`,
        {
          priority: "high",
          tags: "rotating_light",
          taskId: task.id,
          once: `task:${task.id}:redraft_failed:${headSha}`,
        },
      );
    }
  }
  const marker = `\n\n---\n\n[superseded by push ${headSha.slice(0, 12)} — the approval above was against an earlier diff]`;
  updateTask(task.id, {
    review_verdict: null,
    review_notes: (task.review_notes ?? "") + marker,
    review_cycles: task.review_cycles + 1,
  });
  logEvent("review.verdict_superseded", {
    taskId: task.id,
    payload: { new_head: headSha, superseded: "approve" },
  });
}

/**
 * Drive the automatic review⇄fix loop for a task in `review`. Called on every
 * transition into review (worker Stop) and periodically (prsync sweep). It:
 *  - enforces the draft/ready invariant: an approve verdict whose HEAD moved on
 *    is stale → re-draft + supersede + re-review;
 *  - de-dupes: no spawn while a reviewer is already live, and no re-trigger for
 *    an unchanged HEAD + unchanged result_summary (loop-safety against a worker
 *    that keeps re-submitting nothing new);
 *  - caps: at review_max_cycles rounds the task is blocked for the human;
 *  - covers PR, no-PR (branch-only), and scratch tasks alike — the trigger keys
 *    on "new round-worthy change", not on PR presence.
 */
export async function maybeAutoReview(taskId: number): Promise<void> {
  const cfg = getSchedulerConfig();
  if (!cfg.auto_review) return;
  let task = getTask(taskId);
  if (!task || task.status !== "review") return;
  const humanRepo =
    task.publication_mode === "human" &&
    task.workspace_kind === "repo" &&
    task.publication_state !== "published";

  // A reviewer always judges one immutable candidate. Human-mode workers leave
  // their branch uncommitted, so pin the full working tree before spawning.
  if (humanRepo) {
    if (reviewerLive(taskId)) return;
    if (task.review_verdict === "approve") {
      if (!reviewSnapshotChanged(task)) return;
      const marker =
        "\n\n---\n\n[approval superseded: the working tree changed after review]";
      updateTask(task.id, {
        review_verdict: null,
        review_notes: (task.review_notes ?? "") + marker,
        review_cycles: task.review_cycles + 1,
        publication_state: "reviewing",
      });
      logEvent("review.verdict_superseded", {
        taskId: task.id,
        payload: { reason: "human working tree changed", superseded: "approve" },
      });
      task = getTask(task.id)!;
    }
    if (
      !task.review_snapshot_tree ||
      task.publication_state === "editing" ||
      reviewSnapshotChanged(task)
    ) {
      task = captureReviewSnapshot(task.id);
      logEvent("review.snapshot_captured", {
        taskId: task.id,
        payload: { base: task.review_snapshot_base },
      });
    }
  }

  // AUTO-review gate (task #110): a repo task is auto-reviewed ONLY when it has
  // an actual PR to judge. A branch-only / no-PR repo task — even one WITH
  // commits — must NOT auto-spawn an adversarial code reviewer: there is no PR
  // diff to review, and the reviewer worktree can't fetch a branch that was
  // never pushed to origin (the task #109 incident). This gate applies to the
  // AUTOMATIC trigger only — the MANUAL spawn_reviewer MCP path is untouched, so
  // an orchestrator can still explicitly review a PR-less repo task. Scratch
  // tasks are deliberately reviewable via their result_summary and are NOT gated
  // here (task #96 design). Checked before isReviewable so a no-commit repo task
  // still surfaces the skip rather than being silently dropped.
  if (task.workspace_kind === "repo" && !task.pr_url && !humanRepo) {
    if (!noPrSkipAlreadyLogged(task.id)) {
      logEvent("review.skipped_no_pr", {
        taskId: task.id,
        payload: {
          task_id: task.id,
          open_pr: task.open_pr,
          branch_has_commits: branchHasCommits(task),
        },
      });
    }
    return;
  }

  if (!isReviewable(task)) return;

  const headSha = humanRepo
    ? task.review_snapshot_tree
    : branchHeadSha(task); // null for scratch/no-git

  // --- Invariant: a non-draft/approved PR must match its current HEAD ---
  // Captured BEFORE supersedeApproval clears the verdict: what the superseded
  // round judged and concluded. The next reviewer re-verifies only the delta
  // past that SHA instead of re-doing an approval that still holds for
  // everything the new commits don't touch.
  let prior: PriorReviewRound | undefined;
  if (task.review_verdict === "approve") {
    // No git signal (scratch) or HEAD unchanged since approval: still current.
    if (!headSha || headSha === task.review_head_sha) return;
    // Human-publication tasks are excluded: their "sha" is a snapshot tree, not
    // a commit, so there is no commit range to scope a re-review to. (Their
    // supersession is handled above and clears the verdict before this point.)
    if (task.review_head_sha && !humanRepo) {
      prior = {
        fromSha: task.review_head_sha,
        verdict: "approve",
        notes: task.review_notes,
      };
    }
    await supersedeApproval(task, headSha);
    task = getTask(taskId)!; // reload: verdict cleared, cycle bumped
  }

  // Someone is already judging this exact task — don't double-spawn.
  if (reviewerLive(taskId)) return;

  // Loop-safety: only a genuinely new submission re-triggers. When there is a
  // git signal, a changed HEAD is a new round; otherwise (scratch) a changed
  // result_summary is. An identical re-entry (same HEAD AND same summary as the
  // last reviewed state) is ignored — this stops an infinite respawn cycle.
  const resultHash = hashResult(task.result_summary);
  const sameHead = headSha !== null && headSha === task.review_head_sha;
  const sameResult = resultHash === task.review_result_hash;
  const everReviewed = task.review_head_sha !== null || task.review_result_hash !== null;
  if (everReviewed && sameResult && (headSha === null || sameHead)) return;

  // Cap: a converging loop is allowed review_max_cycles rounds before the human
  // is pulled in (replaces the old hard block-at-2).
  if (task.review_cycles >= cfg.review_max_cycles) {
    exhaustLoop(task, task.review_cycles);
    return;
  }

  if (!withinReviewBudget(task)) return;
  startReviewRound(task, headSha, prior);
}

/**
 * A reviewer submitted its verdict. Approve: flag the task (record the approved
 * HEAD so a later push is detectable as stale) and ping the human — final merge
 * stays theirs. Reject: feed the notes back into the still-live worker (or
 * requeue with the notes baked into the next prompt); the loop re-reviews after
 * the fix. At review_max_cycles rejected rounds the task blocks for the human.
 */
export async function handleVerdict(
  taskId: number,
  agentId: number,
  verdict: "approve" | "reject",
  notes: string,
): Promise<Task> {
  const task = getTask(taskId);
  if (!task) {
    throw new ReviewStateError(`task ${taskId} not found`, null);
  }

  // A reviewer can spend many minutes on a round, and the task can be
  // auto-blocked underneath it in that window (the rejection-cycle cap, or a
  // verify_cmd that failed once too often). Throwing that verdict away wastes a
  // completed review and strands the task, so a LIVE reviewer's verdict is
  // still accepted while the task sits blocked, and the status is re-derived
  // from the verdict below: approve returns it to `review`, reject leaves the
  // human's block in place.
  const acceptedWhileBlocked =
    task.status === "blocked" && submittedByLiveReviewer(taskId, agentId);
  if (task.status !== "review" && !acceptedWhileBlocked) {
    logEvent("review.verdict_unsubmittable", {
      taskId,
      agentId,
      payload: { task_status: task.status, attempted_verdict: verdict },
    });
    notifyEvent(
      "worker_stalled",
      `task #${taskId} — a reviewer's verdict could not be recorded`,
      `${task.title}\nReviewer a${agentId} reached "${verdict}" but the task is ${task.status}, not review, so the verdict is being held, not applied. Move the task back to review and tell the reviewer to re-submit, or its work is lost.`,
      {
        priority: "high",
        tags: "warning",
        taskId,
        agentId,
        once: `task:${taskId}:verdict_unsubmittable:${task.status}:a${agentId}`,
      },
    );
    throw new ReviewStateError(
      `task ${taskId} is ${task.status}, not review — a verdict cannot be recorded until it is moved back to review`,
      task.status,
    );
  }
  // Which gate is holding the task decides whether a verdict may lift it. The
  // review loop's own cap is the reviewer's to clear — that is the case this
  // exists for. Every other cause is not: a task blocked because its verify_cmd
  // keeps failing has an unmet MECHANICAL gate that no amount of reading the
  // diff satisfies, and restoring it to `review` would let the approve path
  // mark the PR ready and push "ready to merge" for a branch whose tests fail.
  const restorable = acceptedWhileBlocked && blockedByReviewLoop(task);
  if (acceptedWhileBlocked) {
    logEvent("review.verdict_accepted_while_blocked", {
      taskId,
      agentId,
      payload: { verdict, restorable },
    });
  }
  // Restores the reviewable status the cap took away. Approve edges only — a
  // rejection leaves the block standing.
  const restoreStatus = restorable ? { status: "review" as const } : {};

  if (
    verdict === "approve" &&
    task.publication_mode === "human" &&
    task.workspace_kind === "repo" &&
    task.publication_state !== "published" &&
    reviewSnapshotChanged(task)
  ) {
    const marker =
      "\n\n---\n\n[review verdict ignored: the working tree changed while the snapshot was under review]";
    clearReviewSnapshot(taskId);
    updateTask(taskId, {
      review_verdict: null,
      review_notes: (task.review_notes ?? "") + marker,
      review_head_sha: null,
      review_result_hash: null,
      publication_state: "editing",
    });
    logEvent("review.verdict_stale", {
      taskId,
      agentId,
      payload: { attempted_verdict: verdict },
    });
    return getTask(taskId)!;
  }

  logEvent(verdict === "approve" ? "review.approved" : "review.rejected", {
    taskId,
    agentId,
    payload: { notes: notes.slice(0, 2000) },
  });

  if (verdict === "approve") {
    // Record the SHA this approval covers so a post-approval push is detectable
    // as stale (the premature-merge fix). Falls back to whatever the reviewer
    // was spawned against (review_head_sha) for scratch/no-git tasks.
    const approvedSha =
      task.publication_mode === "human"
        ? task.review_snapshot_tree ?? task.review_head_sha
        : branchHeadSha(task) ?? task.review_head_sha;

    // Blocked for a gate this approve does not clear (a failing verify_cmd, a
    // worker's report_blocked). Keep the verdict — losing a finished review is
    // the whole point of accepting it here — but change nothing else: the task
    // stays blocked, the PR stays a draft, and no "ready to merge" is pushed.
    // Marking that PR ready would hand a human an act-now signal for a branch
    // whose verification still fails.
    if (acceptedWhileBlocked && !restorable) {
      updateTask(taskId, {
        review_verdict: "approve",
        review_notes: notes,
        review_head_sha: approvedSha,
      });
      logEvent("review.approved_block_kept", {
        taskId,
        agentId,
        payload: { pr_left_draft: task.pr_is_draft !== 0 },
      });
      notifyEvent(
        "task_blocked",
        `task #${taskId} approved, but it stays blocked`,
        `${task.title}\nThe reviewer approved the work, but the task is blocked by something the review does not clear — check why it was blocked (a failing verify command, or a worker that reported blocked). The verdict is recorded and the PR is still a draft; clear the block and it can go ready.`,
        {
          priority: "high",
          tags: "rotating_light",
          taskId,
          agentId,
          once: `task:${taskId}:approved_block_kept:${approvedSha ?? "nosha"}`,
        },
      );
      return getTask(taskId)!;
    }

    if (
      task.publication_mode === "human" &&
      task.workspace_kind === "repo" &&
      task.publication_state !== "published"
    ) {
      updateTask(taskId, {
        ...restoreStatus,
        review_verdict: "approve",
        review_notes: notes,
        review_head_sha: approvedSha,
        publication_state: "awaiting_human",
      });
      notifyApprovedReady(getTask(taskId)!);
      return getTask(taskId)!;
    }

    // Doc-only tasks (created open_pr=false) never produce a PR, so there is no
    // merge to gate completion on — approve IS completion: mark done here and
    // let the next scheduler pass pick up newly-unblocked dependents. Mirrors
    // the reject guard by construction (reject never reaches this branch).
    //
    // We gate strictly on open_pr === 0, NOT on "no pr_url": a normal code task
    // (open_pr=1) can reach review before its pr_url is recorded (see
    // hooks.ts — a worker may move itself to review with pr_url still null).
    // Auto-completing that on approve would mark real code done with its work
    // stranded on an unmerged branch. Such a task stays in review and completes
    // the normal way once prsync sees its PR merge.
    const docOnly = task.open_pr === 0;
    if (docOnly) {
      updateTask(taskId, {
        status: "done",
        review_verdict: "approve",
        review_notes: notes,
        review_head_sha: approvedSha,
      });
      logEvent("task.autocompleted", {
        taskId,
        payload: { reason: "approved (no PR to merge)" },
      });
      notifyEvent(
        "task_completed",
        `task #${taskId} done`,
        `${task.title} — approved by the reviewer; there was no PR to merge, so it completed itself. Nothing needed from you.`,
        { tags: "tada", taskId },
      );
      return getTask(taskId)!;
    }
    updateTask(taskId, {
      ...restoreStatus,
      review_verdict: "approve",
      review_notes: notes,
      review_head_sha: approvedSha,
    });
    // Passed internal review -> flip the draft PR to ready-for-review so
    // GitHub's own "ready" state now means "safe for human merge". A failure
    // here leaves an approved PR stuck as a draft, which would hide it from
    // the merge queue, so it must be LOUD, never swallowed.
    if (task.open_pr !== 0 && task.pr_url) {
      try {
        await markPrReady(task.pr_url);
        updateTask(taskId, { pr_is_draft: 0 });
        logEvent("pr.marked_ready", { taskId, agentId, payload: { pr_url: task.pr_url } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logEvent("pr.ready_failed", {
          taskId,
          agentId,
          payload: { pr_url: task.pr_url, error: msg },
        });
        notifyEvent(
          "pr_state_mismatch",
          `task #${taskId} approved but its PR is STILL A DRAFT`,
          `${task.title}\n'gh pr ready' failed: ${msg}\nMark it ready yourself or it won't surface for merge:\n${task.pr_url}`,
          {
            priority: "high",
            tags: "rotating_light",
            taskId,
            agentId,
            once: `task:${taskId}:ready_failed:${approvedSha ?? "nosha"}`,
          },
        );
      }
    }
    // The push that used to fire here ("approved by reviewer") is now emitted
    // by notifyApprovedReady, which additionally requires the PR to actually be
    // out of draft — so the message can honestly say it is ready to merge. If
    // markPrReady failed above, the pr_state_mismatch push covers it instead.
    notifyApprovedReady(getTask(taskId)!);
    return getTask(taskId)!;
  }

  // Reject. If this PR had already been flipped to ready (a fix round on a
  // previously-approved PR, or any drift to ready), send it back to draft so
  // the GitHub-visible state keeps meaning "not yet internally approved". Only
  // act when the PR is known-ready (pr_is_draft === 0); a still-draft or
  // unknown PR is left untouched. A failure is loud — a rejected PR showing as
  // ready could be merged by mistake.
  if (task.open_pr !== 0 && task.pr_url && task.pr_is_draft === 0) {
    try {
      await markPrDraft(task.pr_url);
      updateTask(taskId, { pr_is_draft: 1 });
      logEvent("pr.redrafted", { taskId, agentId, payload: { pr_url: task.pr_url } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logEvent("pr.redraft_failed", {
        taskId,
        agentId,
        payload: { pr_url: task.pr_url, error: msg },
      });
      notifyEvent(
        "pr_state_mismatch",
        `task #${taskId} rejected but its PR still shows READY`,
        `${task.title}\n'gh pr ready --undo' failed: ${msg}\nConvert it back to a draft yourself so it isn't merged by mistake:\n${task.pr_url}`,
        {
          priority: "high",
          tags: "rotating_light",
          taskId,
          agentId,
          once: `task:${taskId}:redraft_failed:round${task.review_cycles + 1}`,
        },
      );
    }
  }

  const cycles = task.review_cycles + 1;

  // Cap reached: block for a human decision with the full round history in the
  // event log. This is the ONLY hard stop now — 2 rejections mid-loop no longer
  // halt an actively-converging loop (that was the old block-at-2 behavior).
  if (cycles >= reviewMaxCycles()) {
    updateTask(taskId, {
      status: "blocked",
      review_verdict: "reject",
      review_notes: notes,
      review_cycles: cycles,
    });
    logEvent("review.loop_exhausted", {
      taskId,
      agentId,
      payload: { rounds: cycles, max: reviewMaxCycles() },
    });
    notifyEvent(
      "review_exhausted",
      `task #${taskId} blocked — review loop exhausted after ${cycles} rounds`,
      `${task.title}\nThe reviewer rejected it ${cycles} times without the loop converging. Decide: steer it, requeue it, or close it. Last reviewer notes: ${notes.slice(0, 200)}`,
      {
        priority: "high",
        tags: "rotating_light",
        taskId,
        agentId,
        once: `task:${taskId}:review_exhausted:${cycles}`,
      },
    );
    return getTask(taskId)!;
  }

  // The task was already blocked when this rejection landed. Record the round
  // so the history is complete, but leave the block standing — resuming or
  // requeueing the worker here would silently undo whichever gate blocked it.
  if (acceptedWhileBlocked) {
    updateTask(taskId, {
      review_verdict: "reject",
      review_notes: notes,
      review_cycles: cycles,
    });
    notifyEvent(
      "task_blocked",
      `task #${taskId} rejected again and stays blocked`,
      `${task.title}\nThe reviewer rejected round ${cycles} while the task was already blocked, so it was not sent back to a worker. Decide: steer it, requeue it, or close it. Notes: ${notes.slice(0, 200)}`,
      {
        priority: "high",
        tags: "rotating_light",
        taskId,
        agentId,
        once: `task:${taskId}:rejected_while_blocked:${cycles}`,
      },
    );
    return getTask(taskId)!;
  }

  if (task.publication_mode === "human" && task.workspace_kind === "repo") {
    clearReviewSnapshot(taskId);
  }

  const outcome = task.agent_id
    ? await resumeAgent(
        task.agent_id,
        `An independent reviewer REJECTED your work on this task. Address every point below, re-verify, update your result_summary, then stop.\n\n${notes}`,
      )
    : "not_live";

  if (outcome === "sent") {
    // verdict cleared so the next pass through review gets a fresh reviewer
    updateTask(taskId, {
      status: "in_progress",
      review_verdict: null,
      review_notes: notes,
      review_cycles: cycles,
      publication_state:
        task.publication_mode === "human" ? "editing" : task.publication_state,
    });
    logEvent("task.reopened", { taskId, payload: { reason: "review rejected" } });
    // The worker was parked in review (cap-exempt) and is now working again, so
    // it re-enters the concurrency count. Rework is a continuation, never
    // refused for capacity — but record it when the fleet is pushed over the cap.
    noteReworkOverCap(taskId, task.agent_id!);
  } else if (outcome === "delivery_failed") {
    // The notes were not delivered, so leaving the task in review would park
    // it permanently: the reviewed HEAD is deduplicated and no review-state
    // watchdog retries feedback delivery. Retire this worker to free its slot,
    // then requeue. The provider session remains recorded, and the next spawn
    // resumes it with review_notes included in the continuation prompt.
    if (task.agent_id) killAgent(task.agent_id);
    updateTask(taskId, {
      status: "queued",
      agent_id: null,
      review_verdict: null,
      review_notes: notes,
      review_cycles: cycles,
      publication_state:
        task.publication_mode === "human" ? "editing" : task.publication_state,
    });
    logEvent("review.feedback_delivery_failed", {
      taskId,
      agentId,
      payload: { reason: "tmux delivery unavailable" },
    });
    logEvent("task.requeued", {
      taskId,
      payload: {
        reason: "review rejected; feedback delivery failed — notes go into the respawn prompt",
      },
    });
  } else {
    // A worker parked on a permission prompt can't take the notes, and the
    // prompt it's waiting on belongs to work that was just rejected — kill
    // it; the respawn resumes its session with the notes in the prompt.
    if (outcome === "waiting_input") killAgent(task.agent_id!);
    updateTask(taskId, {
      status: "queued",
      agent_id: null,
      review_verdict: null,
      review_notes: notes,
      review_cycles: cycles,
      publication_state:
        task.publication_mode === "human" ? "editing" : task.publication_state,
    });
    logEvent("task.requeued", {
      taskId,
      payload: { reason: "review rejected; worker gone — notes go into the respawn prompt" },
    });
  }
  return getTask(taskId)!;
}

export class PublicationValidationError extends Error {}

/** Confirm the human committed the exact reviewer-approved tree and completed
 * the requested publication step. The approved snapshot remains pinned until
 * any expected PR has been marked ready successfully. */
export async function confirmHumanPublication(
  taskId: number,
  prUrl?: string,
): Promise<Task> {
  const task = getTask(taskId);
  if (!task) throw new PublicationValidationError("task not found");
  if (
    task.publication_mode !== "human" ||
    task.workspace_kind !== "repo" ||
    task.publication_state !== "awaiting_human" ||
    task.review_verdict !== "approve"
  ) {
    throw new PublicationValidationError(
      "task is not awaiting human publication",
    );
  }
  if (!approvedSnapshotIsPublished(task)) {
    throw new PublicationValidationError(
      "commit and push the unchanged approved working tree before confirming publication",
    );
  }
  const effectivePrUrl = prUrl ?? task.pr_url ?? undefined;
  if (task.open_pr !== 0 && !effectivePrUrl) {
    throw new PublicationValidationError("pull request URL is required");
  }
  if (task.open_pr !== 0 && effectivePrUrl) {
    try {
      await markPrReady(effectivePrUrl);
    } catch {
      throw new PublicationValidationError(
        "the published pull request could not be marked ready; the approved snapshot is still retained",
      );
    }
    logEvent("pr.marked_ready", {
      taskId: task.id,
      payload: { pr_url: effectivePrUrl, source: "human publication" },
    });
  }
  const approvedHead = branchHeadSha(task);
  clearReviewSnapshot(task.id);
  const updated = updateTask(task.id, {
    status: task.open_pr === 0 ? "done" : "review",
    publication_state: "published",
    review_head_sha: approvedHead,
    ...(task.open_pr !== 0 ? { pr_is_draft: 0 } : {}),
    ...(effectivePrUrl ? { pr_url: effectivePrUrl } : {}),
  })!;
  logEvent("publication.human_confirmed", {
    taskId: task.id,
    payload: { has_pr: Boolean(effectivePrUrl), open_pr: task.open_pr !== 0 },
  });
  notifyEvent(
    "task_completed",
    task.open_pr === 0
      ? `task #${task.id} published`
      : `task #${task.id} publication recorded`,
    `${task.title} — you published it; Command Center has recorded it. Nothing further needed.`,
    { tags: "white_check_mark", taskId: task.id },
  );
  return updated;
}

/**
 * Periodic safety net: advance the review loop for every task sitting in
 * `review`. The worker Stop hook is the primary trigger, but a stale approval
 * (post-approval push with no clean re-entry) or a missed Stop would otherwise
 * never re-review — this sweep catches those. Each maybeAutoReview call is a
 * no-op when there is nothing new to do, so running it every poll is cheap.
 */
export async function reviewLoopSweep(): Promise<void> {
  for (const task of listTasks("review")) {
    try {
      await maybeAutoReview(task.id);
    } catch (err) {
      logEvent("reviewer.spawn_error", {
        taskId: task.id,
        payload: { error: err instanceof Error ? err.message : String(err), phase: "sweep" },
      });
    }
  }
}
