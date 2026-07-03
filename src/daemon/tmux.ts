import { execFileSync } from "node:child_process";
import { tmuxSession } from "../config.js";

function tmux(...args: string[]): string {
  return execFileSync("tmux", args, { encoding: "utf8" });
}

export function ensureSession(): void {
  try {
    tmux("has-session", "-t", tmuxSession());
  } catch {
    tmux("new-session", "-d", "-s", tmuxSession(), "-n", "hub");
  }
}

/**
 * Create a detached window running `command` (a shell string) with cwd.
 * Returns a stable tmux target (session:window_id, e.g. "cc:@3") —
 * window IDs don't shift when other windows close, unlike indexes.
 */
export function newWindow(name: string, cwd: string, command: string): string {
  ensureSession();
  const target = tmux(
    "new-window",
    "-d",
    "-t",
    tmuxSession(),
    "-n",
    name,
    "-c",
    cwd,
    "-P",
    "-F",
    "#{session_name}:#{window_id}",
    command,
  ).trim();
  // Keep the window around if the process exits so crashes are inspectable.
  tmux("set-option", "-w", "-t", target, "remain-on-exit", "on");
  return target;
}

export function killWindow(target: string): void {
  tmux("kill-window", "-t", target);
}

export function windowExists(target: string): boolean {
  try {
    const ids = tmux(
      "list-windows",
      "-t",
      tmuxSession(),
      "-F",
      "#{session_name}:#{window_id}",
    );
    return ids.split("\n").includes(target);
  } catch {
    return false; // session itself is gone
  }
}

/**
 * Send a prompt to a running interactive session. Literal-mode text and the
 * Enter key are sent separately with a small gap — sending them together is
 * the classic send-keys race where the REPL swallows the newline.
 */
export async function sendText(target: string, text: string): Promise<void> {
  tmux("send-keys", "-t", target, "-l", text);
  await new Promise((r) => setTimeout(r, 300));
  tmux("send-keys", "-t", target, "Enter");
}

/** Capture the visible pane content (for `agp peek`). */
export function capturePane(target: string, lines = 50): string {
  const out = tmux("capture-pane", "-p", "-t", target, "-S", `-${lines}`);
  return out.replace(/\n+$/, "");
}
