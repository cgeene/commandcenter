import { execFile } from "node:child_process";
import crypto from "node:crypto";
import pty from "node-pty";
import type { WebSocket } from "ws";
import { getAgent } from "../db/agents.js";
import { windowExists } from "./tmux.js";

function tmux(...args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("tmux", args, (err) => (err ? reject(err) : resolve()));
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
    await tmux("select-window", "-t", `${viewer}:${windowId}`);
  } catch (err) {
    ws.send(`\r\n[commandcenter] failed to create viewer session: ${err}\r\n`);
    ws.close();
    return;
  }

  let term: pty.IPty;
  try {
    term = pty.spawn("tmux", ["attach", "-t", viewer], {
      name: "xterm-256color",
      cols: 200,
      rows: 50,
      env: process.env as Record<string, string>,
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
