import fs from "node:fs";
import path from "node:path";
import { docsDir } from "../config.js";
import { getDb } from "./db.js";

export interface Doc {
  id: number;
  slug: string;
  project: string;
  title: string;
  tags: string | null;
  task_id: number | null;
  agent_id: number | null;
  summary: string | null;
  /** Path to the markdown body, relative to docsDir(). */
  file_path: string;
  /** JSON array of sidecar file paths (relative to docsDir()), or null. */
  attachments: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface DocWithContent extends Doc {
  content: string;
}

export interface Attachment {
  filename: string;
  content: string;
}

export interface SaveDocInput {
  project: string;
  title: string;
  content: string;
  tags?: string;
  summary?: string;
  task_id?: number;
  agent_id?: number;
  attachments?: Attachment[];
  /** Override the derived slug (seed import uses this to keep file ordering);
   *  callers normally omit it and let the title decide. */
  slug?: string;
}

export interface SaveDocResult {
  doc: Doc;
  created: boolean;
}

/**
 * Reduce arbitrary text to a filesystem- and URL-safe kebab slug. Also the
 * path-traversal guard: the result can only contain [a-z0-9-], so a project
 * or slug can never climb out of docsDir() with `..` or an absolute path.
 */
export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "doc"
  );
}

function absPath(relative: string): string {
  return path.join(docsDir(), relative);
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "are", "was", "were",
  "has", "have", "had", "not", "but", "its", "into", "when", "then", "than",
  "them", "they", "you", "your", "our", "all", "any", "can", "should", "will",
  "would", "there", "their", "these", "those", "what", "which", "how",
]);

/**
 * Build a safe FTS5 query from natural language. FTS5 treats quotes, parens,
 * and hyphens as syntax, so reduce the input to bare word tokens OR'd
 * together — the same defensive shape memories.ts uses.
 */
