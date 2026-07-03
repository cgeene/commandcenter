import { getDb } from "./db.js";

export interface Memory {
  id: number;
  text: string;
  tags: string | null;
  task_id: number | null;
  agent_id: number | null;
  created_at: string;
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

/**
 * FTS5 chokes on raw natural language (quotes, parens, hyphens are syntax),
 * so reduce the query to bare word tokens OR'd together and let bm25 rank.
 * Long inputs (task prompts) are capped to the first 12 distinct terms.
 */
export function ftsQueryFrom(input: string): string | undefined {
  const words = [
    ...new Set(
      (input.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []).filter(
        (w) => !STOPWORDS.has(w),
      ),
    ),
  ].slice(0, 12);
  if (words.length === 0) return undefined;
  return words.map((w) => `"${w}"`).join(" OR ");
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "are", "was", "were",
  "has", "have", "had", "not", "but", "its", "it's", "into", "when", "then",
  "than", "them", "they", "you", "your", "our", "all", "any", "can", "should",
  "will", "would", "there", "their", "these", "those", "what", "which", "how",
]);

export function searchMemories(query: string, limit = 10): Memory[] {
  const fts = ftsQueryFrom(query);
  if (!fts) return listMemories(limit);
  return getDb()
    .prepare(
      `SELECT m.* FROM memories_fts
       JOIN memories m ON m.id = memories_fts.rowid
       WHERE memories_fts MATCH ?
       ORDER BY bm25(memories_fts) LIMIT ?`,
    )
    .all(fts, limit) as Memory[];
}

/** Render the top memory hits for a task as a prompt section ("" if none). */
export function memorySectionFor(query: string, limit = 5): string {
  const hits = searchMemories(query, limit);
  if (hits.length === 0) return "";
  const bullets = hits.map((m) => `- ${m.text}`).join("\n");
  return `\n## Platform memory (lessons from past work — verify before relying on them)\n${bullets}\n`;
}
