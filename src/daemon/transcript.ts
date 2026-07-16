import fs from "node:fs";
import path from "node:path";
import { claudeProjectsDir, codexHome } from "../config.js";
import type { AgentProvider } from "../providers.js";

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
export function findClaudeTranscript(sessionId: string): string | undefined {
  const base = claudeProjectsDir();
  if (!fs.existsSync(base)) return undefined;
  for (const dir of fs.readdirSync(base)) {
    const file = path.join(base, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return undefined;
}

/** Backwards-compatible name for the existing Claude transcript lookup. */
export const findTranscript = findClaudeTranscript;

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * A Codex hook supplies transcript_path, but hook input is not a trusted file
 * capability. Accept only existing JSONL files whose real path is contained by
 * Command Center's isolated CODEX_HOME/sessions tree and whose session_meta row
 * identifies the requested session. Unknown JSONL rows remain safe to ignore.
 */
function validCodexTranscript(file: string, sessionId: string): string | undefined {
  const sessions = path.join(codexHome(), "sessions");
  if (!fs.existsSync(sessions) || !fs.existsSync(file)) return undefined;
  let realRoot: string;
  let realFile: string;
  try {
    realRoot = fs.realpathSync(sessions);
    realFile = fs.realpathSync(file);
  } catch {
    return undefined;
  }
  if (!isWithin(realRoot, realFile) || path.extname(realFile) !== ".jsonl") {
    return undefined;
  }

  try {
    const buffer = Buffer.alloc(256 * 1024);
    const fd = fs.openSync(realFile, "r");
    let bytes: number;
    try {
      bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    for (const line of buffer.subarray(0, bytes).toString("utf8").split("\n")) {
      if (!line.includes('"session_meta"')) continue;
      const row = JSON.parse(line) as {
        type?: string;
        payload?: { id?: string; session_id?: string };
      };
      if (row.type !== "session_meta") continue;
      return row.payload?.id === sessionId || row.payload?.session_id === sessionId
        ? realFile
        : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function findCodexTranscript(
  sessionId: string,
  transcriptPath?: string | null,
): string | undefined {
  if (transcriptPath) {
    const supplied = validCodexTranscript(path.resolve(transcriptPath), sessionId);
    if (supplied) return supplied;
  }

  const sessions = path.join(codexHome(), "sessions");
  if (!fs.existsSync(sessions)) return undefined;
  const stack = [sessions];
  let visited = 0;
  while (stack.length > 0 && visited < 10_000) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++visited >= 10_000) break;
      const candidate = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        stack.push(candidate);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".jsonl") &&
        entry.name.includes(sessionId)
      ) {
        const valid = validCodexTranscript(candidate, sessionId);
        if (valid) return valid;
      }
    }
  }
  return undefined;
}

export function findProviderTranscript(
  provider: AgentProvider,
  sessionId: string,
  transcriptPath?: string | null,
): string | undefined {
  return provider === "codex"
    ? findCodexTranscript(sessionId, transcriptPath)
    : findClaudeTranscript(sessionId);
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

const SENSITIVE_KEY_RE = /(authorization|cookie|credential|password|secret|token|api[_-]?key)/i;

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        SENSITIVE_KEY_RE.test(key) ? "[REDACTED]" : redactValue(item, depth + 1),
      ]),
    );
  }
  return value;
}

function redactText(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    .replace(
      /\b(authorization|cookie|credential|password|secret|token|api[_-]?key)\s*[:=]\s*([^\s,;]+)/gi,
      "$1=[REDACTED]",
    );
}

function safeToolInput(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(redactValue(JSON.parse(value)));
    } catch {
      return redactText(value);
    }
  }
  return JSON.stringify(redactValue(value ?? {}));
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
        const input = safeToolInput(block.input);
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

interface CodexContentBlock {
  type?: string;
  text?: string;
}

function compactToolInput(value: unknown): string {
  const text = safeToolInput(value);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function readCodexTranscriptFile(file: string, limit: number): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let row: {
      type?: string;
      payload?: {
        type?: string;
        role?: string;
        content?: CodexContentBlock[];
        name?: string;
        namespace?: string;
        arguments?: unknown;
        input?: unknown;
      };
    };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type !== "response_item" || !row.payload) continue;
    const payload = row.payload;
    if (
      payload.type === "message" &&
      (payload.role === "user" || payload.role === "assistant")
    ) {
      const text = (Array.isArray(payload.content) ? payload.content : [])
        .filter((block) => block.type === "input_text" || block.type === "output_text")
        .map((block) => block.text?.trim() ?? "")
        .filter(Boolean)
        .join("\n");
      if (text) entries.push({ role: payload.role, text });
    } else if (
      payload.type === "function_call" ||
      payload.type === "custom_tool_call"
    ) {
      const name = [payload.namespace, payload.name].filter(Boolean).join(".");
      if (name) {
        entries.push({
          role: "tool",
          text: `${name}(${compactToolInput(payload.arguments ?? payload.input)})`,
        });
      }
    } else if (payload.type === "web_search_call") {
      entries.push({ role: "tool", text: "web_search" });
    }
  }
  return entries.slice(-limit);
}

export function readProviderTranscript(
  provider: AgentProvider,
  sessionId: string,
  transcriptPath?: string | null,
  limit = 200,
): TranscriptEntry[] | undefined {
  if (provider === "claude") return readTranscript(sessionId, limit);
  const file = findCodexTranscript(sessionId, transcriptPath);
  return file ? readCodexTranscriptFile(file, limit) : undefined;
}

export interface SessionTokens {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
  total: number;
}

/** Sum the per-turn usage a session's transcript records for its assistant
 *  messages. Approximate cost signal, not billing truth. */
export function sessionTokens(sessionId: string): SessionTokens | undefined {
  const file = findTranscript(sessionId);
  if (!file) return undefined;

  const t: SessionTokens = { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0 };
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"usage"')) continue;
    let row: { type?: string; message?: { usage?: Record<string, unknown> } };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type !== "assistant") continue;
    const u = row.message?.usage;
    if (!u) continue;
    const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
    t.input += n("input_tokens");
    t.output += n("output_tokens");
    t.cache_read += n("cache_read_input_tokens");
    t.cache_creation += n("cache_creation_input_tokens");
  }
  t.total = t.input + t.output + t.cache_read + t.cache_creation;
  return t;
}

function codexSessionTokens(file: string): SessionTokens {
  let latest: SessionTokens = {
    input: 0,
    output: 0,
    cache_read: 0,
    cache_creation: 0,
    total: 0,
  };
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"token_count"')) continue;
    let row: {
      type?: string;
      payload?: {
        type?: string;
        info?: { total_token_usage?: Record<string, unknown> } | null;
      };
    };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = row.payload?.info?.total_token_usage;
    if (row.type !== "event_msg" || row.payload?.type !== "token_count" || !usage) {
      continue;
    }
    const n = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
    const output = n("output_tokens") + n("reasoning_output_tokens");
    latest = {
      input: n("input_tokens"),
      output,
      cache_read: n("cached_input_tokens"),
      cache_creation: 0,
      total: n("total_tokens") || n("input_tokens") + output,
    };
  }
  return latest;
}

export function providerSessionTokens(
  provider: AgentProvider,
  sessionId: string,
  transcriptPath?: string | null,
): SessionTokens | undefined {
  if (provider === "claude") return sessionTokens(sessionId);
  const file = findCodexTranscript(sessionId, transcriptPath);
  return file ? codexSessionTokens(file) : undefined;
}
