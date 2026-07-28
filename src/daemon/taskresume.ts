import fs from "node:fs";
import { getAgent, listAgents } from "../db/agents.js";
import { countTaskEvents, logEvent } from "../db/events.js";
import {
  getTask,
  openDependents,
  updateTask,
  type Task,
} from "../db/tasks.js";
import { clearReviewSnapshot } from "./reviewsnapshot.js";
import { killAgent, spawnWorker } from "./spawn.js";
import { findProviderTranscript } from "./transcript.js";
import { markPrDraft } from "./prdraft.js";
import { git, removeWorktree } from "./worktree.js";
import {
  allocateScratchWorkspace,
  validateScratchWorkspace,
  WorkspaceValidationError,
} from "./workspaces.js";

const MAX_TASK_PROMPT_LENGTH = 100_000;
const ARCHIVED_STATUSES = new Set(["done", "cancelled"]);
const TERMINAL_PR_STATES = new Set(["merged", "closed"]);

export class TaskResumeValidationError extends Error {}
export class TaskResumeLaunchError extends Error {}

export interface TaskResumeResult {
  task: Task;
  previous_status: "done" | "cancelled";
  killed_agents: number[];
  session_mode: "same_provider_session" | "fresh_session";
  previous_branch: string | null;
  open_dependents: Task[];
}

export interface ReviewedWorkerResumeResult {
  task: Task;
  agent: ReturnType<typeof spawnWorker>["agent"];
  previous_status: "review";
  previous_agent_id: number | null;
  session_mode: "same_provider_session" | "fresh_session";
}

function resumedBranch(task: Task, attempt: number): string {
  return `agent/task-${task.id}-resume-${attempt}`;
}

function sameProviderSessionAvailable(task: Task): boolean {
  const priorAgent = listAgents()
    .filter(
      (agent) =>
        agent.kind === "worker" &&
        agent.task_id === task.id &&
        agent.provider === task.worker_provider &&
        agent.session_id === task.session_id,
    )
    .at(-1);
  const sameProvider =
    task.session_provider === task.worker_provider ||
    (task.session_provider === null && task.worker_provider === "claude");
  return Boolean(
    task.session_id &&
      sameProvider &&
      findProviderTranscript(
        task.worker_provider,
        task.session_id,
        priorAgent?.transcript_path,
      ),
  );
}

async function returnOpenPrToDraft(task: Task): Promise<boolean> {
  const terminalPr = Boolean(
    task.pr_state && TERMINAL_PR_STATES.has(task.pr_state),
  );
  if (terminalPr) {
    throw new TaskResumeValidationError(
      "the pull request is already closed; wait for the task to archive, then resume the archived task",
    );
  }
  const mustRedraft =
    task.open_pr !== 0 &&
    Boolean(task.pr_url) &&
    task.pr_is_draft === 0;
  if (!mustRedraft) return false;
  try {
    await markPrDraft(task.pr_url!);
  } catch {
    throw new TaskResumeValidationError(
      "the existing pull request could not be returned to draft; the task was not resumed",
    );
  }
  return true;
}

/**
 * Reopen a reviewer-approved task whose worker is no longer live, then
 * immediately spawn a managed worker on the same task/worktree/session.
 *
 * Resuming can change the reviewed tree, so the old approval is invalidated
 * before the worker starts. Prior result/review context is appended to the
 * prompt so a missing provider transcript still has a complete handoff.
 */
