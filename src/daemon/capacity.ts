import { listAgents, type Agent } from "../db/agents.js";
import { logEvent } from "../db/events.js";
import { getSchedulerConfig } from "../db/settings.js";
import { getTask, type Task } from "../db/tasks.js";

/**
 * Worker-concurrency accounting: which live workers actually occupy one of the
 * `max_concurrent` slots.
 *
 * A worker is PARKED — and exempt from the cap — while a live reviewer owns its
 * task: the task is in `review`, a reviewer agent is judging it, and no verdict
 * has landed yet. Such a worker is idle by construction and stays alive for
 * exactly one reason: a rejection can then be delivered into its existing
 * session, which is far cheaper than a respawn. Counting those idle workers
 * against the cap took the fleet to zero throughput during review waves — every
 * slot held by a parked worker while triaged tasks queued.
 *
 * The exemption is deliberately keyed on the REVIEWER, not on the `review`
 * status alone. A task can sit in `review` with nobody coming to release it —
 * a repo task with no PR (auto-review skips it), `auto_review` off, the daily
 * review budget spent, a non-reviewable submission, or a reviewer that died
 * before submitting. Exempting those would let live provider processes pile up
 * with no bound and no signal. They fall back to COUNTED, which is the
 * pre-existing behavior: bounded by the cap and named by
 * `scheduler.capacity_blocked` and the Needs You "scheduler stalled" item.
 *
 * Everything else a live worker can be doing still counts:
 *  - active work (`claimed` / `in_progress`) — including a rework round after a
 *    rejection, which returns the task to `in_progress`;
 *  - a worker with no task yet (a manual/mid-spawn agent);
 *  - a worker whose task is in `review` with an `approve` verdict already
 *    landed: no rejection can arrive for that round, so nothing justifies
 *    keeping it. The watchdog's approved-awaiting-merge reap retires it;
 *  - a worker idling on a finished or blocked task until the watchdog reaps it.
 *    That one is a genuine squatter and must stay visible to the capacity
 *    accounting rather than being quietly forgiven.
 *
 * Within the parked case the exemption ignores agent state. A parked worker is
 * normally `idle`, but a missed Stop hook, a stall flag, or a permission prompt
 * must not silently re-consume a slot the reviewer is responsible for releasing.
 */
export interface WorkerSlots {
  /** live workers occupying a concurrency slot */
  counted: Agent[];
  /** live workers parked under a live reviewer, exempt from the cap */
  parked: Agent[];
}

/**
 * Split the live workers into slot-occupying and parked-under-review.
 *
 * Callers that already hold the live agents and/or the task list should pass
 * them so this costs no extra queries; otherwise both are read fresh.
 * `agents` must be ALL live agents (reviewers included) — the reviewer rows are
 * what makes a worker exempt. Passing a pre-filtered worker list is safe but
 * conservative: every worker then counts.
 */
export function workerSlots(input?: {
  agents?: Agent[];
  tasks?: Task[];
}): WorkerSlots {
  const live = input?.agents ?? listAgents({ live: true });
  const workers = live.filter((agent) => agent.kind === "worker");
  /** tasks a live reviewer is currently judging */
  const underReview = new Set(
    live
      .filter((agent) => agent.kind === "reviewer" && agent.task_id !== null)
      .map((agent) => agent.task_id as number),
  );
  const tasks = input?.tasks;
  const taskOf = (taskId: number): Task | undefined =>
    tasks ? tasks.find((task) => task.id === taskId) : getTask(taskId);

  const counted: Agent[] = [];
  const parked: Agent[] = [];
  for (const worker of workers) {
    const task = worker.task_id === null ? undefined : taskOf(worker.task_id);
    const isParked =
      task !== undefined &&
      task.status === "review" &&
      // A landed verdict means the reviewer is done with this round: an approve
      // waits on the human/merge (and the watchdog reaps the worker), and a
      // reject has already moved the task off `review`.
      task.review_verdict === null &&
      underReview.has(task.id);
    (isParked ? parked : counted).push(worker);
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
