import { execFile, execFileSync } from "node:child_process";
import { tmuxSession } from "../config.js";
import { localeEnv } from "./locale.js";
import { normalizeTty, terminatePaneTree, type PaneProcess } from "./proctree.js";

const TMUX_TIMEOUT_MS = 1_000;
const TMUX_MAX_BUFFER = 1024 * 1024;
let tmuxTimeoutMs = TMUX_TIMEOUT_MS;

export function _setTmuxTimeoutForTest(timeoutMs = TMUX_TIMEOUT_MS): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TMUX_TIMEOUT_MS) {
    throw new Error("invalid test tmux timeout");
  }
  tmuxTimeoutMs = timeoutMs;
}

export type TmuxFailureCode =
  | "timeout"
  | "session_absent"
  | "target_missing"
  | "no_client"
  | "failed";

/**
 * A deliberately sanitised tmux failure. Child-process errors include the
 * complete argv (which can contain prompts, environment values and session
 * targets), so none of those errors may escape this module.
 */
export class TmuxCommandError extends Error {
  constructor(
    readonly code: TmuxFailureCode,
    readonly operation: string,
  ) {
    super(`tmux ${operation} ${code === "timeout" ? "timed out" : "failed"}`);
    this.name = "TmuxCommandError";
  }
}

function rawFailureDetail(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const childError = error as Error & {
    code?: unknown;
    signal?: unknown;
    stderr?: unknown;
  };
  return [
    childError.message,
    childError.code,
    childError.signal,
    childError.stderr,
  ]
    .map(String)
    .join(" ");
}

function sanitiseFailure(error: unknown, operation: string): TmuxCommandError {
  const detail = rawFailureDetail(error);
  if (/ETIMEDOUT|SIGKILL|timed out/i.test(detail)) {
    return new TmuxCommandError("timeout", operation);
  }
  if (
    /can't find session|no server running|failed to connect to server|error connecting to .*\((?:no such file or directory|connection refused)\)/i.test(
      detail,
    )
  ) {
    return new TmuxCommandError("session_absent", operation);
  }
  if (/can't find (?:window|pane)|no such (?:window|pane)|unknown target/i.test(detail)) {
    return new TmuxCommandError("target_missing", operation);
  }
  if (/no current client/i.test(detail)) {
    return new TmuxCommandError("no_client", operation);
  }
  return new TmuxCommandError("failed", operation);
}

export function tmuxFailureCode(error: unknown): TmuxFailureCode {
  return error instanceof TmuxCommandError ? error.code : "failed";
}

function tmux(...args: string[]): string {
  // Run with a UTF-8 locale so the tmux server (and worker processes it
  // spawns) start under UTF-8 rather than the daemon's bare C locale.
  // Pipe stderr (rather than letting it inherit the daemon's console) so
  // tmux's own diagnostics — e.g. "error connecting to .../default" on the
  // first call before any server exists — don't leak to stdout as scary
  // boot noise. Raw child errors are classified locally, then discarded so
  // argv and stderr cannot escape through logs or API responses.
  try {
    return execFileSync("tmux", args, {
      encoding: "utf8",
      env: localeEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: tmuxTimeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: TMUX_MAX_BUFFER,
    });
  } catch (error) {
    throw sanitiseFailure(error, args[0] ?? "command");
  }
}

/**
 * Non-blocking control-plane invocation. In addition to killing the client,
 * the timer settles the Promise immediately, so HTTP/MCP work is not held
 * hostage waiting for a misbehaving child-process callback.
 */
export function runTmuxCommand(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = execFile(
      "tmux",
      [...args],
      {
        encoding: "utf8",
        env: localeEnv(),
        maxBuffer: TMUX_MAX_BUFFER,
      },
      (error, stdout) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          reject(sanitiseFailure(error, args[0] ?? "command"));
        } else {
          resolve(stdout);
        }
      },
    );
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new TmuxCommandError("timeout", args[0] ?? "command"));
    }, tmuxTimeoutMs);
  });
}

export function ensureSession(): void {
  try {
    tmux("has-session", "-t", tmuxSession());
  } catch (error) {
    if (tmuxFailureCode(error) !== "session_absent") throw error;
    tmux("new-session", "-d", "-s", tmuxSession(), "-n", "hub");
  }
}

function tmuxEnvironmentArgs(environment?: Record<string, string>): string[] {
  if (!environment) return [];
  const entries = Object.entries(environment).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (entries.length > 64) {
    throw new Error("too many pane-scoped environment variables");
  }
  return entries.flatMap(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) {
      throw new Error("invalid pane-scoped environment variable name");
    }
    if (value.includes("\0") || Buffer.byteLength(value, "utf8") > 64 * 1024) {
      throw new Error(`invalid pane-scoped environment value for ${name}`);
    }
    return ["-e", `${name}=${value}`];
  });
}

