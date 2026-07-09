import { getDb } from "./db.js";

/**
 * Dismissals for the "Needs You" action queue. Items themselves are derived
 * live from tasks/agents/events (see daemon/attention.ts); this table only
 * remembers which item_keys the human has waved off. A situation that
 * re-triggers (a new review cycle, a fresh wait episode) is assigned a new
 * item_key, so it is not covered by an old dismissal and shows up again.
 */

export function dismissAttention(key: string): void {
  getDb()
    .prepare(
      "INSERT INTO attention_dismissed (item_key) VALUES (?) ON CONFLICT(item_key) DO NOTHING",
    )
    .run(key);
}

/** All dismissed item_keys, as a Set for O(1) lookups during derivation. */
export function dismissedKeys(): Set<string> {
  const rows = getDb()
    .prepare("SELECT item_key FROM attention_dismissed")
    .all() as { item_key: string }[];
  return new Set(rows.map((r) => r.item_key));
}
