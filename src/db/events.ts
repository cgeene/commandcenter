import { getDb } from "./db.js";

export interface Event {
  id: number;
  ts: string;
  agent_id: number | null;
  task_id: number | null;
  kind: string;
  payload: string | null;
}

export function logEvent(
  kind: string,
  opts?: { agentId?: number; taskId?: number; payload?: unknown },
): void {
  getDb()
    .prepare(
      "INSERT INTO events (agent_id, task_id, kind, payload) VALUES (?, ?, ?, ?)",
    )
    .run(
      opts?.agentId ?? null,
      opts?.taskId ?? null,
      kind,
      opts?.payload === undefined ? null : JSON.stringify(opts.payload),
    );
}

export function listEvents(limit = 50): Event[] {
  return getDb()
    .prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?")
    .all(limit) as Event[];
}

export function countTaskEvents(taskId: number, kind: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = ?")
    .get(taskId, kind) as { n: number };
  return row.n;
}

export function countAgentEvents(agentId: number, kinds: string[]): number {
  const marks = kinds.map(() => "?").join(",");
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM events WHERE agent_id = ? AND kind IN (${marks})`,
    )
    .get(agentId, ...kinds) as { n: number };
  return row.n;
}

/** Timestamp of the agent's most recent event of any of `kinds`. */
export function latestAgentEventTs(
  agentId: number,
  kinds: string[],
): string | undefined {
  const marks = kinds.map(() => "?").join(",");
  const row = getDb()
    .prepare(
      `SELECT ts FROM events WHERE agent_id = ? AND kind IN (${marks})
       ORDER BY id DESC LIMIT 1`,
    )
    .get(agentId, ...kinds) as { ts: string } | undefined;
  return row?.ts;
}

/** The agent's most recent event of any of `kinds` (id + ts). The id gives a
 *  stable, monotonic discriminator where same-second timestamps cannot. */
export function latestAgentEvent(
  agentId: number,
  kinds: string[],
): { id: number; ts: string } | undefined {
  const marks = kinds.map(() => "?").join(",");
  return getDb()
    .prepare(
      `SELECT id, ts FROM events WHERE agent_id = ? AND kind IN (${marks})
       ORDER BY id DESC LIMIT 1`,
    )
    .get(agentId, ...kinds) as { id: number; ts: string } | undefined;
}

/** Id of the task's most recent event of any of `kinds`. Ids order events
 *  reliably where same-second timestamps cannot. */
export function latestTaskEventId(
  taskId: number,
  kinds: string[],
): number | undefined {
  const marks = kinds.map(() => "?").join(",");
  const row = getDb()
    .prepare(
      `SELECT id FROM events WHERE task_id = ? AND kind IN (${marks})
       ORDER BY id DESC LIMIT 1`,
    )
    .get(taskId, ...kinds) as { id: number } | undefined;
  return row?.id;
}

/** Timestamp of the most recent event of `kind` (any agent/task). */
export function latestEventTs(kind: string): string | undefined {
  const row = getDb()
    .prepare("SELECT ts FROM events WHERE kind = ? ORDER BY id DESC LIMIT 1")
    .get(kind) as { ts: string } | undefined;
  return row?.ts;
}

/** Timestamp of the earliest event of `kind` strictly newer than `afterTs`
 *  (or the earliest overall when `afterTs` is null). Used to anchor the start
 *  of an ongoing situation (e.g. a capacity-blocked episode) so its age is
 *  stable across throttled re-emits. */
export function earliestEventTsAfter(
  kind: string,
  afterTs: string | null,
): string | undefined {
  const row = getDb()
    .prepare(
      `SELECT ts FROM events WHERE kind = ? AND ts > ? ORDER BY id ASC LIMIT 1`,
    )
    .get(kind, afterTs ?? "") as { ts: string } | undefined;
  return row?.ts;
}

/** Events of `kind` since UTC midnight — used for the daily spawn budget. */
export function countEventsToday(kind: string): number {
  const row = getDb()
    .prepare(
      "SELECT COUNT(*) AS n FROM events WHERE kind = ? AND ts >= strftime('%Y-%m-%dT00:00:00Z','now')",
    )
    .get(kind) as { n: number };
  return row.n;
}
