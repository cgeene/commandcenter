import { getDb, type TaskStatus, TASK_STATUSES } from "./db.js";

export interface Task {
  id: number;
  title: string;
  prompt: string;
  repo: string;
  status: TaskStatus;
  priority: number;
  model: string | null;
  blocked_by: number | null;
  agent_id: number | null;
  worktree: string | null;
  branch: string | null;
  session_id: string | null;
  verify_cmd: string | null;
  result_summary: string | null;
  review_verdict: string | null;
  review_notes: string | null;
  review_cycles: number;
  pr_url: string | null;
  pr_feedback_at: string | null;
  pr_state: string | null; // open | merged | closed (lowercased gh state)
  pr_checks: string | null; // CI rollup: pass | fail | pending | none
  pr_is_draft: number | null; // 1 draft (internal review pending), 0 ready, NULL unknown
  human_approved_at: string | null; // latest human GitHub approval (signal only, not a re-queue trigger)
  pr_synced_at: string | null; // last successful prsync
  pr_sync_fails: number; // consecutive prsync failures; escalates at 3
  open_pr: number; // sqlite boolean, default 1
  tokens_used: number | null;
  cron_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface NewTask {
  title: string;
  prompt: string;
  repo: string;
  priority?: number;
  model?: string;
  blocked_by?: number;
  verify_cmd?: string;
  cron_id?: number;
  open_pr?: boolean;
}

export function createTask(t: NewTask): Task {
  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO tasks (title, prompt, repo, priority, model, blocked_by, verify_cmd, cron_id, open_pr)
       VALUES (@title, @prompt, @repo, @priority, @model, @blocked_by, @verify_cmd, @cron_id, @open_pr)`,
    )
    .run({
      title: t.title,
      prompt: t.prompt,
      repo: t.repo,
      priority: t.priority ?? 2,
      model: t.model ?? null,
      blocked_by: t.blocked_by ?? null,
      verify_cmd: t.verify_cmd ?? null,
      cron_id: t.cron_id ?? null,
      open_pr: t.open_pr === false ? 0 : 1,
    });
  return getTask(Number(info.lastInsertRowid))!;
}

export function getTask(id: number): Task | undefined {
  return getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
    | Task
    | undefined;
}

export function listTasks(status?: TaskStatus): Task[] {
  const db = getDb();
  if (status) {
    return db
      .prepare(
        "SELECT * FROM tasks WHERE status = ? ORDER BY priority ASC, id ASC",
      )
      .all(status) as Task[];
  }
  return db
    .prepare(
      `SELECT * FROM tasks
       ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'claimed' THEN 1
                            WHEN 'queued' THEN 2 WHEN 'blocked' THEN 3
                            WHEN 'review' THEN 4 WHEN 'failed' THEN 5
                            WHEN 'cancelled' THEN 6 ELSE 7 END,
                priority ASC, id ASC`,
    )
    .all() as Task[];
}

/** Tasks that are queued and whose blocker (if any) is done. */
export function readyTasks(): Task[] {
  return getDb()
    .prepare(
      `SELECT t.* FROM tasks t
       LEFT JOIN tasks b ON t.blocked_by = b.id
       WHERE t.status = 'queued' AND (t.blocked_by IS NULL OR b.status = 'done')
       ORDER BY t.priority ASC, t.id ASC`,
    )
    .all() as Task[];
}

/**
 * Tasks whose PR still needs polling: it has a pr_url, PR-opening is enabled
 * (open_pr != 0), and the cached pr_state is not yet terminal. A PR is terminal
 * once it is merged or closed — we never poll it again (that would burn gh
 * quota for a state that can't change). Crucially this is NOT scoped to
 * review-status tasks: a task can be done/cancelled while its PR is still open
 * (or was never synced), and its PR badge must still reflect reality. The
 * NULL check is explicit because `NULL NOT IN (...)` is NULL, not true, so a
 * never-synced row would otherwise be skipped.
 */
export function tasksNeedingPrSync(): Task[] {
  return getDb()
    .prepare(
      `SELECT * FROM tasks
       WHERE pr_url IS NOT NULL AND open_pr != 0
         AND (pr_state IS NULL OR pr_state NOT IN ('merged', 'closed'))
       ORDER BY id ASC`,
    )
    .all() as Task[];
}

/** Open tasks waiting on `taskId` via blocked_by. A cancelled blocker never
 *  becomes 'done', so these stay stuck unless the human re-points them. */
export function openDependents(taskId: number): Task[] {
  return getDb()
    .prepare(
      `SELECT * FROM tasks WHERE blocked_by = ?
       AND status NOT IN ('done','failed','cancelled') ORDER BY id ASC`,
    )
    .all(taskId) as Task[];
}

/**
 * Atomically claim a queued task. Returns the task if this caller won the
 * claim, undefined if the task was not claimable (already claimed, missing,
 * or not queued). This single UPDATE is the concurrency guarantee: two
 * agents can never both claim the same task.
 */
export function claimTask(id: number, agentId?: number): Task | undefined {
  const info = getDb()
    .prepare(
      `UPDATE tasks
       SET status = 'claimed', agent_id = @agentId,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = @id AND status = 'queued'`,
    )
    .run({ id, agentId: agentId ?? null });
  return info.changes === 1 ? getTask(id) : undefined;
}

const UPDATABLE = new Set([
  "title",
  "prompt",
  "status",
  "priority",
  "model",
  "blocked_by",
  "agent_id",
  "worktree",
  "branch",
  "session_id",
  "verify_cmd",
  "result_summary",
  "review_verdict",
  "review_notes",
  "review_cycles",
  "pr_url",
  "pr_feedback_at",
  "pr_state",
  "pr_checks",
  "pr_is_draft",
  "human_approved_at",
  "pr_synced_at",
  "pr_sync_fails",
  "open_pr",
  "tokens_used",
]);

export function updateTask(
  id: number,
  fields: Partial<Omit<Task, "id" | "created_at" | "updated_at">>,
): Task | undefined {
  const keys = Object.keys(fields).filter((k) => UPDATABLE.has(k));
  if (keys.length === 0) return getTask(id);
  if (fields.status && !TASK_STATUSES.includes(fields.status)) {
    throw new Error(`invalid status: ${fields.status}`);
  }
  const sets = keys.map((k) => `${k} = @${k}`).join(", ");
  getDb()
    .prepare(
      `UPDATE tasks SET ${sets}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = @id`,
    )
    .run({ id, ...fields });
  return getTask(id);
}
