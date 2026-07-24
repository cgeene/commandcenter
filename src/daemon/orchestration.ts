import { getAgent, listAgents, type Agent } from "../db/agents.js";
import { latestTaskEvent, logEvent } from "../db/events.js";
import { getTask, readyTasks, type Task } from "../db/tasks.js";
import { deliverToMainIfClear } from "./notifqueue.js";
import { windowExists } from "./tmux.js";

function availableMain(preferred?: Agent): Agent | undefined {
  const candidates = preferred ? [preferred] : listAgents({ live: true });
  return candidates.find(
    (agent) =>
      agent.kind === "main" &&
      ["working", "idle"].includes(agent.state) &&
      agent.tmux_target !== null &&
      windowExists(agent.tmux_target),
  );
}

/** Kind of the agent that created a task, from its task.created event
 *  (null when a human filed it via the dashboard/CLI). */
function taskCreatorKind(taskId: number): Agent["kind"] | null {
  const created = latestTaskEvent(taskId, ["task.created"]);
  if (!created?.payload) return null;
  try {
    const payload = JSON.parse(created.payload) as { creator_kind?: unknown };
    const kind = payload.creator_kind;
    return kind === "main" || kind === "worker" || kind === "reviewer"
      ? kind
      : null;
  } catch {
    return null;
  }
}

function taskPrompt(task: Task, creatorKind: Agent["kind"] | null): string {
  const reopened = latestTaskEvent(task.id, ["task.archived_resumed"]);
  const created = latestTaskEvent(task.id, ["task.created"]);
  if (reopened && (!created || reopened.id > created.id)) {
    return `[commandcenter] Archived task #${task.id} was reopened and is awaiting your triage (workspace_kind=${task.workspace_kind}). Call get_task(${task.id}), study the original task plus its Resume request section, then continue the SAME task. Do not create a duplicate task. For repo/scratch tasks, call spawn_worker(${task.id}); Command Center will resume the same provider session when its transcript still exists and otherwise start a fresh session with the preserved handoff. For portfolio tasks, re-evaluate its existing children and create only genuinely missing repository work.`;
  }
  const descriptor =
    creatorKind === "worker"
      ? `worker-filed follow-up task #${task.id}`
      : `human-submitted task #${task.id}`;
  return `[commandcenter] New ${descriptor} is awaiting your triage (workspace_kind=${task.workspace_kind}). Call get_task(${task.id}), study its full prompt, validate the scope and execution settings, then dispatch it. For portfolio tasks, never spawn the parent: mark it in_progress, use list_repositories, create per-repository child tasks with parent_task_id=${task.id}, preserve the parent's selected provider/model/reasoning effort unless you deliberately document an override, and spawn those isolated children. For scratch tasks, spawn the task directly and review its result/transcript rather than expecting a Git diff.`;
}

/** Deliver a newly-created orchestrated task to Claude main, or leave it queued. */
export async function delegateTaskToMain(
  taskId: number,
  preferredMain?: Agent,
): Promise<boolean> {
  const task = getTask(taskId);
  if (!task || task.dispatch_mode !== "orchestrated" || task.status !== "queued") {
    return false;
  }
  // A task main filed itself must never trigger a triage ping back to main —
  // on ANY route (immediate POST, PATCH re-queue, the manual /delegate
  // endpoint, or the idle/SessionStart hooks and periodic scheduler that call
  // delegatePendingTaskToMain). Main already knows about it and dispatches it
  // directly; it stays queued and visible via list_tasks(ready=true).
  if (taskCreatorKind(task.id) === "main") {
    return false;
  }
  if (!readyTasks("orchestrated").some((candidate) => candidate.id === task.id)) {
    return false;
  }
  const main = availableMain(preferredMain);
  if (!main) {
    logEvent("task.awaiting_main", { taskId });
    return false;
  }
  // Never merge the triage prompt into the human's mid-typed draft or fire it
  // mid-turn: deliver only when the main is idle with a genuinely clear prompt
  // (the same gate every main-delivery path shares — see deliverToMainIfClear).
  // Otherwise leave the task queued — the main's idle/Stop hooks and the
  // scheduler's periodic delegatePendingTaskToLiveMain retry it.
  const delivered = await deliverToMainIfClear(
    main,
    taskPrompt(task, taskCreatorKind(task.id)),
  );
  if (delivered !== "delivered") {
    logEvent("task.awaiting_main", {
      taskId,
      payload: { main_agent_id: main.id, reason: "main_prompt_busy" },
    });
    return false;
  }
  logEvent("task.delegated_to_main", {
    taskId,
    agentId: main.id,
    payload: { workspace_kind: task.workspace_kind },
  });
  return true;
}

/** On main startup/idle, re-deliver the oldest task that still needs triage. */
export async function delegatePendingTaskToMain(main: Agent): Promise<boolean> {
  if (!availableMain(main)) return false;
  const pending = readyTasks("orchestrated").filter((task) => {
    // Skip main-created tasks: they need no triage, and leaving one in the
    // pending set would park it at the queue head forever (delegatePending
    // only delivers pending[0]), starving the tasks behind it.
    if (taskCreatorKind(task.id) === "main") return false;
    const delegated = latestTaskEvent(task.id, ["task.delegated_to_main"]);
    const queued = latestTaskEvent(task.id, [
      "task.created",
      "task.archived_resumed",
      "task.reopened",
      "task.requeued",
    ]);
    return (
      !delegated ||
      delegated.agent_id !== main.id ||
      Boolean(queued && queued.id > delegated.id)
    );
  });
  const task = pending[0];
  return task ? delegateTaskToMain(task.id, main) : false;
}

/** Periodic recovery for tasks that become ready after a blocker completes. */
export async function delegatePendingTaskToLiveMain(): Promise<boolean> {
  const main = availableMain();
  return main ? delegatePendingTaskToMain(main) : false;
}

export function pendingOrchestratedTasks(): Task[] {
  return readyTasks("orchestrated");
}
