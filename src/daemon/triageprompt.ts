import type { Agent } from "../db/agents.js";
import { latestTaskEvent } from "../db/events.js";
import { getTask, type Task } from "../db/tasks.js";

/**
 * The text a triage ping carries, and how batchable that text is.
 *
 * Lives apart from orchestration.ts because BOTH delivery paths need the flavor:
 * the live batch (orchestration.deliverTriage) and the deferred-queue flush
 * (notifqueue.buildTriageMessage), and notifqueue cannot import orchestration
 * without a cycle. A queued row stores only its rendered message, so the flush
 * re-derives the flavor from task state exactly as the live path does.
 */

/**
 * Why a task is being put in front of the orchestrator.
 *
 * "new" is the ordinary case and says nothing a compact list of task ids does
 * not already say, so a batch may collapse it. The two resume flavors carry
 * instructions that exist specifically to stop the orchestrator creating a
 * DUPLICATE task, and no generic list can express them — a batch must keep their
 * own prompt verbatim (see batchableTriagePrompt).
 */
export type TriageFlavor = "new" | "archived_resume" | "worker_resume_retry";

/** Kind of the agent that created a task, from its task.created event
 *  (null when a human filed it via the dashboard/CLI). */
export function taskCreatorKind(taskId: number): Agent["kind"] | null {
  const created = latestTaskEvent(taskId, ["task.created"]);
  if (!created?.payload) return null;
  try {
    const payload = JSON.parse(created.payload) as { creator_kind?: unknown };
    const kind = payload.creator_kind;
    return kind === "main" || kind === "worker" || kind === "reviewer" ? kind : null;
  } catch {
    return null;
  }
}

/** The human reopened an approved task but its managed worker launch failed, so
 *  the task is queued awaiting a spawn retry rather than fresh triage. */
export function pendingHumanWorkerResume(taskId: number): boolean {
  const requested = latestTaskEvent(taskId, ["task.worker_resume_requested"]);
  if (!requested) return false;
  const spawned = latestTaskEvent(taskId, ["agent.spawned"]);
  return !spawned || requested.id > spawned.id;
}

export function triageFlavor(taskId: number): TriageFlavor {
  if (pendingHumanWorkerResume(taskId)) return "worker_resume_retry";
  const reopened = latestTaskEvent(taskId, ["task.archived_resumed"]);
  const created = latestTaskEvent(taskId, ["task.created"]);
  if (reopened && (!created || reopened.id > created.id)) return "archived_resume";
  return "new";
}

/** The full triage prompt for one task. */
export function triagePrompt(task: Task, creatorKind: Agent["kind"] | null): string {
  switch (triageFlavor(task.id)) {
    case "worker_resume_retry":
      return `[commandcenter] The human reopened approved task #${task.id}, but its managed worker launch failed and the task is queued (workspace_kind=${task.workspace_kind}). The prior approval is already invalidated and its result/review handoff is in the prompt. Call get_task(${task.id}), then spawn_worker(${task.id}); this retry will reuse the same-provider session when available. Do not create a duplicate task.`;
    case "archived_resume":
      return `[commandcenter] Archived task #${task.id} was reopened and is awaiting your triage (workspace_kind=${task.workspace_kind}). Call get_task(${task.id}), study the original task plus its Resume request section, then continue the SAME task. Do not create a duplicate task. For repo/scratch tasks, call spawn_worker(${task.id}); Command Center will resume the same provider session when its transcript still exists and otherwise start a fresh session with the preserved handoff. For portfolio tasks, re-evaluate its existing children and create only genuinely missing repository work.`;
    default: {
      const descriptor =
        creatorKind === "worker"
          ? `worker-filed follow-up task #${task.id}`
          : `human-submitted task #${task.id}`;
      return `[commandcenter] New ${descriptor} is awaiting your triage (workspace_kind=${task.workspace_kind}). Call get_task(${task.id}, verbose: true) — the compact default omits the prompt — study its full prompt, validate the scope and execution settings, then dispatch it. For portfolio tasks, never spawn the parent: mark it in_progress, use list_repositories, create per-repository child tasks with parent_task_id=${task.id}, preserve the parent's selected provider/model/reasoning effort unless you deliberately document an override, and spawn those isolated children. For scratch tasks, spawn the task directly and review its result/transcript rather than expecting a Git diff.`;
    }
  }
}

/**
 * Whether a batch may replace this task's prompt with a line in a shared list.
 *
 * Only the ordinary "new task" flavor may be collapsed. A resume-flavored ping
 * must survive batching intact: dropping it costs the orchestrator the
 * "continue the SAME task / do not create a duplicate task" instruction and the
 * spawn_worker retry step, and a duplicate task is exactly what those sentences
 * exist to prevent. `taskId` that no longer resolves is treated as collapsible —
 * the flush drops such rows as stale before composing anything.
 */
export function batchableTriagePrompt(taskId: number | null): boolean {
  if (taskId == null || !getTask(taskId)) return true;
  return triageFlavor(taskId) === "new";
}