export async function resumeReviewedWorker(
  taskId: number,
  opts?: {
    instructions?: string;
    actorAgentId?: number;
    fresh?: boolean;
  },
): Promise<ReviewedWorkerResumeResult> {
  let task = getTask(taskId);
  if (!task) throw new TaskResumeValidationError("task not found");
  const actor = opts?.actorAgentId
    ? getAgent(opts.actorAgentId)
    : undefined;
  if (task.status !== "review" || task.review_verdict !== "approve") {
    throw new TaskResumeValidationError(
      `task ${task.id} is not an approved task awaiting publication`,
    );
  }
  if (task.workspace_kind === "portfolio") {
    throw new TaskResumeValidationError(
      "portfolio tasks have no single worker session to resume",
    );
  }
  const liveTaskAgent = listAgents({ live: true }).find(
    (agent) => agent.task_id === task!.id && agent.kind !== "main",
  );
  if (liveTaskAgent) {
    throw new TaskResumeValidationError(
      `task ${task.id} still has a live ${liveTaskAgent.kind}`,
    );
  }

  const instructions = opts?.instructions?.trim();
  const priorContext = [
    "",
    "---",
    "",
    "## Human-requested worker resume after approval",
    "",
    "The previous automated approval is being invalidated because this worker may change the approved result.",
    task.result_summary
      ? `Previously approved result:\n${task.result_summary}`
      : "Previously approved result: none recorded.",
    task.review_notes
      ? `Previous review notes:\n${task.review_notes}`
      : "Previous review notes: none recorded.",
    instructions
      ? `New instructions from the human:\n${instructions}`
      : "New instructions from the human: resume the same worker, review the existing result, and continue from where it stopped.",
  ].join("\n\n");
  const prompt = `${task.prompt.trimEnd()}${priorContext}`;
  if (prompt.length > MAX_TASK_PROMPT_LENGTH) {
    throw new TaskResumeValidationError(
      "the task plus resume instructions exceed the task prompt limit",
    );
  }

  const returnedToDraft = await returnOpenPrToDraft(task);

  // markPrDraft is asynchronous. Re-read and revalidate before mutating so two
  // concurrent resume requests cannot both reopen and spawn this task.
  task = getTask(taskId)!;
  if (task.status !== "review" || task.review_verdict !== "approve") {
    throw new TaskResumeValidationError(
      "the task changed while its worker was being resumed; refresh and try again",
    );
  }
  if (
    listAgents({ live: true }).some(
      (agent) => agent.task_id === task!.id && agent.kind !== "main",
    )
  ) {
    throw new TaskResumeValidationError(
      "the task acquired a live agent while its worker was being resumed",
    );
  }

  const sessionAvailable = sameProviderSessionAvailable(task);
  const previousAgentId = task.agent_id;
  if (task.review_snapshot_tree) clearReviewSnapshot(task.id);
  updateTask(task.id, {
    prompt,
    status: "queued",
    agent_id: null,
    result_summary: null,
    review_verdict: null,
    review_notes: null,
    review_cycles: 0,
    review_head_sha: null,
    review_result_hash: null,
    review_snapshot_base: null,
    review_snapshot_tree: null,
    publication_state:
      task.publication_mode === "human" && task.workspace_kind === "repo"
        ? "editing"
        : task.publication_state,
    ...(returnedToDraft ? { pr_is_draft: 1 } : {}),
  });
  logEvent("task.worker_resume_requested", {
    taskId: task.id,
    agentId: actor?.kind === "main" ? actor.id : undefined,
    payload: {
      from: "review",
      approval_invalidated: true,
      session_preserved: Boolean(task.session_id),
    },
  });

  let spawned: ReturnType<typeof spawnWorker>;
  try {
    spawned = spawnWorker(task.id, undefined, { fresh: opts?.fresh });
  } catch {
    logEvent("task.worker_resume_failed", {
      taskId: task.id,
      payload: {
        reason: "worker launch failed",
        task_status: getTask(task.id)?.status,
      },
    });
    throw new TaskResumeLaunchError(
      "the task was safely reopened, but its worker could not start; it remains queued for retry",
    );
  }
  logEvent("task.worker_resumed", {
    taskId: task.id,
    agentId: spawned.agent.id,
    payload: {
      previous_agent_id: previousAgentId,
      session_mode:
        sessionAvailable && !opts?.fresh
          ? "same_provider_session"
          : "fresh_session",
    },
  });
  return {
    ...spawned,
    previous_status: "review",
    previous_agent_id: previousAgentId,
    session_mode:
      sessionAvailable && !opts?.fresh
        ? "same_provider_session"
        : "fresh_session",
  };
}

/**
 * Reopen a finished task without creating a duplicate task.
 *
 * The provider session, provider/model choice, token accounting, JIRA link,
 * workspace, and unfinished branch are durable task history and survive.
 * Completion/review/publication state is attempt-local and must be cleared,
 * otherwise a Stop hook could accept the prior result or a stale approval.
 *
 * Prior result/review/PR context is copied into the revised task prompt before
 * those fields are cleared. That gives both a provider-session resume and the
 * fresh-session fallback the complete handoff.
 */
