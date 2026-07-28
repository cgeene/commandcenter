/**
 * Who gets to set a task's priority.
 *
 * Priority is the queue's only ordering knob (readyTasks orders by `priority
 * ASC`), so a task filed at 0/1 jumps ahead of everything the human and the
 * orchestrator have already sequenced. Workers file follow-up work from inside a
 * task, with no view of the rest of the queue, and they consistently
 * over-estimate its urgency: task #177 was filed at priority 1 by a worker whose
 * own prompt called the follow-up "low-priority hardening ... NOT urgent", and
 * the orchestrator had to notice and demote it.
 *
 * So a worker's requested priority is advisory: its follow-up never outranks the
 * work that produced it, and it lands at 3 (low) unless the filing worker's own
 * task was itself lower. The orchestrator and the human keep full control —
 * promotion at triage is the intended path for genuinely urgent worker-filed
 * work, and the worker's own request is preserved in the task.created event so
 * that signal is not lost.
 *
 * Node-import free (same contract as src/lib/blockers.ts) so the daemon and the
 * test suite share one definition.
 */

/** Lowest urgency a worker-filed task is granted outright — one step less
 *  urgent than the createTask default (2), so it queues behind ordinary work. */
export const WORKER_FILED_PRIORITY_FLOOR = 3;

/** Agent kinds, mirroring `Agent["kind"]`; null means a human submission. */
export type CreatorKind = "main" | "worker" | "reviewer" | null;

export interface PriorityGrant {
  /** Priority to persist (undefined = leave the createTask default). */
  priority: number | undefined;
  /** What the caller effectively asked for, if anything. */
  requested: number | undefined;
  /** True when the request was more urgent than what was granted. */
  clamped: boolean;
}

/**
 * Resolve the priority a new task is created with.
 *
 * Only `worker` creators are constrained. Main (the orchestrator), reviewers,
 * and human submissions pass through untouched — including an absent priority,
 * which keeps the existing "inherit the portfolio parent, else the createTask
 * default" behavior intact.
 *
 * `requested` is the *effective* request: the explicit priority, or the value
 * inherited from a portfolio parent. Inherited urgency is clamped too — a worker
 * cannot reach priority 0 work by filing a child of a priority 0 parent.
 *
 * A worker may still file something *less* urgent than the floor (4 stays 4),
 * and a worker whose own task is priority 4 files at 4: the rule is a floor on
 * urgency, not a fixed value.
 */
export function grantTaskPriority(input: {
  creatorKind: CreatorKind | undefined;
  requested?: number;
  /** Priority of the task the filing worker is working on, when known. */
  filerTaskPriority?: number | null;
}): PriorityGrant {
  const { requested } = input;
  if (input.creatorKind !== "worker") {
    return { priority: requested, requested, clamped: false };
  }
  const floor = Math.max(
    input.filerTaskPriority ?? WORKER_FILED_PRIORITY_FLOOR,
    WORKER_FILED_PRIORITY_FLOOR,
  );
  const priority = requested === undefined ? floor : Math.max(requested, floor);
  return { priority, requested, clamped: requested !== undefined && priority !== requested };
}
