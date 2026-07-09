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
  | "failed"
  | "cancelled";

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
  "cancelled",
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
  review_verdict TEXT,
  review_notes   TEXT,
  review_cycles  INTEGER NOT NULL DEFAULT 0,
  pr_url         TEXT,
  pr_feedback_at TEXT,
  pr_state       TEXT,
  pr_checks      TEXT,
  pr_synced_at   TEXT,
  pr_sync_fails  INTEGER NOT NULL DEFAULT 0,
  open_pr        INTEGER NOT NULL DEFAULT 1,
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
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  text         TEXT NOT NULL,
  tags         TEXT,
  task_id      INTEGER,
  agent_id     INTEGER,
  use_count    INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  text, tags, content='memories', content_rowid='id'
);

-- corpus term statistics for IDF-aware query construction
CREATE VIRTUAL TABLE IF NOT EXISTS memories_vocab USING fts5vocab('memories_fts', 'row');

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

-- Internal long-term doc store index. The document bodies live as plain
-- markdown files on disk (docsDir()/<project>/<slug>.md); this table indexes
-- them for listing/search. (project, slug) is the stable identity — save_doc
-- on an existing slug updates in place and bumps version.
CREATE TABLE IF NOT EXISTS docs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL,
  project     TEXT NOT NULL,
  title       TEXT NOT NULL,
  tags        TEXT,
  task_id     INTEGER,
  agent_id    INTEGER,
  summary     TEXT,
  file_path   TEXT NOT NULL,
  attachments TEXT,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(project, slug)
);

-- Full-text search over doc metadata + body. The body is not a column on the
-- docs table (it lives on disk), so this is a standalone FTS5 table whose
-- rowid is kept equal to docs.id and maintained by hand in save_doc/delete
-- (rather than content-table triggers like memories_fts uses).
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
  title, tags, summary, body
);

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

-- Human-action items the "Needs You" panel surfaces are derived on the fly;
-- this only records which ones the human has dismissed. A re-triggering
-- situation gets a fresh item_key (see attention.ts) so it reappears.
CREATE TABLE IF NOT EXISTS attention_dismissed (
  item_key     TEXT PRIMARY KEY,
  dismissed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
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
  if (!cols.includes("review_verdict")) {
    db.exec("ALTER TABLE tasks ADD COLUMN review_verdict TEXT");
    db.exec("ALTER TABLE tasks ADD COLUMN review_notes TEXT");
    db.exec("ALTER TABLE tasks ADD COLUMN review_cycles INTEGER NOT NULL DEFAULT 0");
  }
  if (!cols.includes("pr_url")) {
    db.exec("ALTER TABLE tasks ADD COLUMN pr_url TEXT");
  }
  if (!cols.includes("pr_feedback_at")) {
    db.exec("ALTER TABLE tasks ADD COLUMN pr_feedback_at TEXT");
  }
  if (!cols.includes("open_pr")) {
    db.exec("ALTER TABLE tasks ADD COLUMN open_pr INTEGER NOT NULL DEFAULT 1");
  }
  if (!cols.includes("pr_state")) {
    db.exec("ALTER TABLE tasks ADD COLUMN pr_state TEXT");
    db.exec("ALTER TABLE tasks ADD COLUMN pr_checks TEXT");
    db.exec("ALTER TABLE tasks ADD COLUMN pr_synced_at TEXT");
    db.exec("ALTER TABLE tasks ADD COLUMN pr_sync_fails INTEGER NOT NULL DEFAULT 0");
  }
  const memCols = (db.prepare("PRAGMA table_info(memories)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (!memCols.includes("use_count")) {
    db.exec("ALTER TABLE memories ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0");
    db.exec("ALTER TABLE memories ADD COLUMN last_used_at TEXT");
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
