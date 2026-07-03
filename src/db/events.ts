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
