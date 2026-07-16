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
  workspace_kind TEXT NOT NULL DEFAULT 'repo',
  dispatch_mode  TEXT NOT NULL DEFAULT 'direct',
  parent_task_id INTEGER REFERENCES tasks(id),
  status         TEXT NOT NULL DEFAULT 'queued',
  priority       INTEGER NOT NULL DEFAULT 2,
  worker_provider TEXT NOT NULL DEFAULT 'claude',
  model          TEXT,
  reasoning_effort TEXT,
  blocked_by     INTEGER REFERENCES tasks(id),
  agent_id       INTEGER,
  worktree       TEXT,
  branch         TEXT,
  session_id     TEXT,
  session_provider TEXT,
  verify_cmd     TEXT,
  result_summary TEXT,
  review_verdict TEXT,
  review_notes   TEXT,
  review_cycles  INTEGER NOT NULL DEFAULT 0,
  review_head_sha TEXT,
  review_result_hash TEXT,
  pr_url         TEXT,
  pr_feedback_at TEXT,
  pr_state       TEXT,
  pr_checks      TEXT,
  pr_is_draft    INTEGER,
  human_approved_at TEXT,
  pr_synced_at   TEXT,
  pr_sync_fails  INTEGER NOT NULL DEFAULT 0,
  jira_key       TEXT,
  jira_state     TEXT,
  jira_status_category TEXT,
  jira_synced_at TEXT,
  jira_sync_fails INTEGER NOT NULL DEFAULT 0,
  jira_project   TEXT,
  open_pr        INTEGER NOT NULL DEFAULT 1,
  tokens_used    INTEGER,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS agents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL DEFAULT 'worker',
  provider      TEXT NOT NULL DEFAULT 'claude',
  model         TEXT,
  reasoning_effort TEXT,
  state         TEXT NOT NULL DEFAULT 'spawning',
  task_id       INTEGER REFERENCES tasks(id),
  tmux_target   TEXT,
  session_id    TEXT,
  transcript_path TEXT,
  runtime_config_path TEXT,
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
  worker_provider TEXT NOT NULL DEFAULT 'claude',
  model       TEXT,
  reasoning_effort TEXT,
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

-- Orchestrator notifications ("worker aN is waiting for input") that could not
-- be delivered to the main agent yet — its turn was mid-flight or its composer
-- held the human's unsubmitted draft. Held here (persisted so a daemon restart
-- doesn't drop them) and flushed as one batched message when the main next
-- goes idle with an empty prompt. See src/daemon/notifqueue.ts.
CREATE TABLE IF NOT EXISTS queued_notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  main_id    INTEGER NOT NULL,
  worker_id  INTEGER,
  task_id    INTEGER,
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
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
  // review_head_sha: the branch HEAD SHA the last reviewer was spawned against
  // (NULL for scratch/no-git tasks). review_result_hash: a hash of the
  // result_summary at that spawn. Together they let the auto-review loop tell a
  // genuine new round (new commit or changed summary) from an idle re-entry, and
  // enforce the invariant "a PR is non-draft IFF its current HEAD was approved"
  // — an approve verdict whose SHA no longer matches HEAD is stale.
  if (!cols.includes("review_head_sha")) {
    db.exec("ALTER TABLE tasks ADD COLUMN review_head_sha TEXT");
    db.exec("ALTER TABLE tasks ADD COLUMN review_result_hash TEXT");
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
  // pr_is_draft: 1 = draft (internal review pending/rejecting), 0 = ready
  // (internal review approved), NULL = unknown/not yet synced.
  if (!cols.includes("pr_is_draft")) {
    db.exec("ALTER TABLE tasks ADD COLUMN pr_is_draft INTEGER");
  }
  // human_approved_at: timestamp of the latest human GitHub approval that
  // carried no change request. A signal for the dashboard, NOT a re-queue
  // trigger (see prsync.applyPrState).
  if (!cols.includes("human_approved_at")) {
    db.exec("ALTER TABLE tasks ADD COLUMN human_approved_at TEXT");
  }
  // JIRA integration columns — mirror the pr_* quartet. jira_key is the
  // first-class link (NULL = no ticket yet); jira_state/jira_status_category
  // cache the workflow status + workflow-independent category so the dashboard
  // reads columns instead of hitting the JIRA API on render; jira_synced_at /
  // jira_sync_fails mirror pr_synced_at / pr_sync_fails; jira_project caches the
  // resolved project key (and survives a per-task override). Dormant in phase 1.
  if (!cols.includes("jira_key")) {
    db.exec("ALTER TABLE tasks ADD COLUMN jira_key TEXT");
    db.exec("ALTER TABLE tasks ADD COLUMN jira_state TEXT");
    db.exec("ALTER TABLE tasks ADD COLUMN jira_status_category TEXT");
    db.exec("ALTER TABLE tasks ADD COLUMN jira_synced_at TEXT");
    db.exec("ALTER TABLE tasks ADD COLUMN jira_sync_fails INTEGER NOT NULL DEFAULT 0");
    db.exec("ALTER TABLE tasks ADD COLUMN jira_project TEXT");
  }
  if (!cols.includes("worker_provider")) {
    db.exec("ALTER TABLE tasks ADD COLUMN worker_provider TEXT NOT NULL DEFAULT 'claude'");
  }
  if (!cols.includes("session_provider")) {
    db.exec("ALTER TABLE tasks ADD COLUMN session_provider TEXT");
  }
  if (!cols.includes("reasoning_effort")) {
    db.exec("ALTER TABLE tasks ADD COLUMN reasoning_effort TEXT");
  }
  if (!cols.includes("workspace_kind")) {
    db.exec("ALTER TABLE tasks ADD COLUMN workspace_kind TEXT NOT NULL DEFAULT 'repo'");
  }
  if (!cols.includes("dispatch_mode")) {
    // Existing queued tasks retain the historical direct-scheduler behavior.
    db.exec("ALTER TABLE tasks ADD COLUMN dispatch_mode TEXT NOT NULL DEFAULT 'direct'");
  }
  if (!cols.includes("parent_task_id")) {
    db.exec("ALTER TABLE tasks ADD COLUMN parent_task_id INTEGER REFERENCES tasks(id)");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_dispatch ON tasks(dispatch_mode, status)");
  const agentCols = (db.prepare("PRAGMA table_info(agents)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (!agentCols.includes("provider")) {
    db.exec("ALTER TABLE agents ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'");
  }
  if (!agentCols.includes("transcript_path")) {
    db.exec("ALTER TABLE agents ADD COLUMN transcript_path TEXT");
  }
  if (!agentCols.includes("runtime_config_path")) {
    db.exec("ALTER TABLE agents ADD COLUMN runtime_config_path TEXT");
  }
  if (!agentCols.includes("reasoning_effort")) {
    db.exec("ALTER TABLE agents ADD COLUMN reasoning_effort TEXT");
  }
  const cronCols = (db.prepare("PRAGMA table_info(crons)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (!cronCols.includes("worker_provider")) {
    db.exec("ALTER TABLE crons ADD COLUMN worker_provider TEXT NOT NULL DEFAULT 'claude'");
  }
  if (!cronCols.includes("reasoning_effort")) {
    db.exec("ALTER TABLE crons ADD COLUMN reasoning_effort TEXT");
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
