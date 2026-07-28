import { listAgents, type Agent } from "../db/agents.js";
import { logEvent } from "../db/events.js";
import { getSchedulerConfig } from "../db/settings.js";
import { getTask, type Task } from "../db/tasks.js";

/**
 * Worker-concurrency accounting: which live workers actually occupy one of the
 * `max_concurrent` slots.
 *
 * A worker whose task sits in `review` is PARKED. It has handed the work to the
 * reviewer and owns no further state change until a verdict lands; it stays
 * alive for exactly one reason — a rejection can then be delivered into its
 * existing session, which is far cheaper than a respawn. Counting those idle
 * workers against the cap took the fleet to zero throughput during review
 * waves: every slot held by a parked worker while triaged tasks queued. So
 * parked workers are exempt.
 *
 * Everything else a live worker can be doing still counts:
 *  - active work (`claimed` / `in_progress`) — including a rework round after a
 *    rejection, which returns the task to `in_progress`;
 *  - a worker with no task yet (a manual/mid-spawn agent);
 *  - a worker idling on a finished or blocked task until the watchdog reaps it.
 *    That one is a genuine squatter and must stay visible to the capacity
 *    accounting rather than being quietly forgiven.
 *
 * The exemption is unconditional on agent state. A parked worker is normally
 * `idle`, but a missed Stop hook, a stall flag, or a permission prompt must not
 * silently re-consume a slot the reviewer is responsible for releasing.
 */
export interface WorkerSlots {
  /** live workers occupying a concurrency slot */
  counted: Agent[];
  /** live workers parked in review, exempt from the cap */
  parked: Agent[];
}

/**
 * Split the live workers into slot-occupying and parked-in-review.
 *
 * Callers that already hold the live agents and/or the task list should pass
 * them so this costs no extra queries; otherwise both are read fresh.
 */
export function workerSlots(input?: {
  agents?: Agent[];
  tasks?: Task[];
}): WorkerSlots {
  const workers = (input?.agents ?? listAgents({ live: true })).filter(
    (agent) => agent.kind === "worker",
  );
  const tasks = input?.tasks;
  const statusOf = (taskId: number): string | undefined =>
    tasks
      ? tasks.find((task) => task.id === taskId)?.status
      : getTask(taskId)?.status;

  const counted: Agent[] = [];
  const parked: Agent[] = [];
  for (const worker of workers) {
    const status = worker.task_id === null ? undefined : statusOf(worker.task_id);
    (status === "review" ? parked : counted).push(worker);
  }
  return { counted, parked };
}

/**
 * A rejected task's parked worker just became active again, so it re-enters the
 * concurrency count. Rework is the continuation of work already in flight and is
 * never refused for capacity — but when it pushes the fleet past the cap, record
 * it, so the event log and the orchestrator see a deliberate, self-correcting
 * over-cap instead of a mystery extra worker.
 *
 * Call this AFTER the task has been moved back to an active status, so the
 * re-entering worker is already part of the counted set.
 */
export function noteReworkOverCap(taskId: number, agentId: number): void {
  const cfg = getSchedulerConfig();
  const { counted, parked } = workerSlots();
  if (counted.length <= cfg.max_concurrent) return;
  logEvent("scheduler.worker_over_cap", {
    taskId,
    agentId,
    payload: {
      reason: "review_rejected_rework",
      counted_workers: counted.length,
      parked_workers: parked.length,
      max_concurrent: cfg.max_concurrent,
    },
  });
}
