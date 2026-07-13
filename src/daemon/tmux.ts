import { execFileSync } from "node:child_process";
import { tmuxSession } from "../config.js";
import { localeEnv } from "./locale.js";

function tmux(...args: string[]): string {
  // Run with a UTF-8 locale so the tmux server (and worker processes it
  // spawns) start under UTF-8 rather than the daemon's bare C locale.
  return execFileSync("tmux", args, { encoding: "utf8", env: localeEnv() });
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

/** All local tmux window targets, including an older agent session retained
 * across a CC_TMUX_SESSION change. Callers still match exact stored targets. */
export function listWindowIds(): string[] {
  try {
    return tmux(
      "list-windows",
      "-a",
      "-F",
      "#{session_name}:#{window_id}",
    )
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return []; // session itself is gone
  }
}

/**
 * A null snapshot means tmux could not be observed reliably. That must be
 * distinguished from an empty, successful snapshot: treating a transient
 * client/socket error as "every window vanished" orphans still-running
 * provider processes from Command Center's database.
 */
export type LiveWindowSnapshot = string[] | null;

function tmuxSessionIsDefinitelyAbsent(error: unknown): boolean {
  const detail =
    error instanceof Error
      ? `${error.message} ${String((error as Error & { stderr?: unknown }).stderr ?? "")}`
      : String(error);
  return /can't find session|no server running/i.test(detail);
}

/** Live process windows across all local tmux sessions. `remain-on-exit`
 * intentionally keeps crashed windows inspectable, so presence alone is not
 * a worker-health signal. */
export function listLiveWindowIds(): LiveWindowSnapshot {
  try {
    return tmux(
      "list-windows",
      "-a",
      "-F",
      "#{session_name}:#{window_id}\t#{pane_dead}",
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        const [target, dead] = line.split("\t");
        return dead === "0" ? [target] : [];
      });
  } catch (error) {
    // A missing session is a trustworthy empty result. Permission/socket/
    // locale/client failures are not; the watchdog must retry without
    // mutating agent or task state.
    return tmuxSessionIsDefinitelyAbsent(error) ? [] : null;
  }
}

export function windowExists(target: string): boolean {
  return listWindowIds().includes(target);
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

/** Press Enter without typing anything — submits whatever's already sitting
 *  in the input line, instead of retyping it. */
export function sendEnter(target: string): void {
  tmux("send-keys", "-t", target, "Enter");
}

/** Ctrl-U: clear the input line back to the prompt without submitting it. */
export function clearInputLine(target: string): void {
  tmux("send-keys", "-t", target, "C-u");
}
