import fs from "node:fs";
import Database from "better-sqlite3";
import { dataDir, dbPath } from "../config.js";

export type TaskStatus =
  | "queued"
  | "claimed"
  | "in_progress"
  | "blocked"
  | "review"
  | "done"
  | "failed";

export type AgentState =
  | "spawning"
  | "working"
  | "idle"
  | "waiting_input"
  | "stalled"
  | "dead";

export const TASK_STATUSES: TaskStatus[] = [
  "queued",
  "claimed",
  "in_progress",
  "blocked",
  "review",
  "done",
  "failed",
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT NOT NULL,
  prompt         TEXT NOT NULL,
  repo           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'queued',
  priority       INTEGER NOT NULL DEFAULT 2,
  model          TEXT,
  blocked_by     INTEGER REFERENCES tasks(id),
  agent_id       INTEGER,
  worktree       TEXT,
  branch         TEXT,
  session_id     TEXT,
  verify_cmd     TEXT,
  result_summary TEXT,
  tokens_used    INTEGER,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS agents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL DEFAULT 'worker',
  model         TEXT,
  state         TEXT NOT NULL DEFAULT 'spawning',
  task_id       INTEGER REFERENCES tasks(id),
  tmux_target   TEXT,
  session_id    TEXT,
  last_event_at TEXT,
  spawned_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  agent_id INTEGER,
  task_id  INTEGER,
  kind     TEXT NOT NULL,
  payload  TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT NOT NULL,
  tags       TEXT,
  task_id    INTEGER,
  agent_id   INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  text, tags, content='memories', content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, text, tags) VALUES (new.id, new.text, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text, tags)
  VALUES ('delete', old.id, old.text, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text, tags)
  VALUES ('delete', old.id, old.text, old.tags);
  INSERT INTO memories_fts(rowid, text, tags) VALUES (new.id, new.text, new.tags);
END;

CREATE TABLE IF NOT EXISTS crons (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  schedule    TEXT NOT NULL,
  title       TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  repo        TEXT NOT NULL,
  model       TEXT,
  priority    INTEGER NOT NULL DEFAULT 2,
  verify_cmd  TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  next_run_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id);
`;

/** Additive migrations for columns that postdate the original CREATE TABLE. */
function migrate(db: Database.Database): void {
  const cols = (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (!cols.includes("cron_id")) {
    db.exec("ALTER TABLE tasks ADD COLUMN cron_id INTEGER");
  }
}

let db: Database.Database | undefined;

export function getDb(): Database.Database {
  if (!db) {
    fs.mkdirSync(dataDir(), { recursive: true });
    db = new Database(dbPath());
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA);
    migrate(db);
  }
  return db;
}

/** Test helper: close and forget the singleton so a new CC_DATA_DIR takes effect. */
export function closeDb(): void {
  db?.close();
  db = undefined;
}
