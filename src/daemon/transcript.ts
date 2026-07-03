import fs from "node:fs";
import path from "node:path";
import { claudeProjectsDir } from "../config.js";

export interface TranscriptEntry {
  role: "user" | "assistant" | "tool";
  text: string;
}

/**
 * Claude Code writes session transcripts to
 * ~/.claude/projects/<munged-cwd>/<session-id>.jsonl. Rather than reproduce
 * the cwd-munging rule, scan the project dirs for the session file — session
 * ids are unique.
 */
export function findTranscript(sessionId: string): string | undefined {
  const base = claudeProjectsDir();
  if (!fs.existsSync(base)) return undefined;
  for (const dir of fs.readdirSync(base)) {
    const file = path.join(base, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return undefined;
}

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
}

function blocksOf(message: unknown): ContentBlock[] {
  const content = (message as { content?: unknown })?.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

/** Parse a transcript into a simplified chat view (last `limit` entries). */
export function readTranscript(
  sessionId: string,
  limit = 200,
): TranscriptEntry[] | undefined {
  const file = findTranscript(sessionId);
  if (!file) return undefined;

  const entries: TranscriptEntry[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let row: { type?: string; message?: unknown };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type !== "user" && row.type !== "assistant") continue;

    for (const block of blocksOf(row.message)) {
      if (block.type === "text" && block.text?.trim()) {
        entries.push({ role: row.type, text: block.text });
      } else if (block.type === "tool_use" && block.name) {
        const input = JSON.stringify(block.input ?? {});
        entries.push({
          role: "tool",
          text: `${block.name}(${input.length > 300 ? input.slice(0, 300) + "…" : input})`,
        });
      }
      // tool_result blocks are skipped — too noisy for the dashboard view
    }
  }
  return entries.slice(-limit);
}
