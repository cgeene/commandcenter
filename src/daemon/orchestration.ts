import { getAgent, listAgents, type Agent } from "../db/agents.js";
import { latestTaskEvent, logEvent } from "../db/events.js";
import { clearTriageQueueForTask } from "../db/notifications.js";
import { getTask, readyTasks, type Task } from "../db/tasks.js";
import { deliverToMainIfClear, queueDelivery } from "./notifqueue.js";
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

function pendingHumanWorkerResume(taskId: number): boolean {
  const requested = latestTaskEvent(taskId, ["task.worker_resume_requested"]);
  if (!requested) return false;
  const spawned = latestTaskEvent(taskId, ["agent.spawned"]);
  return !spawned || requested.id > spawned.id;
}

function taskPrompt(task: Task, creatorKind: Agent["kind"] | null): string {
  if (pendingHumanWorkerResume(task.id)) {
    return `[commandcenter] The human reopened approved task #${task.id}, but its managed worker launch failed and the task is queued (workspace_kind=${task.workspace_kind}). The prior approval is already invalidated and its result/review handoff is in the prompt. Call get_task(${task.id}), then spawn_worker(${task.id}); this retry will reuse the same-provider session when available. Do not create a duplicate task.`;
  }
  const reopened = latestTaskEvent(task.id, ["task.archived_resumed"]);
  const created = latestTaskEvent(task.id, ["task.created"]);
  if (reopened && (!created || reopened.id > created.id)) {
    return `[commandcenter] Archived task #${task.id} was reopened and is awaiting your triage (workspace_kind=${task.workspace_kind}). Call get_task(${task.id}), study the original task plus its Resume request section, then continue the SAME task. Do not create a duplicate task. For repo/scratch tasks, call spawn_worker(${task.id}); Command Center will resume the same provider session when its transcript still exists and otherwise start a fresh session with the preserved handoff. For portfolio tasks, re-evaluate its existing children and create only genuinely missing repository work.`;
  }
  const descriptor =
    creatorKind === "worker"
      ? `worker-filed follow-up task #${task.id}`
      : `human-submitted task #${task.id}`;
  return `[commandcenter] New ${descriptor} is awaiting your triage (workspace_kind=${task.workspace_kind}). Call get_task(${task.id}, verbose: true) — the compact default omits the prompt — study its full prompt, validate the scope and execution settings, then dispatch it. For portfolio tasks, never spawn the parent: mark it in_progress, use list_repositories, create per-repository child tasks with parent_task_id=${task.id}, preserve the parent's selected provider/model/reasoning effort unless you deliberately document an override, and spawn those isolated children. For scratch tasks, spawn the task directly and review its result/transcript rather than expecting a Git diff.`;
}

/**
 * What became of a triage delegation attempt.
 *
 * Every non-delivery used to collapse into one "skipped", which is how a
 * "Notify Claude Main" click could look like a plain failure — or, worse, like
 * nothing at all. Each reason a ping did not land now has its own name, because
 * they call for opposite reactions from the human:
 *
 * - "queued": accepted and persisted; the main's composer was busy so it
 *   arrives on the next flush. Nothing to do.
 * - "self_filed": main filed this task itself, so it is never pinged about it
 *   (it already knows and dispatches directly) — unless a human worker resume
 *   is owed on it. A live main is irrelevant here.
 * - "no_main": there is no live main window to deliver to — the only outcome
 *   that a new main agent would fix.
 * - "not_triageable": the task is not awaiting triage at all (wrong
 *   dispatch_mode/status, or its blockers are not done).
 */
export type DelegateOutcome =
  | "delivered"
  | "queued"
  | "already_queued"
  | "self_filed"
  | "no_main"
  | "not_triageable";

/** Deliver a newly-created orchestrated task to Claude main, or persist the
 *  ping for the queue flush to deliver once the main's prompt is clear. */
export async function delegateTaskToMainDetailed(
  taskId: number,
  preferredMain?: Agent,
): Promise<DelegateOutcome> {
  const task = getTask(taskId);
  if (!task || task.dispatch_mode !== "orchestrated" || task.status !== "queued") {
    return "not_triageable";
  }
  // A task main filed itself must never trigger a triage ping back to main —
  // on ANY route (immediate POST, PATCH re-queue, the manual /delegate
  // endpoint, or the idle/SessionStart hooks and periodic scheduler that call
  // delegatePendingTaskToMain). Main already knows about it and dispatches it
  // directly; it stays queued and visible via list_tasks(ready=true).
  if (
    taskCreatorKind(task.id) === "main" &&
    !pendingHumanWorkerResume(task.id)
  ) {
    return "self_filed";
  }
  if (!readyTasks("orchestrated").some((candidate) => candidate.id === task.id)) {
    return "not_triageable";
  }
  const main = availableMain(preferredMain);
  if (!main) {
    logEvent("task.awaiting_main", { taskId });
    return "no_main";
  }
  // Never merge the triage prompt into the human's mid-typed draft or fire it
  // mid-turn: deliver only when the main is idle with a genuinely clear prompt
  // (the same gate every main-delivery path shares — see deliverToMainIfClear).
  const message = taskPrompt(task, taskCreatorKind(task.id));
  const delivered = await deliverToMainIfClear(main, message);
  if (delivered !== "delivered") {
    logEvent("task.awaiting_main", {
      taskId,
      payload: { main_agent_id: main.id, reason: "main_prompt_busy" },
    });
    // Persist the ping instead of relying purely on re-derivation from task
    // state. The state-derived retry (delegatePendingTaskToMain) only ever
    // delivers the OLDEST pending task, so a deliberate ping for a task further
    // down the queue could wait behind everything in front of it — and before
    // this row existed there was no record that a delivery was owed at all, so
    // a daemon restart erased the request without a trace.
    const created = queueDelivery({
      mainId: main.id,
      taskId: task.id,
      message,
      origin: "task_triage",
      reason: "main_prompt_busy",
    });
    return created ? "queued" : "already_queued";
  }
  // Delivered live — drop any earlier queued copy so the flush cannot repeat it.
  clearTriageQueueForTask(task.id);
  logEvent("task.delegated_to_main", {
    taskId,
    agentId: main.id,
    payload: { workspace_kind: task.workspace_kind },
  });
  return "delivered";
}

/** Boolean form: true only when the triage prompt actually reached the main. */
export async function delegateTaskToMain(
  taskId: number,
  preferredMain?: Agent,
): Promise<boolean> {
  return (await delegateTaskToMainDetailed(taskId, preferredMain)) === "delivered";
}

/** On main startup/idle, re-deliver the oldest task that still needs triage. */
export async function delegatePendingTaskToMain(main: Agent): Promise<boolean> {
  if (!availableMain(main)) return false;
  const pending = readyTasks("orchestrated").filter((task) => {
    // Skip main-created tasks: they need no triage, and leaving one in the
    // pending set would park it at the queue head forever (delegatePending
    // only delivers pending[0]), starving the tasks behind it. A failed
    // human-requested worker resume is different: the task was reopened
    // outside Main's current turn and still needs a managed spawn retry.
    if (
      taskCreatorKind(task.id) === "main" &&
      !pendingHumanWorkerResume(task.id)
    ) {
      return false;
    }
    const delegated = latestTaskEvent(task.id, ["task.delegated_to_main"]);
    const queued = latestTaskEvent(task.id, [
      "task.created",
      "task.archived_resumed",
      "task.worker_resume_requested",
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
