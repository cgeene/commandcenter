import { getAgent, listAgents, type Agent } from "../db/agents.js";
import { latestTaskEvent, logEvent } from "../db/events.js";
import { clearTriageQueueForTask } from "../db/notifications.js";
import { getTask, readyTasks, type Task } from "../db/tasks.js";
import {
  buildTriageMessage,
  deliverToMainIfClear,
  queueDelivery,
} from "./notifqueue.js";
import { windowExists } from "./tmux.js";

/**
 * How long an UNACKED task waits before the catch-up path pings main about it
 * again. The ack (task.triaged_at, stamped when the orchestrator reads the full
 * record) is what normally stops re-delivery; this is the safety net for the
 * case the ack cannot cover — a main that was handed the ping and then died,
 * compacted, or simply never read the task. Without it, one delivered-but-
 * unread ping would strand the task in the queue silently forever.
 */
export const TRIAGE_REDELIVER_AFTER_MS = 10 * 60_000;

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
 * "queued" is the distinction that matters to the human: the ping was accepted
 * and persisted, but the main's composer was busy so it will arrive later. It
 * used to be indistinguishable from "skipped", which is how a "Notify Claude
 * Main" click could look like a plain failure — or, worse, like nothing at all.
 */
export type DelegateOutcome = "delivered" | "queued" | "already_queued" | "skipped";

/**
 * Send one triage ping covering `tasks` — one message however many tasks it
 * covers (buildTriageMessage sends a single task's prompt verbatim and collapses
 * several into one compact list), so a queue that fills up while main is busy
 * costs it one turn to read, not one per task.
 *
 * On a busy/mid-draft prompt each task is persisted as its own queued row: the
 * flush re-validates and re-batches them individually, so a task dispatched in
 * the meantime is dropped instead of delivered late.
 */
async function deliverTriage(main: Agent, tasks: Task[]): Promise<DelegateOutcome> {
  const items = tasks.map((task) => ({
    task,
    task_id: task.id,
    message: taskPrompt(task, taskCreatorKind(task.id)),
  }));
  const delivered = await deliverToMainIfClear(main, buildTriageMessage(items));
  if (delivered !== "delivered") {
    let created = false;
    for (const it of items) {
      logEvent("task.awaiting_main", {
        taskId: it.task_id,
        payload: { main_agent_id: main.id, reason: "main_prompt_busy" },
      });
      // Persist the ping instead of relying purely on re-derivation from task
      // state. The state-derived retry (delegatePendingTaskToMain) is gated on
      // an ack and a cooldown, and before this row existed there was no record
      // that a delivery was owed at all, so a daemon restart erased a
      // deliberate ping without a trace.
      created =
        queueDelivery({
          mainId: main.id,
          taskId: it.task_id,
          message: it.message,
          origin: "task_triage",
          reason: "main_prompt_busy",
        }) || created;
    }
    return created ? "queued" : "already_queued";
  }
  for (const it of items) {
    // Delivered live — drop any earlier queued copy so the flush cannot repeat it.
    clearTriageQueueForTask(it.task_id);
    logEvent("task.delegated_to_main", {
      taskId: it.task_id,
      agentId: main.id,
      payload: {
        workspace_kind: it.task.workspace_kind,
        batched: items.length > 1 ? items.length : undefined,
      },
    });
  }
  return "delivered";
}

/** Deliver a newly-created orchestrated task to Claude main, or persist the
 *  ping for the queue flush to deliver once the main's prompt is clear. */