export async function resumeArchivedTask(
  taskId: number,
  opts?: { instructions?: string; actorAgentId?: number },
): Promise<TaskResumeResult> {
  const task = getTask(taskId);
  if (!task) throw new TaskResumeValidationError("task not found");
  if (!ARCHIVED_STATUSES.has(task.status)) {
    throw new TaskResumeValidationError(
      `task ${task.id} is ${task.status}; only archived done/cancelled tasks can be resumed`,
    );
  }

  const instructions = opts?.instructions?.trim();
  const priorContext = [
    "",
    "---",
    "",
    `## Resume request ${countTaskEvents(task.id, "task.archived_resumed") + 1}`,
    "",
    task.result_summary
      ? `Previous result:\n${task.result_summary}`
      : "Previous result: none recorded.",
    task.review_notes
      ? `Previous review notes:\n${task.review_notes}`
      : "Previous review notes: none recorded.",
    task.pr_url
      ? `Previous pull request: ${task.pr_url}${task.pr_state ? ` (${task.pr_state})` : ""}`
      : "Previous pull request: none.",
    instructions
      ? `New instructions from the human:\n${instructions}`
      : "New instructions from the human: continue this task from its archived state and verify the complete result again.",
  ].join("\n\n");
  const prompt = `${task.prompt.trimEnd()}${priorContext}`;
  if (prompt.length > MAX_TASK_PROMPT_LENGTH) {
    throw new TaskResumeValidationError(
      "the archived task plus resume instructions exceed the task prompt limit",
    );
  }

  const terminalPr = Boolean(
    task.pr_state && TERMINAL_PR_STATES.has(task.pr_state),
  );
  const mustRedraft = terminalPr ? false : await returnOpenPrToDraft(task);
  if (
    terminalPr &&
    task.workspace_kind === "repo" &&
    task.worktree &&
    fs.existsSync(task.worktree)
  ) {
    let dirty: string;
    try {
      dirty = git(task.worktree, "status", "--porcelain").trim();
    } catch {
      throw new TaskResumeValidationError(
        "the archived task's retained worktree cannot be verified safely",
      );
    }
    if (dirty) {
      throw new TaskResumeValidationError(
        "the archived task's retained worktree has uncommitted changes; inspect or preserve them before resuming",
      );
    }
  }

  const killedAgents: number[] = [];
  for (const agent of listAgents({ live: true })) {
    if (agent.task_id !== task.id || agent.kind === "main") continue;
    killAgent(agent.id, { rmWorktree: agent.kind === "reviewer" });
    killedAgents.push(agent.id);
  }

  if (task.review_snapshot_tree) clearReviewSnapshot(task.id);

  let repo = task.repo;
  let worktree = task.worktree;
  if (terminalPr && task.workspace_kind === "repo" && worktree) {
    if (fs.existsSync(worktree)) removeWorktree(task.repo, worktree);
    worktree = null;
  }
  if (task.workspace_kind === "scratch") {
    try {
      validateScratchWorkspace(task.repo);
    } catch (error) {
      if (!(error instanceof WorkspaceValidationError)) throw error;
      repo = allocateScratchWorkspace();
      worktree = null;
    }
  }

  const attempt = countTaskEvents(task.id, "task.archived_resumed") + 1;
  const nextBranch =
    task.workspace_kind === "repo" && terminalPr
      ? resumedBranch(task, attempt)
      : task.branch;

  const reopened = updateTask(task.id, {
    prompt,
    repo,
    worktree,
    branch: nextBranch,
    status: "queued",
    agent_id: null,
    result_summary: null,
    review_verdict: null,
    review_notes: null,
    review_cycles: 0,
    review_head_sha: null,
    review_result_hash: null,
    ...(terminalPr
      ? {
          pr_url: null,
          pr_feedback_at: null,
          pr_state: null,
          pr_checks: null,
          pr_is_draft: null,
          human_approved_at: null,
          pr_synced_at: null,
          pr_sync_fails: 0,
        }
      : mustRedraft
        ? { pr_is_draft: 1 }
        : {}),
    publication_state:
      task.publication_mode === "human" && task.workspace_kind === "repo"
        ? "editing"
        : task.publication_state,
    review_snapshot_base: null,
    review_snapshot_tree: null,
  })!;

  const actor = opts?.actorAgentId
    ? getAgent(opts.actorAgentId)
    : undefined;
  const sessionAvailable = sameProviderSessionAvailable(task);
  logEvent("task.archived_resumed", {
    taskId: task.id,
    agentId: actor?.id,
    payload: {
      reason: "archived task resumed",
      from: task.status,
      session_preserved: Boolean(task.session_id),
      workspace_recreated: repo !== task.repo,
      branch_rotated: nextBranch !== task.branch,
    },
  });

  return {
    task: reopened,
    previous_status: task.status as "done" | "cancelled",
    killed_agents: killedAgents,
    session_mode: sessionAvailable
      ? "same_provider_session"
      : "fresh_session",
    previous_branch: task.branch,
    open_dependents: openDependents(task.id),
  };
}
