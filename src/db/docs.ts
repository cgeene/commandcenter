import fs from "node:fs";
import path from "node:path";
import { docsDir } from "../config.js";
import {
  emitFrontmatter,
  stripFrontmatter,
  type FrontmatterValue,
} from "../lib/frontmatter.js";
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

/** Split a stored comma-separated tag string into a trimmed, non-empty list. */
function tagList(tags: string | null): string[] {
  return tags
    ? tags.split(",").map((t) => t.trim()).filter(Boolean)
    : [];
}

/**
 * Render the YAML frontmatter for a doc from its (authoritative) DB row. The
 * file is self-describing: the whole index could be rebuilt from disk. The FTS
 * body deliberately excludes this — the metadata fields have their own FTS
 * columns (see reindex()), so on-disk content and the search body never diverge.
 */
function frontmatterFor(row: Doc): string {
  const entries: Array<[string, FrontmatterValue]> = [
    ["title", row.title],
    ["project", row.project],
    ["slug", row.slug],
    ["tags", tagList(row.tags)],
    ["summary", row.summary],
    ["task_id", row.task_id],
    ["agent_id", row.agent_id],
    ["version", row.version],
    ["created_at", row.created_at],
    ["updated_at", row.updated_at],
  ];
  return emitFrontmatter(entries);
}

/** Write a doc's file as `<frontmatter><body>` (no extra separator, so the
 *  body round-trips exactly through stripFrontmatter). */
function writeDocFile(row: Doc, content: string): void {
  fs.writeFileSync(absPath(row.file_path), frontmatterFor(row) + content);
}

/** Relative path of a doc's version sidecars, kept out of the main folder. */
function versionRel(project: string, slug: string, version: number): string {
  return `${project}/_versions/${slug}.v${version}.md`;
}

/**
 * Regenerate a project's `_index.md` map-of-content: one linked, summarized
 * line per current doc, newest first. This is the entry point for a human
 * browsing the folder and for an agent doing list-then-read. Version sidecars,
 * attachments, and the index itself are excluded (they aren't docs rows).
 */
function regenerateIndex(project: string): void {
  const docs = listDocs({ project });
  const items = docs
    .map((d) => {
      const summary = d.summary ? ` — ${d.summary.replace(/\s+/g, " ").trim()}` : "";
      return `- [${d.title}](${d.slug}.md)${summary}`;
    })
    .join("\n");
  const now = (
    getDb()
      .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS t")
      .get() as { t: string }
  ).t;
  const fm = emitFrontmatter([
    ["title", `${project} — index`],
    ["project", project],
    ["kind", "index"],
    ["updated_at", now],
  ]);
  const body = `# ${project}\n\n${items ? `${items}\n` : "_No docs yet._\n"}`;
  fs.mkdirSync(path.join(docsDir(), project), { recursive: true });
  fs.writeFileSync(absPath(`${project}/_index.md`), fm + body);
}

/**
 * Create or update a doc. Identity is (project, slug); slug is derived from
 * the title unless overridden. On an existing slug we update in place: the
 * current body is frozen under <project>/_versions/<slug>.v<N>.md, the new body
 * is written, and the version is bumped. The DB row is the source of truth for
 * metadata; the file is (re)rendered from it with YAML frontmatter prepended.
 * The FTS row (rowid == doc id) indexes only the body — not the frontmatter.
 * The project's _index.md is regenerated after every save.
 */
export function saveDoc(input: SaveDocInput): SaveDocResult {
  const project = slugify(input.project);
  const slug = slugify(input.slug ?? input.title);
  const relPath = `${project}/${slug}.md`;
  const existing = getDocRowBySlug(project, slug);

  fs.mkdirSync(path.join(docsDir(), project), { recursive: true });

  const db = getDb();
  let id: number;
  let created: boolean;

  if (existing) {
    // Freeze the current body as a version sidecar (out of the main folder)
    // before overwriting.
    const currentAbs = absPath(existing.file_path);
    if (fs.existsSync(currentAbs)) {
      const priorRel = versionRel(project, slug, existing.version);
      fs.mkdirSync(path.dirname(absPath(priorRel)), { recursive: true });
      fs.copyFileSync(currentAbs, absPath(priorRel));
    }
    const attachmentRels = writeAttachments(project, input.attachments);
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
      version: existing.version + 1,
    });
    id = existing.id;
    created = false;
  } else {
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
    id = Number(info.lastInsertRowid);
    created = true;
  }

  // The row is now authoritative; render the file from it and keep FTS + the
  // project index in sync.
  const row = getDocRow(id)!;
  writeDocFile(row, input.content);
  reindex(id, input);
  regenerateIndex(project);
  return { doc: row, created };
}