export const _tmuxEnvironmentArgsForTest = tmuxEnvironmentArgs;

/**
 * Create a detached window running `command` (a shell string) with cwd.
 * Returns a stable tmux target (session:window_id, e.g. "cc:@3") —
 * window IDs don't shift when other windows close, unlike indexes.
 */
export function newWindow(
  name: string,
  cwd: string,
  command: string,
  environment?: Record<string, string>,
): string {
  ensureSession();
  const target = tmux(
    "new-window",
    "-d",
    ...tmuxEnvironmentArgs(environment),
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

/**
 * The shell running in a window's pane, or null when there isn't a live one.
 *
 * Two ways this returns null rather than a pid, both of which would otherwise
 * hand a process-killing caller the wrong process:
 *
 *  - `display-message` does NOT fail on a target that no longer exists. It
 *    quietly evaluates the format against the session's *current* window
 *    instead, which for a vanished agent window means the pid of some other
 *    agent's pane. So the resolved window id is read back and must match.
 *  - a window kept alive by `remain-on-exit` still reports the pid of the
 *    process that already exited, and that pid may since have been reused.
 */
export function paneProcess(target: string): PaneProcess | null {
  let out: string;
  try {
    out = tmux(
      "display-message",
      "-p",
      "-t",
      target,
      "#{session_name}:#{window_id}\t#{pane_dead}\t#{pane_pid}\t#{pane_tty}",
    ).trim();
  } catch {
    return null;
  }
  const [resolved, dead, pid, tty] = out.split("\t");
  if (resolved !== target) return null;
  if (dead !== "0") return null;
  const panePid = Number(pid);
  if (!Number.isInteger(panePid) || panePid <= 1) return null;
  return { pid: panePid, tty: normalizeTty(tty ?? "") };
}

/**
 * Tear a window down, processes first.
 *
 * `kill-window` on its own leaves anything the pane backgrounded into another
 * process group running and orphaned (see proctree.ts), so the pane's whole
 * process tree is signalled while it is still walkable, and only then does the
 * window go away. Returns the pids that were signalled.
 */
export function killWindow(target: string): number[] {
  const pane = paneProcess(target);
  const killed = pane ? terminatePaneTree(pane) : [];
  tmux("kill-window", "-t", target);
  return killed;
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
  return tmuxFailureCode(error) === "session_absent";
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
 *
 * `beforeSubmit` runs in that gap, once the text is in the pane but before it
 * is submitted, and returning false leaves it sitting there unsent. That is the
 * last checkpoint at which an injected message can still be stopped from
 * merging into something a human typed in the meantime. Resolves true when the
 * text was submitted, false when it was typed but deliberately not submitted.
 */
export async function sendText(
  target: string,
  text: string,
  opts: { beforeSubmit?: () => boolean } = {},
): Promise<boolean> {
  await runTmuxCommand(["send-keys", "-t", target, "-l", text]);
  await new Promise((r) => setTimeout(r, 300));
  if (opts.beforeSubmit && !opts.beforeSubmit()) return false;
  await runTmuxCommand(["send-keys", "-t", target, "Enter"]);
  return true;
}

/**
 * Capture the visible pane content (for `agp peek`).
 *
 * Pass `{ escapes: true }` to keep tmux's ANSI escape sequences (`capture-pane
 * -e`). The structured pane parser needs them: Claude Code renders its
 * ghost-text prompt suggestions dim (SGR 2) while real typed input is
 * default-styled, and that styling is the only reliable way to tell them
 * apart. Plain callers (the raw peek view) leave escapes off so the output
 * stays human-readable.
 */
export function capturePane(
  target: string,
  lines = 50,
  opts: { escapes?: boolean } = {},
): string {
  const args = ["capture-pane", "-p"];
  if (opts.escapes) args.push("-e");
  args.push("-t", target, "-S", `-${lines}`);
  const out = tmux(...args);
  return out.replace(/\n+$/, "");
}

/** Press Enter without typing anything — submits whatever's already sitting
 *  in the input line, instead of retyping it. */
export async function sendEnter(target: string): Promise<void> {
  await runTmuxCommand(["send-keys", "-t", target, "Enter"]);
}

/** Ctrl-U: clear the input line back to the prompt without submitting it. */
export async function clearInputLine(target: string): Promise<void> {
  await runTmuxCommand(["send-keys", "-t", target, "C-u"]);
}
