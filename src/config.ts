import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
