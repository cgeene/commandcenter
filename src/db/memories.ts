import { getDb } from "./db.js";
import { logEvent } from "./events.js";

export interface Memory {
  id: number;
  text: string;
  tags: string | null;
  task_id: number | null;
  agent_id: number | null;
  use_count: number;
  last_used_at: string | null;
  created_at: string;
}

export interface ScoredMemory extends Memory {
  /** Blended rank score (lower = better, bm25-based). */
  score: number;
  /** How many distinct query terms this memory actually contains. */
  matched: number;
}

export function addMemory(m: {
  text: string;
  tags?: string;
  task_id?: number;
  agent_id?: number;
}): Memory {
  const info = getDb()
    .prepare(
      "INSERT INTO memories (text, tags, task_id, agent_id) VALUES (@text, @tags, @task_id, @agent_id)",
    )
    .run({
      text: m.text,
      tags: m.tags ?? null,
      task_id: m.task_id ?? null,
      agent_id: m.agent_id ?? null,
    });
  return getMemory(Number(info.lastInsertRowid))!;
}

export function getMemory(id: number): Memory | undefined {
  return getDb().prepare("SELECT * FROM memories WHERE id = ?").get(id) as
    | Memory
    | undefined;
}

export function deleteMemory(id: number): boolean {
  return getDb().prepare("DELETE FROM memories WHERE id = ?").run(id).changes === 1;
}

export function listMemories(limit = 50): Memory[] {
  return getDb()
    .prepare("SELECT * FROM memories ORDER BY id DESC LIMIT ?")
    .all(limit) as Memory[];
}

/** Bump recall usage — feeds the ranking boost and the dreamer's pruning data. */
export function markRecalled(ids: number[]): void {
  if (ids.length === 0) return;
  const marks = ids.map(() => "?").join(",");
  getDb()
    .prepare(
      `UPDATE memories SET use_count = use_count + 1,
         last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id IN (${marks})`,
    )
    .run(...ids);
}

// hyphens split (FTS5's unicode61 tokenizer treats - and _ as separators)
function tokenize(input: string): string[] {
  return [
    ...new Set(
      (input.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter(
        (w) => !STOPWORDS.has(w),
      ),
    ),
  ];
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "are", "was", "were",
  "has", "have", "had", "not", "but", "its", "it's", "into", "when", "then",
  "than", "them", "they", "you", "your", "our", "all", "any", "can", "should",
  "will", "would", "there", "their", "these", "those", "what", "which", "how",
]);

const MAX_TERMS = 12;
/** Below this corpus size IDF is meaningless — every term is "rare". */
const IDF_MIN_CORPUS = 8;

/**
 * Build an FTS5 query from natural language. FTS5 chokes on raw NL (quotes,
 * parens, hyphens are syntax), so reduce to bare word tokens OR'd together.
 *
 * Term selection is IDF-aware: instead of the FIRST 12 distinct words (which
 * for a long task prompt means "the title and the opening sentence"), rank
 * candidate terms by rarity in the memory corpus itself (fts5vocab) and keep
 * the most distinctive ones. Terms absent from the corpus match nothing and
 * are dropped. `boost` terms (e.g. the repo name) are always included.
 */
