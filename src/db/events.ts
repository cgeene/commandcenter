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
): Pick<Event, "id" | "ts" | "kind" | "payload"> | undefined {
  const marks = kinds.map(() => "?").join(",");
  return getDb()
    .prepare(
      `SELECT id, ts, kind, payload FROM events WHERE agent_id = ? AND kind IN (${marks})
       ORDER BY id DESC LIMIT 1`,
    )
    .get(agentId, ...kinds) as
    | Pick<Event, "id" | "ts" | "kind" | "payload">
    | undefined;
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

/** Full most-recent task event for orchestration ownership/audit checks. */
export function latestTaskEvent(
  taskId: number,
  kinds: string[],
): Pick<Event, "id" | "ts" | "kind" | "agent_id" | "payload"> | undefined {
  const marks = kinds.map(() => "?").join(",");
  return getDb()
    .prepare(
      `SELECT id, ts, kind, agent_id, payload FROM events
       WHERE task_id = ? AND kind IN (${marks})
       ORDER BY id DESC LIMIT 1`,
    )
    .get(taskId, ...kinds) as
    | Pick<Event, "id" | "ts" | "kind" | "agent_id" | "payload">
    | undefined;
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
