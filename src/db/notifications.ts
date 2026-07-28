import { getDb } from "./db.js";

/**
 * What kind of delivery a queued row represents. The two expire on different
 * conditions — a worker-wait ping is moot once the worker stops waiting, a
 * triage ping is moot once the task leaves the queue — so the flush has to be
 * able to tell them apart.
 */
export type NotificationOrigin = "worker_waiting" | "task_triage";

/** One orchestrator notification held back from the main agent because its
 *  prompt was busy (mid-turn or holding the human's draft). */
export interface QueuedNotification {
  id: number;
  main_id: number;
  worker_id: number | null;
  task_id: number | null;
  message: string;
  origin: NotificationOrigin;
  attempts: number;
  next_retry_at: string | null;
  created_at: string;
}

/**
 * Queue a notification for later delivery to `mainId`, returning the row and
 * whether it was newly created.
 *
 * Deduped so a batch flush never mentions the same subject twice and a human
 * mashing "Notify Claude Main" cannot stack rows: one row per (main, worker)
 * for worker waits, one per (main, task) for triage. A repeat replaces the
 * prior message in place and is reported as `created: false`, which is what
 * keeps the lifecycle events (and the human-facing "already queued" answer)
 * honest about nothing new having happened.
 */
export function enqueueNotification(n: {
  mainId: number;
  workerId?: number;
  taskId?: number;
  message: string;
  origin?: NotificationOrigin;
}): { row: QueuedNotification; created: boolean } {
  const db = getDb();
  const origin: NotificationOrigin = n.origin ?? "worker_waiting";
  const existing =
    origin === "task_triage"
      ? (db
          .prepare(
            "SELECT id FROM queued_notifications WHERE main_id = ? AND origin = 'task_triage' AND task_id IS ?",
          )
          .get(n.mainId, n.taskId ?? null) as { id: number } | undefined)
      : n.workerId != null
        ? (db
            .prepare(
              "SELECT id FROM queued_notifications WHERE main_id = ? AND origin = 'worker_waiting' AND worker_id = ?",
            )
            .get(n.mainId, n.workerId) as { id: number } | undefined)
        : undefined;

  if (existing) {
    // Refresh the payload but keep the row's identity, created_at and attempt
    // count: this is the same pending delivery, not a new one.
    db.prepare(
      "UPDATE queued_notifications SET message = ?, task_id = ? WHERE id = ?",
    ).run(n.message, n.taskId ?? null, existing.id);
    return { row: getQueuedNotification(existing.id)!, created: false };
  }

  const info = db
    .prepare(
      `INSERT INTO queued_notifications (main_id, worker_id, task_id, message, origin)
       VALUES (@main_id, @worker_id, @task_id, @message, @origin)`,
    )
    .run({
      main_id: n.mainId,
      worker_id: n.workerId ?? null,
      task_id: n.taskId ?? null,
      message: n.message,
      origin,
    });
  return { row: getQueuedNotification(Number(info.lastInsertRowid))!, created: true };
}

export function getQueuedNotification(id: number): QueuedNotification | undefined {
  return getDb()
    .prepare("SELECT * FROM queued_notifications WHERE id = ?")
    .get(id) as QueuedNotification | undefined;
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

/**
 * Record that a flush for `mainId` was deferred: bump every pending row's
 * attempt count and stamp when the queue may next be retried. Purely durable
 * bookkeeping — the live gate is the in-memory backoff in notifqueue.ts, which
 * these columns exist to reseed after a restart.
 */
export function noteDeliveryAttempt(mainId: number, nextRetryAt: string): void {
  getDb()
    .prepare(
      `UPDATE queued_notifications
          SET attempts = attempts + 1, next_retry_at = ?
        WHERE main_id = ?`,
    )
    .run(nextRetryAt, mainId);
}

/** Every main agent with at least one pending delivery, with the queue's depth
 *  and the backoff state to restore. Used at daemon boot to resume the retry
 *  loop that used to die with the process. */
export function pendingDeliveryMains(): {
  main_id: number;
  pending: number;
  attempts: number;
  next_retry_at: string | null;
}[] {
  return getDb()
    .prepare(
      `SELECT main_id,
              COUNT(*)            AS pending,
              MAX(attempts)       AS attempts,
              MAX(next_retry_at)  AS next_retry_at
         FROM queued_notifications
        GROUP BY main_id
        ORDER BY main_id ASC`,
    )
    .all() as {
    main_id: number;
    pending: number;
    attempts: number;
    next_retry_at: string | null;
  }[];
}

/** Drop any pending triage delivery for a task — used when the triage ping
 *  reaches the main by some other route, so the queue cannot deliver it twice. */
export function clearTriageQueueForTask(taskId: number): number {
  return getDb()
    .prepare(
      "DELETE FROM queued_notifications WHERE origin = 'task_triage' AND task_id = ?",
    )
    .run(taskId).changes;
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
