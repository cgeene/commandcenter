import crypto from "node:crypto";
import pty from "node-pty";
import type { WebSocket } from "ws";
import { getAgent } from "../db/agents.js";
import { logEvent } from "../db/events.js";
import { TERM_CLOSE_PERMANENT } from "../lib/terminal-reconnect.js";
import { localeEnv } from "./locale.js";
import {
  probeWindow,
  runTmuxCommand,
  windowPresence,
  type WindowPresence,
} from "./tmux.js";

function tmux(...args: string[]): Promise<void> {
  return runTmuxCommand(args).then(() => undefined);
}

function tmuxOutput(...args: string[]): Promise<string> {
  return runTmuxCommand(args);
}

function viewerPrefix(agentId: number): string {
  return `ccv-${agentId}-`;
}

/** Matches every generation of viewer session name (`ccv-<agentId>-<hash>`). */
const VIEWER_SESSION_RE = /^ccv-\d+-/;

/** Unattached viewer sessions older than this are presumed leaked. */
const STALE_VIEWER_MS = 60 * 60_000;

async function killSession(name: string): Promise<void> {
  await tmux("kill-session", "-t", name);
}

/**
 * Viewer sessions this daemon still holds an open socket on.
 *
 * The prune below must not kill one of these: two drawers on the same agent (a
 * laptop and a phone, say) would evict each other's session, each eviction
 * killing a PTY, closing a socket and provoking a reconnect that evicts the
 * other again — a reconnect loop with no bottom. A socket whose client vanished
 * without a close event is reclaimed by the heartbeat, by destroy-unattached,
 * and by the stale-viewer sweep, so nothing depends on the prune for that.
 */
const liveViewers = new Set<string>();

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
      .filter((name) => name.startsWith(prefix) && !liveViewers.has(name))
      .map((name) => killSession(name).catch(() => {})),
  );
}

/**
 * Create the grouped tmux session a single browser viewer attaches to, and
 * point it at the agent's window.
 */
export async function createViewerSession(
  viewer: string,
  session: string,
  windowId: string,
): Promise<void> {
  // destroy-unattached must NOT be set here — see armViewerSelfDestruct.
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
}

const ARM_POLL_MS = 200;
const ARM_TIMEOUT_MS = 15_000;

/**
 * Flag the viewer session destroy-unattached once its client is actually
 * attached, so tmux reaps it the moment that client detaches — covering
 * disconnects the daemon never observes (killed browser tab behind a sleeping
 * websocket proxy, daemon crash, failed kill-session).
 *
 * The option must not be set a moment earlier: tmux (observed on 3.7b) reaps
 * every option-flagged unattached session whenever ANY client disconnects
 * from the server — including one-shot command clients like the watchdog's
 * capture-pane — so arming before the attach completes can destroy the
 * session under its own attaching client. Hence the poll for an observed
 * attach. Scoped to THIS viewer session only — destroy-unattached on the
 * primary session would tear down every agent window whenever no client is
 * attached, which for a headless fleet is the normal state.
 *
 * Resolves true once armed; false when the viewer disappeared first (already
 * cleaned up) or never attached within the timeout — those leaks are bounded
 * by the disconnect cleanup and the stale-viewer sweep.
 */
export async function armViewerSelfDestruct(viewer: string): Promise<boolean> {
  const deadline = Date.now() + ARM_TIMEOUT_MS;
  for (;;) {
    let out: string;
    try {
      // Colon-separated: session names cannot contain colons, and tmux
      // downgrades a literal tab in format output to `_` under a non-UTF-8
      // client locale, which would silently break this parse.
      out = await tmuxOutput(
        "list-sessions",
        "-F",
        "#{session_name}:#{session_attached}",
      );
    } catch {
      return false; // no tmux server — nothing left to arm
    }
    const row = out
      .split("\n")
      .map((line) => line.split(":"))
      .find(([name]) => name === viewer);
    if (!row) return false;
    if (row[1] !== "0") {
      try {
        await tmux("set-option", "-t", viewer, "destroy-unattached", "on");
        return true;
      } catch {
        return false;
      }
    }
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, ARM_POLL_MS));
  }
}

/**
 * Kill unattached `ccv-*` viewer sessions older than an hour. New viewers are
 * self-cleaning via destroy-unattached (above); this sweep catches sessions
 * left behind by a daemon that predates the option, and ones orphaned between
 * new-session and the PTY attach. The hour of grace guarantees a viewer that
 * is still mid-attach is never swept out from under its client.
 */
