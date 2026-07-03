import { getAgent, updateAgent } from "../db/agents.js";
import { countEventsToday, countTaskEvents, logEvent } from "../db/events.js";
import { getSchedulerConfig } from "../db/settings.js";
import { getTask, updateTask, type Task } from "../db/tasks.js";
import { notify } from "./notify.js";
import { spawnReviewer } from "./spawn.js";
import { sendText, windowExists } from "./tmux.js";
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
 * Auto-spawn an adversarial reviewer when an AUTONOMOUS (scheduler-spawned)
 * task reaches review. Manual tasks are reviewed on demand only. Auto
 * reviews draw from the same daily budget as autonomous worker spawns.
 */
export function maybeAutoReview(taskId: number): void {
  const cfg = getSchedulerConfig();
  if (!cfg.auto_review) return;
  const task = getTask(taskId);
  if (!task || task.status !== "review" || !task.branch) return;
  if (countTaskEvents(taskId, "scheduler.spawned") === 0) return; // manual task
  if (task.review_verdict === "approve") return; // already approved
  if (task.review_cycles >= MAX_REVIEW_CYCLES) return;

  const spent =
    countEventsToday("scheduler.spawned") + countEventsToday("reviewer.auto_spawned");
  if (spent >= cfg.daily_spawn_limit) {
    logEvent("reviewer.budget_skipped", { taskId });
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
    updateTask(taskId, { review_verdict: "approve", review_notes: notes });
    notify(
      `task #${taskId} approved by reviewer`,
      `${task.title} — ready for your final review/merge`,
      { tags: "white_check_mark" },
    );
    return getTask(taskId)!;
  }

  const cycles = task.review_cycles + 1;
  const worker = task.agent_id ? getAgent(task.agent_id) : undefined;
  const workerAlive =
    worker &&
    worker.state !== "dead" &&
    worker.tmux_target !== null &&
    windowExists(worker.tmux_target);

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
  } else if (workerAlive) {
    // verdict cleared so the next pass through review gets a fresh reviewer
    updateTask(taskId, {
      status: "in_progress",
      review_verdict: null,
      review_notes: notes,
      review_cycles: cycles,
    });
    updateAgent(worker.id, { state: "working" });
    await sendText(
      worker.tmux_target!,
      `An independent reviewer REJECTED your work on this task. Address every point below, re-verify, update your result_summary, then stop.\n\n${notes}`,
    );
  } else {
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
