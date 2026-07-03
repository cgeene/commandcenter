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

/** Events of `kind` since UTC midnight — used for the daily spawn budget. */
export function countEventsToday(kind: string): number {
  const row = getDb()
    .prepare(
      "SELECT COUNT(*) AS n FROM events WHERE kind = ? AND ts >= strftime('%Y-%m-%dT00:00:00Z','now')",
    )
    .get(kind) as { n: number };
  return row.n;
}
