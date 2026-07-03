import { getDb } from "../db/db.js";

/**
 * Compact activity digest for a time range — the dreaming run's raw
 * material, also useful for any reporting. Shapes are deliberately lean:
 * this gets pasted into an agent's context.
 */
export interface ActivitySummary {
  since: string;
  until: string;
  tasks_touched: {
    id: number;
    title: string;
    status: string;
    model: string | null;
    cron_id: number | null;
    verify_fails: number;
    result_summary: string | null;
  }[];
  open_queue: { id: number; title: string; status: string }[];
  event_counts: Record<string, number>;
  friction: {
    stalled: { agent_id: number | null; task_id: number | null }[];
    vanished: { agent_id: number | null; task_id: number | null }[];
    verify_failed_tasks: { task_id: number; count: number }[];
    cron_skipped: number;
  };
  memories_added: { id: number; text: string }[];
  spawns: { scheduler: number; total: number };
}

const trunc = (s: string | null, n = 300): string | null =>
  s && s.length > n ? s.slice(0, n) + "…" : s;

export function activitySummary(since: string, until: string): ActivitySummary {
  const db = getDb();

  const tasksTouched = (
    db
      .prepare(
        `SELECT id, title, status, model, cron_id, result_summary FROM tasks
         WHERE updated_at >= ? AND updated_at <= ? ORDER BY id ASC`,
      )
      .all(since, until) as {
      id: number;
      title: string;
      status: string;
      model: string | null;
      cron_id: number | null;
      result_summary: string | null;
    }[]
  ).map((t) => ({
    ...t,
    result_summary: trunc(t.result_summary),
    verify_fails: (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'verify.failed' AND ts >= ? AND ts <= ?",
        )
        .get(t.id, since, until) as { n: number }
    ).n,
  }));

  const eventCounts = Object.fromEntries(
    (
      db
        .prepare(
          "SELECT kind, COUNT(*) AS n FROM events WHERE ts >= ? AND ts <= ? GROUP BY kind ORDER BY n DESC",
        )
        .all(since, until) as { kind: string; n: number }[]
    ).map((r) => [r.kind, r.n]),
  );

  const eventsOf = (kind: string) =>
    db
      .prepare(
        "SELECT agent_id, task_id FROM events WHERE kind = ? AND ts >= ? AND ts <= ?",
      )
      .all(kind, since, until) as { agent_id: number | null; task_id: number | null }[];

  const verifyFailed = db
    .prepare(
      `SELECT task_id, COUNT(*) AS count FROM events
       WHERE kind = 'verify.failed' AND task_id IS NOT NULL AND ts >= ? AND ts <= ?
       GROUP BY task_id`,
    )
    .all(since, until) as { task_id: number; count: number }[];

  return {
    since,
    until,
    tasks_touched: tasksTouched,
    open_queue: db
      .prepare(
        "SELECT id, title, status FROM tasks WHERE status IN ('queued','claimed','in_progress','blocked','review') ORDER BY id ASC",
      )
      .all() as ActivitySummary["open_queue"],
    event_counts: eventCounts,
    friction: {
      stalled: eventsOf("agent.stalled"),
      vanished: eventsOf("agent.vanished"),
      verify_failed_tasks: verifyFailed,
      cron_skipped: eventCounts["cron.skipped"] ?? 0,
    },
    memories_added: (
      db
        .prepare(
          "SELECT id, text FROM memories WHERE created_at >= ? AND created_at <= ? ORDER BY id ASC",
        )
        .all(since, until) as { id: number; text: string }[]
    ).map((m) => ({ id: m.id, text: trunc(m.text, 200)! })),
    spawns: {
      scheduler: eventCounts["scheduler.spawned"] ?? 0,
      total: eventCounts["agent.spawned"] ?? 0,
    },
  };
}
