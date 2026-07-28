import crypto from "node:crypto";
import pty from "node-pty";
import type { WebSocket } from "ws";
import { getAgent } from "../db/agents.js";
import { localeEnv } from "./locale.js";
import { runTmuxCommand, windowExists } from "./tmux.js";

function tmux(...args: string[]): Promise<void> {
  return runTmuxCommand(args).then(() => undefined);
}

function tmuxOutput(...args: string[]): Promise<string> {
  return runTmuxCommand(args);
}

function viewerPrefix(agentId: number): string {
  return `ccv-${agentId}-`;
}

async function killSession(name: string): Promise<void> {
  await tmux("kill-session", "-t", name);
}

async function pruneAgentViewers(agentId: number): Promise<void> {
  const prefix = viewerPrefix(agentId);
  let out = "";
  try {
    out = await tmuxOutput("list-sessions", "-F", "#{session_name}");
  } catch {
    return;
  }
  await Promise.all(
    out
      .split("\n")
      .map((line) => line.trim())
      .filter((name) => name.startsWith(prefix))
      .map((name) => killSession(name).catch(() => {})),
  );
}

function normalizedSize(size?: { cols: number; rows: number }): {
  cols: number;
  rows: number;
} {
  const cols = Number.isInteger(size?.cols) ? size!.cols : 120;
  const rows = Number.isInteger(size?.rows) ? size!.rows : 32;
  return {
    cols: Math.min(Math.max(cols, 20), 300),
    rows: Math.min(Math.max(rows, 5), 120),
  };
}

/**
 * Bridge a browser xterm.js to an agent's tmux window.
 *
 * Each viewer gets its own *grouped* tmux session (new-session -t) attached
 * via a PTY: grouped sessions share windows but keep an independent current
 * window and size, so watching one agent doesn't yank other viewers (or the
 * desktop tmux client) around. The viewer session is killed on disconnect.
 *
 * Client protocol: {"t":"i","d":"<keys>"} input, {"t":"r","cols":N,"rows":N}
 * resize. Server sends raw terminal output as text frames.
 */
export async function attachTerminal(
  ws: WebSocket,
  agentId: number,
  size?: { cols: number; rows: number },
): Promise<void> {
  const agent = getAgent(agentId);
  if (!agent?.tmux_target || !windowExists(agent.tmux_target)) {
    ws.send("\r\n[commandcenter] no live tmux window for this agent\r\n");
    ws.close();
    return;
  }

  const [session, windowId] = agent.tmux_target.split(":");
  const viewer = `${viewerPrefix(agentId)}${crypto.randomBytes(3).toString("hex")}`;
  const initialSize = normalizedSize(size);

  try {
    // Opening the same agent's terminal again must not accumulate old grouped
    // tmux sessions. A browser tab can sleep or a websocket proxy can disappear
    // without delivering a close event; pruning by agent keeps the latest drawer
    // authoritative and bounds tmux/PTY handles.
    await pruneAgentViewers(agentId);
    await tmux("new-session", "-d", "-t", session, "-s", viewer);
    // No tmux chrome in the browser: xterm.js renders only the pane.
    await tmux("set-option", "-t", viewer, "status", "off");
    // Mouse mode: wheel/touch scroll enters tmux copy-mode (scrollback lives
    // in tmux, not xterm.js — swiping back down to the bottom exits it).
    await tmux("set-option", "-t", viewer, "mouse", "on");
    await tmux("select-window", "-t", `${viewer}:${windowId}`);
    // Size the shared window to whichever client used it last (i.e. the
    // browser), instead of clamping to the smallest attached client.
    await tmux(
      "set-option",
      "-w",
      "-t",
      `${viewer}:${windowId}`,
      "window-size",
      "latest",
    );
  } catch {
    ws.send("\r\n[commandcenter] failed to create viewer session\r\n");
    ws.close();
    return;
  }

  let term: pty.IPty;
  try {
    // Start the PTY at the browser's real dimensions so the first paint is
    // already correct — a wrong initial size leaves redraw artifacts.
    // `-u` + a UTF-8 locale keep tmux from downgrading ⏺ ❯ ✻ to `_` when the
    // daemon's own environment lacks LANG/LC_* (e.g. under launchd).
    term = pty.spawn("tmux", ["-u", "attach", "-t", viewer], {
      name: "xterm-256color",
      cols: initialSize.cols,
      rows: initialSize.rows,
      env: localeEnv(),
    });
  } catch {
    // e.g. node-pty spawn-helper missing exec bit — never crash the daemon
    tmux("kill-session", "-t", viewer).catch(() => {});
    ws.send("\r\n[commandcenter] terminal process failed to start\r\n");
    ws.close();
    return;
  }

  let closed = false;
  let alive = true;
  const heartbeat = setInterval(() => {
    if (closed) return;
    if (ws.readyState !== ws.OPEN || !alive) {
      cleanup(true);
      return;
    }
    alive = false;
    try {
      ws.ping();
    } catch {
      cleanup(true);
    }
  }, 15_000);

  const cleanupGracefully = () => cleanup(false);

  function cleanup(forceSocketClose: boolean): void {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    killSession(viewer).catch(() => {});
    try {
      term.kill();
    } catch {
      /* already gone */
    }
    if (forceSocketClose) {
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
    } else if (ws.readyState === ws.OPEN) {
      ws.close();
    }
  }

  function sendOutput(data: string): void {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(data, (err) => {
        if (err) cleanup(true);
      });
    } catch {
      cleanup(true);
    }
  }

  function writeInput(data: string): void {
    if (closed) return;
    try {
      term.write(data);
    } catch {
      cleanup(true);
    }
  }

  function resizeTerminal(cols: number, rows: number): void {
    if (closed) return;
    try {
      term.resize(cols, rows);
    } catch {
      cleanup(true);
    }
  }

  term.onData(sendOutput);
  term.onExit(cleanupGracefully);
  ws.on("pong", () => {
    alive = true;
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as {
        t: string;
        d?: string;
        cols?: number;
        rows?: number;
      };
      if (msg.t === "i" && typeof msg.d === "string") {
        writeInput(msg.d);
      } else if (msg.t === "r" && msg.cols && msg.rows) {
        const next = normalizedSize({ cols: msg.cols, rows: msg.rows });
        resizeTerminal(next.cols, next.rows);
      }
    } catch {
      /* ignore malformed frames */
    }
  });
  ws.on("close", cleanupGracefully);
  ws.on("error", () => cleanup(true));
}
