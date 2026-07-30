import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { TERM_CLOSE_PERMANENT } from "../src/lib/terminal-reconnect.js";

// attachTerminal decides whether to close the operator's terminal. The tmux
// module is stubbed so each of the three presence answers ("present",
// "absent", and the "unknown" a loaded box produces) can be driven directly.

type Presence = "present" | "absent" | "unknown";

const windowPresence = vi.fn<(target: string) => Presence>(() => "present");
const probeWindow = vi.fn<(target: string) => Presence>(() => "present");
/** tmux sessions the fake server reports to list-sessions. */
let sessions: string[] = [];
let tmuxCalls: string[][] = [];

vi.mock("../src/daemon/tmux.js", () => ({
  runTmuxCommand: async (args: string[]) => {
    tmuxCalls.push(args);
    if (args[0] !== "list-sessions") return "";
    return args.includes("#{session_name}:#{session_attached}")
      ? sessions.map((name) => `${name}:1`).join("\n")
      : sessions.join("\n");
  },
  windowPresence: (target: string) => windowPresence(target),
  probeWindow: (target: string) => probeWindow(target),
  windowExists: () => true,
}));

const events: { kind: string; agentId?: number }[] = [];
vi.mock("../src/db/events.js", () => ({
  logEvent: (kind: string, opts?: { agentId?: number }) =>
    events.push({ kind, agentId: opts?.agentId }),
}));

let tmuxTarget: string | null = "cc:@5";
vi.mock("../src/db/agents.js", () => ({
  getAgent: () => (tmuxTarget === null ? undefined : { id: 7, tmux_target: tmuxTarget }),
}));

const ptySpawn = vi.fn(() => fakePty());

vi.mock("node-pty", () => ({
  default: { spawn: (...args: unknown[]) => ptySpawn(...(args as [])) },
}));

function fakePty() {
  return {
    onData: (_cb: (d: string) => void) => {},
    onExit: (_cb: () => void) => {},
    write: () => {},
    resize: () => {},
    kill: () => {},
  };
}

/** The subset of the ws API attachTerminal touches, plus a record of it. */
class FakeWs extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  closes: { code?: number; reason?: string }[] = [];
  send(data: string, cb?: (err?: Error) => void): void {
    this.sent.push(data);
    cb?.();
  }
  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.readyState = 3;
  }
  terminate(): void {
    this.readyState = 3;
  }
  ping(): void {}
  asWs(): WebSocket {
    return this as unknown as WebSocket;
  }
}

/** The viewer session name attachTerminal generated, read off the new-session call. */
function createdViewer(): string {
  const call = tmuxCalls.find((args) => args[0] === "new-session");
  if (!call) throw new Error("no viewer session was created");
  return call[call.indexOf("-s") + 1];
}

function killedSessions(): string[] {
  return tmuxCalls
    .filter((args) => args[0] === "kill-session")
    .map((args) => args[args.indexOf("-t") + 1]);
}

beforeEach(() => {
  vi.clearAllMocks();
  windowPresence.mockReturnValue("present");
  probeWindow.mockReturnValue("present");
  ptySpawn.mockImplementation(() => fakePty());
  tmuxTarget = "cc:@5";
  sessions = [];
  tmuxCalls = [];
  events.length = 0;
});