export function ftsQueryFrom(input: string, boost?: string): string | undefined {
  const tokens = tokenize(input);
  const boostTokens = boost ? tokenize(boost) : [];
  const all = [...new Set([...boostTokens, ...tokens])];
  if (all.length === 0) return undefined;

  const db = getDb();
  const total = (db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n;

  let chosen: string[];
  if (total < IDF_MIN_CORPUS) {
    chosen = all.slice(0, MAX_TERMS);
  } else {
    const marks = all.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT term, doc FROM memories_vocab WHERE term IN (${marks})`)
      .all(...all) as { term: string; doc: number }[];
    const df = new Map(rows.map((r) => [r.term, r.doc]));
    const known = tokens
      .filter((w) => df.has(w))
      .map((w) => ({
        w,
        idf: Math.log((total - df.get(w)! + 0.5) / (df.get(w)! + 0.5) + 1),
      }))
      .sort((a, b) => b.idf - a.idf)
      .map((s) => s.w);
    chosen = [
      ...new Set([...boostTokens.filter((w) => df.has(w)), ...known]),
    ].slice(0, MAX_TERMS);
    // query shares no vocabulary with the corpus — fall back to raw terms
    // (matches nothing, but keeps behavior predictable)
    if (chosen.length === 0) chosen = all.slice(0, MAX_TERMS);
  }
  return chosen.map((w) => `"${w}"`).join(" OR ");
}

function termsOf(fts: string): string[] {
  return (fts.match(/"([^"]+)"/g) ?? []).map((t) => t.slice(1, -1));
}

/**
 * Ranked search. Ordering blends:
 * - bm25 with tags weighted 3x over text (a `repo:functions` tag match is a
 *   stronger signal than the word appearing mid-sentence)
 * - a recall-usage boost (memories agents deliberately recalled rank higher;
 *   injections do NOT count — that would be a rich-get-richer loop)
 * - a gentle age penalty so stale lessons drift down, not off a cliff
 */
export function searchMemoriesScored(
  query: string,
  limit = 10,
  boost?: string,
): ScoredMemory[] {
  const fts = ftsQueryFrom(query, boost);
  if (!fts) return [];
  let rows: (Memory & { score: number })[];
  try {
    rows = getDb()
      .prepare(
        `SELECT m.*,
           bm25(memories_fts, 1.0, 3.0)
             - 0.05 * MIN(m.use_count, 20)
             + 0.002 * (julianday('now') - julianday(m.created_at)) AS score
         FROM memories_fts
         JOIN memories m ON m.id = memories_fts.rowid
         WHERE memories_fts MATCH ?
         ORDER BY score LIMIT ?`,
      )
      .all(fts, limit) as (Memory & { score: number })[];
  } catch {
    return []; // defensive: a term that is somehow still FTS syntax
  }
  const terms = termsOf(fts);
  return rows.map((m) => {
    const hay = `${m.text} ${m.tags ?? ""}`.toLowerCase();
    return { ...m, matched: terms.filter((t) => hay.includes(t)).length };
  });
}

export function searchMemories(query: string, limit = 10): Memory[] {
  const scored = searchMemoriesScored(query, limit);
  if (scored.length > 0) return scored;
  // no usable terms or no matches on a query-less browse: recent list
  return ftsQueryFrom(query) === undefined ? listMemories(limit) : [];
}

/** Near-duplicates of a candidate text — surfaced by `remember` so agents
 *  (and the dreamer) can merge instead of piling up variants. */
export function similarMemories(
  text: string,
  excludeId?: number,
  limit = 3,
): ScoredMemory[] {
  return searchMemoriesScored(text, limit + 1)
    .filter((m) => m.id !== excludeId && m.matched >= 4)
    .slice(0, limit);
}

/**
 * Render the top memory hits for a task as a prompt section ("" if none).
 * Injection has a relevance floor: a memory must share >=2 distinct query
 * terms (or mention the repo) to make the cut — 5 keyword-adjacent misses
 * teach workers to ignore the section, so nothing beats noise.
 */
export function memorySectionFor(
  query: string,
  limit = 5,
  opts?: { taskId?: number; repo?: string },
): string {
  const repoBase = opts?.repo?.split("/").pop()?.toLowerCase();
  const hits = searchMemoriesScored(query, limit * 2, repoBase).filter(
    (m) =>
      m.matched >= 2 ||
      (repoBase !== undefined &&
        `${m.text} ${m.tags ?? ""}`.toLowerCase().includes(repoBase)),
  );
  if (hits.length === 0) return "";
  const top = hits.slice(0, limit);
  logEvent("memory.injected", {
    taskId: opts?.taskId,
    payload: { ids: top.map((m) => m.id) },
  });
  const bullets = top.map((m) => `- ${m.text}`).join("\n");
  return `\n## Platform memory (lessons from past work — verify before relying on them)\n${bullets}\n`;
}
