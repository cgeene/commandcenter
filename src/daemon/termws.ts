import { execFile } from "node:child_process";
import crypto from "node:crypto";
import pty from "node-pty";
import type { WebSocket } from "ws";
import { getAgent } from "../db/agents.js";
import { localeEnv } from "./locale.js";
import { windowExists } from "./tmux.js";

function tmux(...args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("tmux", args, { env: localeEnv() }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
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
  const viewer = `ccv-${agentId}-${crypto.randomBytes(3).toString("hex")}`;

  try {
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
  } catch (err) {
    ws.send(`\r\n[commandcenter] failed to create viewer session: ${err}\r\n`);
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
      cols: size?.cols ?? 120,
      rows: size?.rows ?? 32,
      env: localeEnv(),
    });
  } catch (err) {
    // e.g. node-pty spawn-helper missing exec bit — never crash the daemon
    tmux("kill-session", "-t", viewer).catch(() => {});
    ws.send(`\r\n[commandcenter] pty spawn failed: ${err}\r\n`);
    ws.close();
    return;
  }

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    try {
      term.kill();
    } catch {
      /* already gone */
    }
    tmux("kill-session", "-t", viewer).catch(() => {});
    if (ws.readyState === ws.OPEN) ws.close();
  };

  term.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });
  term.onExit(cleanup);

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as {
        t: string;
        d?: string;
        cols?: number;
        rows?: number;
      };
      if (msg.t === "i" && typeof msg.d === "string") {
        term.write(msg.d);
      } else if (msg.t === "r" && msg.cols && msg.rows) {
        term.resize(msg.cols, msg.rows);
      }
    } catch {
      /* ignore malformed frames */
    }
  });
  ws.on("close", cleanup);
  ws.on("error", cleanup);
}
