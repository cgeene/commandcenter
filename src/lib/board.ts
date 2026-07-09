/**
 * Pure, dependency-free helpers for the dashboard board: grouping tasks by
 * project and resolving blocked_by chains. Kept free of any DB/node imports so
 * both the node test suite and the (separately built) web bundle can import it
 * — a single source of truth instead of the type-duplication used elsewhere.
 */

/** The minimal task shape the board needs. Both the daemon and web `Task`
 *  types satisfy it structurally. */
export interface BoardTask {
  id: number;
  status: string;
  repo: string;
  blocked_by: number | null;
}

/** Project name = the repo directory's basename (commandcenter, unicorn-k8s…). */
export function projectOf(repo: string): string {
  const trimmed = repo.replace(/[/\\]+$/, "");
  const parts = trimmed.split(/[/\\]/);
  return parts[parts.length - 1] || repo;
}

/** Terminal statuses — finished work that clutters the active board. These
 *  live on the Archive tab instead. */
export const ARCHIVED_STATUSES = ["done", "cancelled"] as const;

/** A finished task (done/cancelled): archived, not shown on the active board. */
export function isArchived(status: string): boolean {
  return (ARCHIVED_STATUSES as readonly string[]).includes(status);
}

/** An in-flight task (queued/claimed/in_progress/blocked/review/failed): the
 *  only cards the board shows. Anything not archived is active. */
export function isActive(status: string): boolean {
  return !isArchived(status);
}

export interface ProjectGroup<T extends BoardTask> {
  project: string;
  tasks: T[];
  done: number;
  total: number;
}

/**
 * Group tasks by project, preserving input order both within each group and
 * across groups (first appearance wins). Each group carries a done/total
 * rollup for its header.
 *
 * `opts.visible` filters which tasks appear as cards WITHOUT changing the
 * rollup: done/total always count every task in the project, so the board's
 * headers keep their full context (e.g. "3/8") even when archived cards are
 * hidden. Groups with no visible tasks are dropped so a project that is
 * entirely archived doesn't leave an empty column on the active board.
 */
export function groupByProject<T extends BoardTask>(
  tasks: T[],
  opts?: { visible?: (t: T) => boolean },
): ProjectGroup<T>[] {
  const visible = opts?.visible;
  const order: string[] = [];
  const byProject = new Map<string, T[]>();
  for (const t of tasks) {
    const p = projectOf(t.repo);
    let bucket = byProject.get(p);
    if (!bucket) {
      bucket = [];
      byProject.set(p, bucket);
      order.push(p);
    }
    bucket.push(t);
  }
  return order
    .map((project) => {
      const all = byProject.get(project)!;
      const shown = visible ? all.filter(visible) : all;
      return {
        project,
        tasks: shown,
        done: all.filter((t) => t.status === "done").length,
        total: all.length,
      };
    })
    .filter((g) => g.tasks.length > 0);
}

/**
 * Resolve a task's blocker one level deep: the blocking task's id + status, or
 * null when the task is unblocked. A blocker that isn't in the set (e.g.
 * filtered out) resolves to status "unknown" rather than disappearing.
 */
export function blockedByChain<T extends BoardTask>(
  task: T,
  byId: Map<number, T>,
): { id: number; status: string } | null {
  if (task.blocked_by == null) return null;
  const blocker = byId.get(task.blocked_by);
  return blocker
    ? { id: blocker.id, status: blocker.status }
    : { id: task.blocked_by, status: "unknown" };
}
