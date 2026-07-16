import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAgentProvider, type AgentProvider } from "./providers.js";

// Resolved at call time (not import time) so tests can point CC_DATA_DIR
// at a temp dir before touching the DB.
export function dataDir(): string {
  return process.env.CC_DATA_DIR ?? path.join(os.homedir(), ".commandcenter");
}

export function dbPath(): string {
  return path.join(dataDir(), "state.db");
}

export function worktreesDir(): string {
  return path.join(dataDir(), "worktrees");
}

/** Command Center-owned, non-Git workspaces for investigation-only tasks. */
export function scratchWorkspacesDir(): string {
  return process.env.CC_SCRATCH_DIR ?? path.join(dataDir(), "scratch");
}

/** Colon-separated allow-list of roots the repository picker may expose. */
export function configuredRepoRoots(): string[] {
  const raw = (process.env.CC_REPO_ROOTS ?? process.env.CC_REPO_ROOT ?? "").trim();
  if (!raw) return [];
  return raw
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
}

/** Finished scratch workspaces are retained briefly for audit/resume. */
export function scratchRetentionDays(): number {
  const parsed = Number(process.env.CC_SCRATCH_RETENTION_DAYS ?? 7);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 90 ? parsed : 7;
}

export function promptsDir(): string {
  return path.join(dataDir(), "prompts");
}

/** Root of the internal long-term doc store — plain markdown + sidecar files
 *  under <root>/<project>/<slug>.md so they can be read/grepped directly. */
export function docsDir(): string {
  return process.env.CC_DOCS_DIR ?? path.join(dataDir(), "docs");
}

export function port(): number {
  return Number(process.env.CC_PORT ?? 4711);
}

export function baseUrl(): string {
  return process.env.CC_URL ?? `http://127.0.0.1:${port()}`;
}

export function claudeBin(): string {
  return process.env.CC_CLAUDE_BIN ?? "claude";
}

export function codexBin(): string {
  return process.env.CC_CODEX_BIN ?? "codex";
}

/** Command Center owns this Codex config root and never rewrites ~/.codex. */
export function codexHome(): string {
  return process.env.CC_CODEX_HOME ?? path.join(dataDir(), "codex");
}

/** Optional normal Codex home whose MCP/plugin configuration is mirrored into
 * Command Center's isolated home. State, auth, history, and sessions are never
 * inherited. */
export function codexMcpSourceHome(): string | undefined {
  const value = process.env.CC_CODEX_MCP_SOURCE_HOME?.trim();
  return value || undefined;
}

export function codexProfile(): string {
  return process.env.CC_CODEX_PROFILE ?? "commandcenter";
}

export function defaultWorkerProvider(): AgentProvider {
  return parseAgentProvider(process.env.CC_WORKER_PROVIDER, "claude");
}

/** Claude model used by the orchestrator unless a spawn explicitly overrides it.
 *  Defaults to Fable 5, which is suited to long-running orchestration and
 *  delegation; override with CC_MAIN_MODEL (e.g. CC_MAIN_MODEL=opus). */
export function defaultMainModel(): string {
  return process.env.CC_MAIN_MODEL?.trim() || "fable";
}

/** Optional pinned reviewer provider (CC_REVIEWER_PROVIDER). Undefined means
 *  "no explicit pin" — the reviewer-provider resolver then applies the
 *  model-variety policy (when enabled) or defaults to Claude. */
export function defaultReviewerProvider(): string | undefined {
  const value = process.env.CC_REVIEWER_PROVIDER?.trim();
  return value || undefined;
}

/** Whether the scheduler's auto-review should pick the OPPOSITE provider from
 *  the worker (cross-model adversarial review). Opt-in because the platform
 *  cannot safely auto-detect that both providers are configured — enabling it
 *  asserts Codex is set up; otherwise reviewers stay Claude (unchanged). */
export function reviewerVarietyEnabled(): boolean {
  const value = process.env.CC_REVIEWER_VARIETY?.trim().toLowerCase() ?? "";
  return ["1", "true", "on", "yes"].includes(value);
}

export function tmuxSession(): string {
  return process.env.CC_TMUX_SESSION ?? "cc";
}

/** Package root (works from both src/ via tsx and dist/ when built). */
export function pkgRoot(): string {
  return fileURLToPath(new URL("..", import.meta.url));
}

export function webDistDir(): string {
  return path.join(pkgRoot(), "web", "dist");
}

/** ntfy topic URL, e.g. https://ntfy.sh/my-secret-topic — unset disables push. */
export function ntfyUrl(): string | undefined {
  return process.env.CC_NTFY_URL;
}

export function ntfyToken(): string | undefined {
  return process.env.CC_NTFY_TOKEN;
}

export function claudeProjectsDir(): string {
  return (
    process.env.CC_CLAUDE_PROJECTS ??
    path.join(os.homedir(), ".claude", "projects")
  );
}

/**
 * Explicit workspace-context mapping: directory-prefix -> CLAUDE.md path(s).
 * Any repo whose path sits under a prefix imports that prefix's file(s) into
 * its worktree, on top of what's inferred from the repo's ancestor dirs (see
 * src/lib/context-roots.ts). Set via CC_CONTEXT_ROOTS as JSON, e.g.
 *   {"/Users/me/projects/nylas":"/Users/me/notes/nylas.md",
 *    "/opt/repos":["/opt/shared/CLAUDE.md"]}
 * A string value is treated as a single-element list. Malformed JSON is
 * ignored (returns {}) so a typo can never crash the daemon.
 */
export function contextRoots(): Record<string, string[]> {
  const raw = process.env.CC_CONTEXT_ROOTS;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string[]> = {};
    for (const [prefix, value] of Object.entries(parsed)) {
      out[prefix] = Array.isArray(value) ? value.map(String) : [String(value)];
    }
    return out;
  } catch {
    return {};
  }
}
