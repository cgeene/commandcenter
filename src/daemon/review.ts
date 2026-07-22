import { listAgents } from "../db/agents.js";
import { countEventsToday, latestTaskEventId, logEvent } from "../db/events.js";
import { getSchedulerConfig } from "../db/settings.js";
import { getTask, listTasks, updateTask, type Task } from "../db/tasks.js";
import { notify } from "./notify.js";
import { markPrDraft, markPrReady } from "./prdraft.js";
import { resumeAgent } from "./resume.js";
import { branchHasCommits, branchHeadSha, hashResult } from "./reviewstate.js";
import { killAgent, spawnReviewer } from "./spawn.js";
import { git } from "./worktree.js";

/** Rejection/round cap before the review⇄fix loop escalates to the human.
 *  Runtime-configurable via the scheduler settings; this reads the live value. */
export function reviewMaxCycles(): number {
  return getSchedulerConfig().review_max_cycles;
}

const DIFF_CHAR_LIMIT = 20_000;

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
  const commits = git(task.repo, "log", "--oneline", range).trim();
  const stat = git(task.repo, "diff", "--stat", base, task.branch).trim();
  const full = git(task.repo, "diff", base, task.branch);
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

/** Is there a live reviewer already judging this task? */
function reviewerLive(taskId: number): boolean {
  return listAgents({ live: true }).some(
    (a) => a.kind === "reviewer" && a.task_id === taskId,
  );
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
  notify(
    `task #${task.id} NOT auto-reviewed`,
    `${task.title} — daily spawn budget exhausted; review manually or agp review ${task.id}`,
    { priority: "high", tags: "moneybag" },
  );
  return false;
}

/** Spawn the next reviewer round for a task and record what it is judging so a
 *  later idle re-entry doesn't re-trigger. Emits review.round_started. */
function startReviewRound(task: Task, headSha: string | null): void {
  try {
    const { agent } = spawnReviewer(task.id);
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
  notify(
    `task #${task.id} — review loop exhausted after ${rounds} rounds`,
    `${task.title} — human decision needed. Last reviewer notes: ${(task.review_notes ?? "").slice(0, 200)}`,
    { priority: "high", tags: "rotating_light" },
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
      notify(
        `task #${task.id} — stale approval, but PR is STILL READY`,
        `${task.title} — new commits landed after approval and 'gh pr ready --undo' failed: ${msg}\nConvert it back to a draft manually so an un-reviewed HEAD isn't merged:\n${task.pr_url}`,
        { priority: "high", tags: "rotating_light" },
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
  if (task.workspace_kind === "repo" && !task.pr_url) {
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

  const headSha = branchHeadSha(task); // null for scratch/no-git

  // --- Invariant: a non-draft/approved PR must match its current HEAD ---
  if (task.review_verdict === "approve") {
    // No git signal (scratch) or HEAD unchanged since approval: still current.
    if (!headSha || headSha === task.review_head_sha) return;
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
  startReviewRound(task, headSha);
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
  if (!task) throw new Error(`task ${taskId} not found`);
  if (task.status !== "review") {
    throw new Error(`task ${taskId} is ${task.status}, not review`);
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
    const approvedSha = branchHeadSha(task) ?? task.review_head_sha;

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
      notify(
        `task #${taskId} auto-completed`,
        `${task.title} — approved by reviewer, no PR to merge`,
        { tags: "tada" },
      );
      return getTask(taskId)!;
    }
    updateTask(taskId, {
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
        notify(
          `task #${taskId} approved but PR is STILL A DRAFT`,
          `${task.title} — 'gh pr ready' failed: ${msg}\nMark it ready manually or it won't surface for merge:\n${task.pr_url}`,
          { priority: "high", tags: "rotating_light" },
        );
      }
    }
    notify(
      `task #${taskId} approved by reviewer`,
      `${task.title} — ready for your final review/merge${task.pr_url ? `\n${task.pr_url}` : ""}`,
      { tags: "white_check_mark" },
    );
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
      notify(
        `task #${taskId} rejected but PR is STILL READY`,
        `${task.title} — 'gh pr ready --undo' failed: ${msg}\nConvert it back to a draft manually so it isn't merged by mistake:\n${task.pr_url}`,
        { priority: "high", tags: "rotating_light" },
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
    notify(
      `task #${taskId} — review loop exhausted after ${cycles} rounds`,
      `${task.title} — human decision needed. Last reviewer notes: ${notes.slice(0, 200)}`,
      { priority: "high", tags: "rotating_light" },
    );
    return getTask(taskId)!;
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
    });
    logEvent("task.reopened", { taskId, payload: { reason: "review rejected" } });
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
    });
    logEvent("task.requeued", {
      taskId,
      payload: { reason: "review rejected; worker gone — notes go into the respawn prompt" },
    });
  }
  return getTask(taskId)!;
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
