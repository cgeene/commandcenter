import os from "node:os";
import path from "node:path";

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