export async function delegateTaskToMainDetailed(
  taskId: number,
  preferredMain?: Agent,
): Promise<DelegateOutcome> {
  const task = getTask(taskId);
  if (!task || task.dispatch_mode !== "orchestrated" || task.status !== "queued") {
    return "skipped";
  }
  // Already triaged: the orchestrator has read this task and left it queued
  // deliberately (sequenced behind other work), so pinging it again just burns
  // a turn on re-reading state it already has. Every route lands here, which
  // matters most for the PATCH route — editing a queued task's priority or
  // blocker used to re-deliver it as if it were new. An edit that changes what
  // triage judged, or an explicit re-flag, clears the ack (see updateTask /
  // clearTaskTriageAck) and delivery resumes.
  if (task.triaged_at) return "skipped";
  // A task main filed itself must never trigger a triage ping back to main —
  // on ANY route (immediate POST, PATCH re-queue, the manual /delegate
  // endpoint, or the idle/SessionStart hooks and periodic scheduler that call
  // delegatePendingTaskToMain). Main already knows about it and dispatches it
  // directly; it stays queued and visible via list_tasks(ready=true).
  if (
    taskCreatorKind(task.id) === "main" &&
    !pendingHumanWorkerResume(task.id)
  ) {
    return "skipped";
  }
  if (!readyTasks("orchestrated").some((candidate) => candidate.id === task.id)) {
    return "skipped";
  }
  const main = availableMain(preferredMain);
  if (!main) {
    logEvent("task.awaiting_main", { taskId });
    return "skipped";
  }
  // Never merge the triage prompt into the human's mid-typed draft or fire it
  // mid-turn: deliver only when the main is idle with a genuinely clear prompt
  // (the same gate every main-delivery path shares — see deliverToMainIfClear).
  return deliverTriage(main, [task]);
}

/** Boolean form: true only when the triage prompt actually reached the main. */
export async function delegateTaskToMain(
  taskId: number,
  preferredMain?: Agent,
): Promise<boolean> {
  return (await delegateTaskToMainDetailed(taskId, preferredMain)) === "delivered";
}

/**
 * Every ready task this main still owes triage on, queue order.
 *
 * The ack is the primary gate: a task the orchestrator has read (triaged_at) is
 * never re-delivered, however it is left — including left queued on purpose,
 * which is exactly the case that used to re-ping forever. Everything else is
 * the "did this main ever get told" question the delegation events answer, plus
 * a cooldown so a ping that was delivered but never acted on is eventually
 * repeated rather than lost.
 */
export function pendingTriageTasks(main: Agent, nowMs: number = Date.now()): Task[] {
  return readyTasks("orchestrated").filter((task) => {
    // Skip main-created tasks: they need no triage. A failed human-requested
    // worker resume is different — the task was reopened outside Main's current
    // turn and still needs a managed spawn retry.
    if (
      taskCreatorKind(task.id) === "main" &&
      !pendingHumanWorkerResume(task.id)
    ) {
      return false;
    }
    if (task.triaged_at) return false;
    const delegated = latestTaskEvent(task.id, ["task.delegated_to_main"]);
    const queued = latestTaskEvent(task.id, [
      "task.created",
      "task.archived_resumed",
      "task.worker_resume_requested",
      "task.reopened",
      "task.requeued",
      // Losing a triage ack (edited, re-queued, or re-flagged by hand) is itself
      // a reason to deliver again, whatever the delegation history says.
      "task.triage_reflagged",
    ]);
    if (
      !delegated ||
      delegated.agent_id !== main.id ||
      Boolean(queued && queued.id > delegated.id)
    ) {
      return true;
    }
    // Delivered to THIS main, not re-queued since, and still not acked. The
    // orchestrator may have died holding it or never read it, so nudge again —
    // but on a cooldown, not on every idle tick.
    const at = Date.parse(delegated.ts);
    return Number.isFinite(at) && nowMs - at >= TRIAGE_REDELIVER_AFTER_MS;
  });
}

/**
 * On main startup/idle, re-deliver everything that still needs triage — as ONE
 * message. This used to send pending[0] only, so a queue of N tasks cost N
 * separate wake-ups (each one a full turn spent re-reading state) as the main
 * went idle between them.
 */
export async function delegatePendingTaskToMain(
  main: Agent,
  opts: { nowMs?: number } = {},
): Promise<boolean> {
  if (!availableMain(main)) return false;
  const pending = pendingTriageTasks(main, opts.nowMs);
  if (pending.length === 0) return false;
  if (pending.length === 1) {
    // Single task: go through the full per-task route so its own guards
    // (ready-check, main-created skip, ack) apply exactly as on any other path.
    return delegateTaskToMain(pending[0].id, main);
  }
  return (await deliverTriage(main, pending)) === "delivered";
}

/** Periodic recovery for tasks that become ready after a blocker completes. */
export async function delegatePendingTaskToLiveMain(): Promise<boolean> {
  const main = availableMain();
  return main ? delegatePendingTaskToMain(main) : false;
}

export function pendingOrchestratedTasks(): Task[] {
  return readyTasks("orchestrated");
}
