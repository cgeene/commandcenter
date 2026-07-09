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
 */
export function groupByProject<T extends BoardTask>(tasks: T[]): ProjectGroup<T>[] {
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
  return order.map((project) => {
    const groupTasks = byProject.get(project)!;
    return {
      project,
      tasks: groupTasks,
      done: groupTasks.filter((t) => t.status === "done").length,
      total: groupTasks.length,
    };
  });
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
