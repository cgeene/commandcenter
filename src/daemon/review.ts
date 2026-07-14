import { countEventsToday, logEvent } from "../db/events.js";
import { getSchedulerConfig } from "../db/settings.js";
import { getTask, updateTask, type Task } from "../db/tasks.js";
import { notify } from "./notify.js";
import { resumeAgent } from "./resume.js";
import { killAgent, spawnReviewer } from "./spawn.js";
import { git } from "./worktree.js";

/** Rejection cycles before the reviewer/worker loop escalates to the human. */
export const MAX_REVIEW_CYCLES = 2;

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

/**
 * Auto-spawn an adversarial reviewer when a task reaches review — every
 * task, manual or scheduler-spawned (toggle: auto_review). Skipped when the
 * branch has no commits (report-only tasks like the dreamer have nothing to
 * review). Auto reviews draw from the same daily budget as autonomous
 * worker spawns; a budget skip is pushed so reviews never silently
 * not-happen.
 */
export function maybeAutoReview(taskId: number): void {
  const cfg = getSchedulerConfig();
  if (!cfg.auto_review) return;
  const task = getTask(taskId);
  if (!task || task.status !== "review" || !task.branch) return;
  if (task.review_verdict === "approve") return; // already approved
  if (task.review_cycles >= MAX_REVIEW_CYCLES) return;

  try {
    const base = git(task.repo, "merge-base", "HEAD", task.branch).trim();
    if (!git(task.repo, "log", "--oneline", `${base}..${task.branch}`).trim()) {
      return; // no commits — nothing to review
    }
  } catch {
    // odd repo/branch state: fall through and let spawnReviewer surface it
  }

  const spent =
    countEventsToday("scheduler.spawned") + countEventsToday("reviewer.auto_spawned");
  if (spent >= cfg.daily_spawn_limit) {
    logEvent("reviewer.budget_skipped", { taskId });
    notify(
      `task #${taskId} NOT auto-reviewed`,
      `${task.title} — daily spawn budget exhausted; review manually or agp review ${taskId}`,
      { priority: "high", tags: "moneybag" },
    );
    return;
  }
  try {
    const { agent } = spawnReviewer(taskId);
    logEvent("reviewer.auto_spawned", { taskId, agentId: agent.id });
  } catch (err) {
    logEvent("reviewer.spawn_error", {
      taskId,
      payload: { error: err instanceof Error ? err.message : String(err) },
    });
  }
}

/**
 * A reviewer submitted its verdict. Approve: flag the task and ping the
 * human — final merge stays theirs. Reject: feed the notes back into the
 * still-live worker (or requeue with the notes baked into the next prompt),
 * capped at MAX_REVIEW_CYCLES before blocking for human arbitration.
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
    updateTask(taskId, { review_verdict: "approve", review_notes: notes });
    notify(
      `task #${taskId} approved by reviewer`,
      `${task.title} — ready for your final review/merge${task.pr_url ? `\n${task.pr_url}` : ""}`,
      { tags: "white_check_mark" },
    );
    return getTask(taskId)!;
  }

  const cycles = task.review_cycles + 1;

  if (cycles >= MAX_REVIEW_CYCLES) {
    updateTask(taskId, {
      status: "blocked",
      review_verdict: "reject",
      review_notes: notes,
      review_cycles: cycles,
    });
    logEvent("review.escalated", { taskId, agentId });
    notify(
      `task #${taskId} blocked after ${cycles} rejected reviews`,
      `${task.title} — last reviewer notes: ${notes.slice(0, 200)}`,
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
