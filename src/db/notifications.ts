import { getDb } from "./db.js";

/** One orchestrator notification held back from the main agent because its
 *  prompt was busy (mid-turn or holding the human's draft). */
export interface QueuedNotification {
  id: number;
  main_id: number;
  worker_id: number | null;
  task_id: number | null;
  message: string;
  created_at: string;
}

/**
 * Queue a notification for later delivery to `mainId`. One row per
 * (main, worker): a fresh wait for a worker already queued replaces its prior
 * message rather than stacking a duplicate, so a batch flush never lists the
 * same worker twice.
 */
export function enqueueNotification(n: {
  mainId: number;
  workerId?: number;
  taskId?: number;
  message: string;
}): QueuedNotification {
  const db = getDb();
  if (n.workerId != null) {
    db.prepare(
      "DELETE FROM queued_notifications WHERE main_id = ? AND worker_id = ?",
    ).run(n.mainId, n.workerId);
  }
  const info = db
    .prepare(
      `INSERT INTO queued_notifications (main_id, worker_id, task_id, message)
       VALUES (@main_id, @worker_id, @task_id, @message)`,
    )
    .run({
      main_id: n.mainId,
      worker_id: n.workerId ?? null,
      task_id: n.taskId ?? null,
      message: n.message,
    });
  return getDb()
    .prepare("SELECT * FROM queued_notifications WHERE id = ?")
    .get(Number(info.lastInsertRowid)) as QueuedNotification;
}

/** All notifications queued for a main agent, oldest first. */
export function listQueuedNotifications(mainId: number): QueuedNotification[] {
  return getDb()
    .prepare(
      "SELECT * FROM queued_notifications WHERE main_id = ? ORDER BY id ASC",
    )
    .all(mainId) as QueuedNotification[];
}

export function countQueuedNotifications(mainId: number): number {
  const row = getDb()
    .prepare(
      "SELECT COUNT(*) AS n FROM queued_notifications WHERE main_id = ?",
    )
    .get(mainId) as { n: number };
  return row.n;
}

/** Remove queued rows by id (after a successful flush, or when the underlying
 *  worker is no longer waiting so the notification is moot). */
export function clearQueuedNotifications(ids: number[]): void {
  if (ids.length === 0) return;
  const marks = ids.map(() => "?").join(",");
  getDb()
    .prepare(`DELETE FROM queued_notifications WHERE id IN (${marks})`)
    .run(...ids);
}
