import { getAgent, listAgents, type Agent } from "../db/agents.js";
import { latestTaskEvent, logEvent } from "../db/events.js";
import {
  clearTriageQueueForTask,
  listQueuedNotifications,
} from "../db/notifications.js";
import { getTask, type Task } from "../db/tasks.js";
import {
  buildTriageMessage,
  deliverToMainIfClear,
  queueDelivery,
} from "./notifqueue.js";
import { dispatchableTasks } from "./serial.js";
import { windowExists } from "./tmux.js";
import {
  pendingHumanWorkerResume,
  taskCreatorKind,
  triagePrompt,
} from "./triageprompt.js";

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

/**
 * Whether the task has been triaged and so must not be pinged again.
 *
 * A property of the TASK, not of any one orchestrator session: triaged_at is set
 * by the orchestrator's own full read and cleared whenever the task changes in a
 * way that needs fresh triage (see updateTask / clearTaskTriageAck). Every
 * consumer of the ack — this module and notifqueue's staleness check — reads it
 * exactly this way, so a queued ping can never be suppressed on one side and
 * kept alive on the other.
 *
 * A task acked by an orchestrator that later dies stays quiet rather than
 * re-surfacing on a timer; it remains visible (with triaged_at) in
 * list_tasks(ready=true), which is where a fresh main is told to look for work it
 * has not handled. Tasks that were never acked keep their periodic redelivery
 * (see TRIAGE_REDELIVER_AFTER_MS).
 */
function triaged(task: Task): boolean {
  return task.triaged_at !== null;
}

/** Task-triage rows already persisted for this main, by task id. */
function queuedTriageRows(mainId: number): Map<number, string> {
  const rows = new Map<number, string>();
  for (const row of listQueuedNotifications(mainId)) {
    if (row.origin === "task_triage" && row.task_id != null) {
      rows.set(row.task_id, row.message);
    }
  }
  return rows;
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
 *   dispatch_mode/status, its blockers are not done, or its repo is configured
 *   strict-serial and another task is holding it).
 */
export type DelegateOutcome =
  | "delivered"
  | "queued"
  | "already_queued"
  | "already_triaged"
  | "self_filed"
  | "no_main"
  | "not_triageable";

/**
 * Send one triage ping covering `tasks` — one message however many tasks it
 * covers (buildTriageMessage sends a single task's prompt verbatim and collapses
 * ordinary new-task pings into one compact list), so a queue that fills up while
 * main is busy costs it one turn to read, not one per task.
 *
 * On a busy/mid-draft prompt each task is persisted as its own queued row: the
 * flush re-validates and re-batches them individually, so a task dispatched in
 * the meantime is dropped instead of delivered late.
 *
 * `retry` marks the periodic/idle catch-up, whose calls repeat on a timer rather
 * than on something happening. That path must be silent once the work is already
 * persisted (see below); event-driven callers always try, so a human's manual
 * "notify main" is never answered with silence.
 */
async function deliverTriage(
  main: Agent,
  tasks: Task[],
  opts: { retry?: boolean } = {},
): Promise<DelegateOutcome> {
  const items = tasks.map((task) => ({
    task,
    task_id: task.id,
    message: triagePrompt(task, taskCreatorKind(task.id)),
  }));
  // What is already owed to this main, and therefore already recorded. A row
  // whose stored message no longer matches (the task was reopened into a
  // different flavor of ping) still needs refreshing.
  const persisted = queuedTriageRows(main.id);
  const unrecorded = items.filter((it) => persisted.get(it.task_id) !== it.message);
  // The whole batch is already queued and unchanged: the flush owns it now (the
  // same watchdog tick that calls us also flushes every idle main, and the Stop
  // hook forces a flush), so trying again achieves nothing except noise. The
  // watchdog runs every 10s, so without this a 12-task queue re-logged
  // task.awaiting_main + delivery.persisted for all 12 tasks per tick and buried
  // the very event feed this deduplication is meant to keep readable.
  if (opts.retry && unrecorded.length === 0) return "already_queued";
  const delivered = await deliverToMainIfClear(main, buildTriageMessage(items));
  if (delivered !== "delivered") {
    let created = false;
    // Only tasks whose queue row does not already say this: repeating the events
    // for a row that is unchanged records nothing new.
    for (const it of unrecorded) {
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
    return "not_triageable";
  }
  // Already triaged: the orchestrator has read this task and left it queued
  // deliberately (sequenced behind other work), so pinging it again just burns a
  // turn on re-reading state it already has. Every route lands here, which
  // matters most for the PATCH route — editing a queued task's priority or
  // blocker used to re-deliver it as if it were new. An edit that changes what
  // triage judged, or an explicit re-flag, clears the ack (see updateTask /
  // clearTaskTriageAck) and delivery resumes.
  if (triaged(task)) return "already_triaged";
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
  if (!dispatchableTasks("orchestrated").some((candidate) => candidate.id === task.id)) {
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
 * The ack is the primary gate: a triaged task is never re-delivered, however it
 * is left — including left queued on purpose, which is exactly the case that
 * used to re-ping forever. Everything else is the "did this main ever get told"
 * question the delegation events answer, plus a cooldown so a ping that was
 * delivered but never acknowledged is eventually repeated rather than lost.
 */
export function pendingTriageTasks(main: Agent, nowMs: number = Date.now()): Task[] {
  return dispatchableTasks("orchestrated").filter((task) => {
    // Skip main-created tasks: they need no triage. A failed human-requested
    // worker resume is different — the task was reopened outside Main's current
    // turn and still needs a managed spawn retry.
    if (
      taskCreatorKind(task.id) === "main" &&
      !pendingHumanWorkerResume(task.id)
    ) {
      return false;
    }
    if (triaged(task)) return false;
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
 * On main startup/idle, and on every watchdog tick, deliver everything that
 * still needs triage — as ONE message. This used to send pending[0] only, so a
 * queue of N tasks cost N separate wake-ups (each one a full turn spent
 * re-reading state) as the main went idle between them.
 *
 * pendingTriageTasks has already applied every guard the per-task route applies
 * (ready, main-created, ack), so this goes straight to delivery. It is the timer-
 * driven path, hence retry: once the pending set is fully persisted it stays
 * quiet and lets the queue flush finish the job.
 */
export async function delegatePendingTaskToMain(
  main: Agent,
  opts: { nowMs?: number } = {},
): Promise<boolean> {
  if (!availableMain(main)) return false;
  const pending = pendingTriageTasks(main, opts.nowMs);
  if (pending.length === 0) return false;
  return (await deliverTriage(main, pending, { retry: true })) === "delivered";
}

/** Periodic recovery for tasks that become ready after a blocker completes. */
export async function delegatePendingTaskToLiveMain(): Promise<boolean> {
  const main = availableMain();
  return main ? delegatePendingTaskToMain(main) : false;
}

export function pendingOrchestratedTasks(): Task[] {
  return dispatchableTasks("orchestrated");
}