/** Keep the FTS row (keyed by rowid == doc id) in sync with a save. The body
 *  column is the doc body ONLY — the frontmatter written to disk is not indexed
 *  here (its fields already have their own title/tags/summary FTS columns), so
 *  the on-disk file and the search body never diverge. */
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
  // Strip the on-disk frontmatter: callers already receive those fields as
  // structured columns, so returning them again in the body would duplicate
  // the metadata (and burn an agent's tokens twice).
  const content = fs.existsSync(abs)
    ? stripFrontmatter(fs.readFileSync(abs, "utf8"))
    : "";
  return { ...row, content };
}

export interface AttachmentFile {
  filename: string;
  content: Buffer;
}

/**
 * Read one of a doc's sidecar attachments by filename. The lookup is scoped to
 * the doc's own recorded attachment list and the name is reduced to a basename
 * first, so a caller can never use this to read an arbitrary file off disk.
 * Returns undefined if the doc, the attachment record, or the file is missing.
 */
export function getDocAttachment(
  key: number | string,
  name: string,
  project?: string,
): AttachmentFile | undefined {
  const doc = getDoc(key, project);
  if (!doc) return undefined;
  const base = path.basename(name); // traversal guard
  const rels: string[] = doc.attachments ? JSON.parse(doc.attachments) : [];
  const rel = rels.find((r) => path.basename(r) === base);
  if (!rel) return undefined;
  const abs = absPath(rel);
  if (!fs.existsSync(abs)) return undefined;
  return { filename: base, content: fs.readFileSync(abs) };
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
  // id DESC breaks updated_at ties so "newest first" is deterministic (the
  // _index.md ordering and the dashboard depend on it).
  return getDb()
    .prepare(`SELECT * FROM docs ${where} ORDER BY updated_at DESC, id DESC`)
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

/** Move a project's legacy top-level version sidecars (<slug>.v<N>.md) into
 *  its <project>/_versions/ folder. Returns how many were relocated. */
function relocateLegacySidecars(project: string): number {
  const dir = path.join(docsDir(), project);
  if (!fs.existsSync(dir)) return 0;
  let moved = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!/\.v\d+\.md$/.test(name)) continue;
    const from = path.join(dir, name);
    if (!fs.statSync(from).isFile()) continue;
    const versionsDir = path.join(dir, "_versions");
    fs.mkdirSync(versionsDir, { recursive: true });
    const to = path.join(versionsDir, name);
    // If the relocated copy already exists, just drop the stray top-level one.
    if (fs.existsSync(to)) fs.rmSync(from);
    else fs.renameSync(from, to);
    moved++;
  }
  return moved;
}

/**
 * Idempotent, one-shot upgrade of the on-disk doc store to the current layout:
 *  - prepend/refresh YAML frontmatter (derived from the DB row) on every doc
 *    file, so the folder is self-describing and the index could be rebuilt
 *    from disk;
 *  - relocate legacy top-level version sidecars under <project>/_versions/;
 *  - regenerate each project's _index.md.
 *
 * It reads metadata from the DB and rewrites files only — it never bumps
 * updated_at, touches version counters, or reindexes FTS. Running it a second
 * time is a no-op (returns zero updated/relocated).
 */
export function migrateDocsToFrontmatter(): {
  updated: number;
  relocated: number;
  indexed: number;
} {
  const rows = getDb().prepare("SELECT * FROM docs").all() as Doc[];
  const projects = new Set<string>();
  let updated = 0;
  for (const row of rows) {
    projects.add(row.project);
    const abs = absPath(row.file_path);
    if (!fs.existsSync(abs)) continue;
    const current = fs.readFileSync(abs, "utf8");
    const desired = frontmatterFor(row) + stripFrontmatter(current);
    if (desired !== current) {
      fs.writeFileSync(abs, desired);
      updated++;
    }
  }
  let relocated = 0;
  let indexed = 0;
  for (const project of projects) {
    relocated += relocateLegacySidecars(project);
    regenerateIndex(project);
    indexed++;
  }
  return { updated, relocated, indexed };
}