function ftsQueryFrom(input: string): string | undefined {
  const tokens = [
    ...new Set(
      (input.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter(
        (w) => !STOPWORDS.has(w),
      ),
    ),
  ].slice(0, 12);
  if (tokens.length === 0) return undefined;
  return tokens.map((w) => `"${w}"`).join(" OR ");
}

function getDocRow(id: number): Doc | undefined {
  return getDb().prepare("SELECT * FROM docs WHERE id = ?").get(id) as
    | Doc
    | undefined;
}

function getDocRowBySlug(project: string, slug: string): Doc | undefined {
  return getDb()
    .prepare("SELECT * FROM docs WHERE project = ? AND slug = ?")
    .get(slugify(project), slugify(slug)) as Doc | undefined;
}

function writeAttachments(project: string, attachments?: Attachment[]): string[] {
  if (!attachments || attachments.length === 0) return [];
  const rels: string[] = [];
  for (const a of attachments) {
    // basename only — never let an attachment name escape the project dir
    const name = path.basename(a.filename);
    const rel = `${project}/${name}`;
    fs.writeFileSync(absPath(rel), a.content);
    rels.push(rel);
  }
  return rels;
}

/**
 * Create or update a doc. Identity is (project, slug); slug is derived from
 * the title unless overridden. On an existing slug we update in place: the
 * current body is preserved as <slug>.v<N>.md, the new body is written, and
 * the version is bumped. The FTS row (rowid == doc id) is rewritten to match.
 */
export function saveDoc(input: SaveDocInput): SaveDocResult {
  const project = slugify(input.project);
  const slug = slugify(input.slug ?? input.title);
  const relPath = `${project}/${slug}.md`;
  const existing = getDocRowBySlug(project, slug);

  fs.mkdirSync(path.join(docsDir(), project), { recursive: true });

  const db = getDb();

  if (existing) {
    // Preserve the current body as a versioned sidecar before overwriting.
    const currentAbs = absPath(existing.file_path);
    if (fs.existsSync(currentAbs)) {
      const priorRel = `${project}/${slug}.v${existing.version}.md`;
      fs.copyFileSync(currentAbs, absPath(priorRel));
    }
    fs.writeFileSync(absPath(relPath), input.content);
    const attachmentRels = writeAttachments(project, input.attachments);
    const newVersion = existing.version + 1;
    db.prepare(
      `UPDATE docs SET title = @title, tags = @tags, summary = @summary,
         task_id = COALESCE(@task_id, task_id),
         agent_id = COALESCE(@agent_id, agent_id),
         file_path = @file_path,
         attachments = @attachments, version = @version,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = @id`,
    ).run({
      id: existing.id,
      title: input.title,
      tags: input.tags ?? null,
      summary: input.summary ?? null,
      task_id: input.task_id ?? null,
      agent_id: input.agent_id ?? null,
      file_path: relPath,
      attachments:
        attachmentRels.length > 0 ? JSON.stringify(attachmentRels) : null,
      version: newVersion,
    });
    reindex(existing.id, input);
    return { doc: getDocRow(existing.id)!, created: false };
  }

  fs.writeFileSync(absPath(relPath), input.content);
  const attachmentRels = writeAttachments(project, input.attachments);
  const info = db
    .prepare(
      `INSERT INTO docs (slug, project, title, tags, task_id, agent_id, summary, file_path, attachments)
       VALUES (@slug, @project, @title, @tags, @task_id, @agent_id, @summary, @file_path, @attachments)`,
    )
    .run({
      slug,
      project,
      title: input.title,
      tags: input.tags ?? null,
      task_id: input.task_id ?? null,
      agent_id: input.agent_id ?? null,
      summary: input.summary ?? null,
      file_path: relPath,
      attachments:
        attachmentRels.length > 0 ? JSON.stringify(attachmentRels) : null,
    });
  const id = Number(info.lastInsertRowid);
  reindex(id, input);
  return { doc: getDocRow(id)!, created: true };
}

/** Keep the FTS row (keyed by rowid == doc id) in sync with a save. */
function reindex(id: number, input: SaveDocInput): void {
  const db = getDb();
  db.prepare("DELETE FROM docs_fts WHERE rowid = ?").run(id);
  db.prepare(
    "INSERT INTO docs_fts (rowid, title, tags, summary, body) VALUES (?, ?, ?, ?, ?)",
  ).run(id, input.title, input.tags ?? "", input.summary ?? "", input.content);
}

/** Fetch a doc (with its body) by numeric id, or by slug within a project. */
export function getDoc(
  key: number | string,
  project?: string,
): DocWithContent | undefined {
  let row: Doc | undefined;
  if (typeof key === "number") {
    row = getDocRow(key);
  } else if (/^\d+$/.test(key)) {
    row = getDocRow(Number(key));
  } else if (project) {
    row = getDocRowBySlug(project, key);
  } else {
    // no project given: fall back to the newest doc with this slug
    row = getDb()
      .prepare("SELECT * FROM docs WHERE slug = ? ORDER BY updated_at DESC LIMIT 1")
      .get(slugify(key)) as Doc | undefined;
  }
  if (!row) return undefined;
  const abs = absPath(row.file_path);
  const content = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
  return { ...row, content };
}

export function listDocs(opts?: { project?: string; tag?: string }): Doc[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts?.project) {
    clauses.push("project = ?");
    params.push(slugify(opts.project));
  }
  if (opts?.tag) {
    clauses.push("tags LIKE ?");
    params.push(`%${opts.tag}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return getDb()
    .prepare(`SELECT * FROM docs ${where} ORDER BY updated_at DESC`)
    .all(...params) as Doc[];
}

export interface ScoredDoc extends Doc {
  score: number;
}

/**
 * Ranked full-text search over title/tags/summary/body. Title matches weigh
 * most, then tags, then summary, then body — a query word in the title is a
 * far stronger signal than one buried in a long body.
 */
export function searchDocs(
  query: string,
  limit = 10,
  project?: string,
): ScoredDoc[] {
  const fts = ftsQueryFrom(query);
  if (!fts) return [];
  const projectClause = project ? "AND d.project = ?" : "";
  const params: unknown[] = [fts];
  if (project) params.push(slugify(project));
  params.push(limit);
  try {
    return getDb()
      .prepare(
        `SELECT d.*, bm25(docs_fts, 5.0, 3.0, 2.0, 1.0) AS score
         FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid
         WHERE docs_fts MATCH ? ${projectClause}
         ORDER BY score LIMIT ?`,
      )
      .all(...params) as ScoredDoc[];
  } catch {
    return []; // defensive: a term that is somehow still FTS syntax
  }
}

/** Delete a doc and its FTS row. The on-disk files are left in place (they
 *  are Caleb's to keep/grep); only the index entry is removed. */
export function deleteDoc(id: number): boolean {
  const db = getDb();
  db.prepare("DELETE FROM docs_fts WHERE rowid = ?").run(id);
  return db.prepare("DELETE FROM docs WHERE id = ?").run(id).changes === 1;
}