describe("attachTerminal presence check", () => {
  it("attaches anyway when tmux cannot be asked at all", async () => {
    // The regression: a list-windows that times out on a loaded box used to
    // read as "the window is gone" and close a healthy terminal, which the
    // browser answered by reconnecting — forever.
    const { attachTerminal } = await import("../src/daemon/termws.js");
    windowPresence.mockReturnValue("unknown");
    probeWindow.mockReturnValue("unknown");
    const ws = new FakeWs();

    await attachTerminal(ws.asWs(), 7, { cols: 80, rows: 24 });

    expect(ws.closes).toEqual([]);
    expect(ws.sent).toEqual([]);
    expect(ptySpawn).toHaveBeenCalledTimes(1);
    // Re-asked rather than believed the first failure, and corroborated each
    // time with the other tmux command.
    expect(windowPresence).toHaveBeenCalledTimes(3);
    expect(probeWindow).toHaveBeenCalledTimes(3);
    // Attaching blind is rare enough to be worth a trace.
    expect(events).toEqual([
      { kind: "terminal.presence_unobservable", agentId: 7 },
    ]);

    ws.emit("close");
  });

  it("attaches when a retry gets an answer", async () => {
    const { attachTerminal } = await import("../src/daemon/termws.js");
    windowPresence
      .mockReturnValueOnce("unknown")
      .mockReturnValueOnce("present");
    probeWindow.mockReturnValue("unknown");
    const ws = new FakeWs();

    await attachTerminal(ws.asWs(), 7);

    expect(ws.closes).toEqual([]);
    expect(ptySpawn).toHaveBeenCalledTimes(1);
    expect(windowPresence).toHaveBeenCalledTimes(2);

    ws.emit("close");
  });

  it("closes once, permanently, when the window is genuinely gone", async () => {
    const { attachTerminal } = await import("../src/daemon/termws.js");
    windowPresence.mockReturnValue("absent");
    const ws = new FakeWs();

    await attachTerminal(ws.asWs(), 7);

    expect(ws.closes).toEqual([
      { code: TERM_CLOSE_PERMANENT, reason: "no live tmux window for this agent" },
    ]);
    expect(ws.sent).toEqual([
      "\r\n[commandcenter] no live tmux window for this agent\r\n",
    ]);
    expect(ptySpawn).not.toHaveBeenCalled();
    expect(events).toEqual([{ kind: "terminal.window_absent", agentId: 7 }]);
  });

  it("closes permanently for an agent that has no window at all", async () => {
    const { attachTerminal } = await import("../src/daemon/termws.js");
    tmuxTarget = null;
    const ws = new FakeWs();

    await attachTerminal(ws.asWs(), 7);

    expect(ws.closes.map((c) => c.code)).toEqual([TERM_CLOSE_PERMANENT]);
    expect(windowPresence).not.toHaveBeenCalled();
  });

  it("believes the single-target probe when the bulk listing is unobservable", async () => {
    const { attachTerminal } = await import("../src/daemon/termws.js");
    windowPresence.mockReturnValue("unknown");
    probeWindow.mockReturnValue("absent");
    const ws = new FakeWs();

    await attachTerminal(ws.asWs(), 7);

    expect(ws.closes.map((c) => c.code)).toEqual([TERM_CLOSE_PERMANENT]);
    expect(probeWindow).toHaveBeenCalledTimes(1);
    expect(ptySpawn).not.toHaveBeenCalled();
  });
});

describe("viewer pruning on attach", () => {
  it("leaves alone a viewer session another open socket is using", async () => {
    const { attachTerminal } = await import("../src/daemon/termws.js");
    const first = new FakeWs();
    await attachTerminal(first.asWs(), 7);
    const firstViewer = createdViewer();
    sessions = [firstViewer];
    tmuxCalls = [];

    // A second drawer on the same agent. Killing the first viewer here would
    // kill its PTY, close its socket, and start a mutual-eviction loop.
    const second = new FakeWs();
    await attachTerminal(second.asWs(), 7);

    expect(killedSessions()).not.toContain(firstViewer);
    expect(first.closes).toEqual([]);

    first.emit("close");
    second.emit("close");
    // Cleanup still reaps its own viewer, so nothing leaks.
    expect(killedSessions()).toContain(firstViewer);
  });

  it("still prunes a viewer left behind by a socket that is gone", async () => {
    const { attachTerminal } = await import("../src/daemon/termws.js");
    sessions = ["ccv-7-old001"];
    const ws = new FakeWs();

    await attachTerminal(ws.asWs(), 7);

    expect(killedSessions()).toContain("ccv-7-old001");
    ws.emit("close");
  });
});