export async function sweepStaleViewerSessions(
  nowMs = Date.now(),
): Promise<string[]> {
  let out = "";
  try {
    // Colon-separated for the same reason as in armViewerSelfDestruct.
    out = await tmuxOutput(
      "list-sessions",
      "-F",
      "#{session_name}:#{session_attached}:#{session_created}",
    );
  } catch {
    return []; // no tmux server, or unobservable — nothing to sweep
  }
  const stale = out
    .split("\n")
    .map((line) => line.split(":"))
    .filter(([name, attached, created]) => {
      if (!name || !VIEWER_SESSION_RE.test(name)) return false;
      if (attached !== "0") return false;
      const createdMs = Number(created) * 1000;
      return Number.isFinite(createdMs) && nowMs - createdMs >= STALE_VIEWER_MS;
    })
    .map(([name]) => name);
  await Promise.all(stale.map((name) => killSession(name).catch(() => {})));
  return stale;
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

/** Presence re-asks before an unobservable tmux is attached to on faith. */
const PRESENCE_ATTEMPTS = 3;
const PRESENCE_RETRY_MS = 150;

/**
 * Whether the agent's window is really gone — asked the way an interactive
 * attach has to ask it.
 *
 * windowExists() answers an unobservable tmux with "absent" by default, which
 * is right for optional work that can be skipped and retried on a later pass.
 * It is wrong here: the only thing this decides is whether to close the
 * operator's terminal, a close the browser answers by reconnecting, so reading
 * "I could not ask" as "gone" turns one failed tmux query on a loaded box into
 * a permanent disconnect/reconnect cycle. So this insists on a definite answer:
 * re-ask a few times, corroborate with a different tmux command (one target at
 * a time, so a bulk listing that cannot be believed does not supply its own
 * second opinion), and report "unknown" rather than guess. An "unknown" caller
 * should attach anyway and let the attach itself fail if the window is gone.
 */
async function attachPresence(target: string): Promise<WindowPresence> {
  for (let attempt = 1; ; attempt++) {
    const presence = windowPresence(target);
    if (presence !== "unknown") return presence;
    const probed = probeWindow(target);
    if (probed !== "unknown") return probed;
    if (attempt >= PRESENCE_ATTEMPTS) return "unknown";
    await new Promise((r) => setTimeout(r, PRESENCE_RETRY_MS));
  }
}

/**
 * Close with the reason, and tell the client not to come back: reconnecting
 * cannot fix this one (see src/lib/terminal-reconnect.ts).
 */
function closePermanently(ws: WebSocket, reason: string): void {
  try {
    ws.send(`\r\n[commandcenter] ${reason}\r\n`);
  } catch {
    /* socket already gone; the close below is still worth attempting */
  }
  try {
    ws.close(TERM_CLOSE_PERMANENT, reason);
  } catch {
    /* already closing */
  }
}

/**
 * Bridge a browser xterm.js to an agent's tmux window.
 *
 * Each viewer gets its own *grouped* tmux session (new-session -t) attached
 * via a PTY: grouped sessions share windows but keep an independent current
 * window and size, so watching one agent doesn't yank other viewers (or the
 * desktop tmux client) around. The viewer session is killed on disconnect,
 * with `destroy-unattached on` as the backstop for disconnects the daemon
 * never sees.
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
  if (!agent?.tmux_target) {
    closePermanently(ws, "no live tmux window for this agent");
    return;
  }
  // Only a definite "absent" closes. An unobservable tmux attaches anyway: if
  // the window really is gone the attach below fails on its own, honestly and
  // transiently, instead of this closing a healthy terminal on no evidence.
  const presence = await attachPresence(agent.tmux_target);
  if (presence === "absent") {
    logEvent("terminal.window_absent", { agentId });
    closePermanently(ws, "no live tmux window for this agent");
    return;
  }
  if (presence === "unknown") {
    // Rare and worth seeing: it means tmux could not answer three times in a
    // row, which is the state that used to close terminals.
    logEvent("terminal.presence_unobservable", { agentId });
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
    await createViewerSession(viewer, session, windowId);
    liveViewers.add(viewer);
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
    liveViewers.delete(viewer);
    tmux("kill-session", "-t", viewer).catch(() => {});
    ws.send("\r\n[commandcenter] terminal process failed to start\r\n");
    ws.close();
    return;
  }

  // Fire-and-forget: if arming never succeeds, the disconnect cleanup below
  // and the periodic stale-viewer sweep still bound the leak.
  void armViewerSelfDestruct(viewer);

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
    liveViewers.delete(viewer);
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
