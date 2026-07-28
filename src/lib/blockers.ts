/**
 * Pure helpers for task sequencing via `blocked_by`.
 *
 * `tasks.blocked_by` is a single nullable self-referencing FK: a task waits on
 * at most one other task, and readyTasks() releases it only once that blocker
 * reaches 'done'. That makes the dependency graph a forest of chains, and the
 * one thing that can silently break the ready queue is a cycle — every task in
 * an A→B→A loop waits forever, with nothing in the UI saying why. Cycle
 * detection therefore lives here, next to the effect a blocker actually has, so
 * the daemon and the test suite share one definition. Node-import free (same
 * contract as src/lib/board.ts).
 */

/** Raised when a blocked_by assignment would be self-referential or cyclic. */
export class BlockerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockerValidationError";
  }
}

/**
 * Whether following `blocked_by` from `startId` ever reaches `targetId`.
 *
 * Used to reject a cycle before it is written: assigning `target.blocked_by =
 * start` is safe only when `start`'s own blocker chain does not already lead
 * back to `target`. The visited set guards against walking forever if a cycle
 * somehow predates this check (e.g. rows written before it existed).
 */
export function blockerChainReaches(
  startId: number,
  targetId: number,
  blockerOf: (id: number) => number | null | undefined,
): boolean {
  const visited = new Set<number>();
  let current: number | null | undefined = startId;
  while (current != null) {
    if (current === targetId) return true;
    if (visited.has(current)) return false;
    visited.add(current);
    current = blockerOf(current);
  }
  return false;
}

/**
 * What a blocker in a given status means for the ready queue.
 *
 * - `already-satisfied`: the blocker is done, so the dependent is ready now.
 * - `never-satisfied`: the blocker is cancelled/failed. It can never become
 *   'done', so the dependent is parked permanently — the assignment is still
 *   accepted (a human may resume the blocker), but it needs saying out loud.
 *   This is the same warning `cc task cancel` prints for open dependents.
 * - `pending`: the ordinary case — the dependent waits.
 */
export type BlockerEffect = "already-satisfied" | "never-satisfied" | "pending";

export function blockerEffect(status: string): BlockerEffect {
  if (status === "done") return "already-satisfied";
  if (status === "cancelled" || status === "failed") return "never-satisfied";
  return "pending";
}

/** One-line explanation of a blocker's effect, for tool/CLI output. */
export function blockerNote(blockerId: number, status: string): string {
  switch (blockerEffect(status)) {
    case "already-satisfied":
      return `blocker #${blockerId} is already done — this task is ready now`;
    case "never-satisfied":
      return `blocker #${blockerId} is ${status} and can never become done — this task will never be ready until you re-point or clear blocked_by`;
    default:
      return `blocker #${blockerId} is ${status} — this task stays out of the ready queue until it is done`;
  }
}
