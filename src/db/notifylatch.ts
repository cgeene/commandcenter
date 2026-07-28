import { getDb } from "./db.js";

/**
 * "Push this at most once" bookkeeping for notify.ts.
 *
 * Several push conditions are STATE, not edges — "this task is approved and its
 * PR is ready" stays true from the moment it is approved until the human merges
 * it, and the prsync sweep re-derives it every couple of minutes. The latch is
 * what turns that standing state into a single push. It is persisted (not an
 * in-process Map) so a daemon restart doesn't re-page about something the human
 * already saw, which is exactly the failure the escalate-once counters in
 * prsync/jirasync were added for.
 *
 * Re-arming is by key construction, not by clearing: bake the discriminator
 * (approved SHA, round number, streak count) into the key and a genuinely new
 * occurrence naturally gets a new key.
 */

/** Has this exact situation already been pushed? */
export function notifyLatched(key: string): boolean {
  const row = getDb()
    .prepare("SELECT 1 AS hit FROM notify_latches WHERE key = ?")
    .get(key) as { hit: number } | undefined;
  return row !== undefined;
}

/** Claim the latch. Returns false when it was already held (nothing written). */
export function latchNotify(
  key: string,
  event: string,
  taskId?: number | null,
): boolean {
  const info = getDb()
    .prepare(
      "INSERT OR IGNORE INTO notify_latches (key, event, task_id) VALUES (?, ?, ?)",
    )
    .run(key, event, taskId ?? null);
  return info.changes > 0;
}
