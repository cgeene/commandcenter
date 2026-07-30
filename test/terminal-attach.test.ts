import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { TERM_CLOSE_PERMANENT } from "../src/lib/terminal-reconnect.js";

// attachTerminal decides whether to close the operator's terminal, and whether
// that close is one the browser should retry. The tmux module is stubbed so each
// of the three presence answers ("present", "absent", and the "unknown" a loaded
// box produces) can be driven directly, from either query. Whether those queries
// block the event loop is NOT observable here — see test/tmux-timeout.test.ts,
// which drives this path against a real hanging tmux.

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
  windowPresenceAsync: async (target: string) => windowPresence(target),
  probeWindowAsync: async (target: string) => probeWindow(target),
}));

const events: { kind: string; agentId?: number }[] = [];
vi.mock("../src/db/events.js", () => ({
  logEvent: (kind: string, opts?: { agentId?: number }) =>
    events.push({ kind, agentId: opts?.agentId }),
}));

let tmuxTarget: string | null = "cc:@5";
let agentState = "working";
let agentExists = true;
vi.mock("../src/db/agents.js", () => ({
  getAgent: () =>
    agentExists ? { id: 7, state: agentState, tmux_target: tmuxTarget } : undefined,
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
  agentState = "working";
  agentExists = true;
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

  it("does not believe a single query that says the window is gone", async () => {
    // Absence has to be corroborated: the probe decides it by string-comparing
    // display-message output, and a listing that came back short is exactly what
    // listWindows refuses to trust. Neither is evidence on its own, so this
    // attaches rather than reporting the terminal gone.
    const { attachTerminal } = await import("../src/daemon/termws.js");
    windowPresence.mockReturnValue("unknown");
    probeWindow.mockReturnValue("absent");
    const ws = new FakeWs();

    await attachTerminal(ws.asWs(), 7);

    expect(ws.closes).toEqual([]);
    expect(ptySpawn).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      { kind: "terminal.presence_unobservable", agentId: 7 },
    ]);

    ws.emit("close");
  });

  it("closes retryably when both queries agree the window is gone", async () => {
    // The agent is still live, so this clears on its own: respawn and resume
    // both re-attach a pane. A permanent close here would leave the operator
    // reloading the page.
    const { attachTerminal } = await import("../src/daemon/termws.js");
    windowPresence.mockReturnValue("absent");
    probeWindow.mockReturnValue("absent");
    const ws = new FakeWs();

    await attachTerminal(ws.asWs(), 7);

    expect(ws.closes).toEqual([{ code: undefined, reason: undefined }]);
    expect(ws.sent).toEqual([
      "\r\n[commandcenter] no live tmux window for this agent\r\n",
    ]);
    expect(ptySpawn).not.toHaveBeenCalled();
    expect(events).toEqual([{ kind: "terminal.window_absent", agentId: 7 }]);
  });

  it("closes retryably for an agent whose pane has not been created yet", async () => {
    // spawn/respawn/resume all write tmux_target only once the pane exists, so
    // a drawer opened in that window has to reconnect into the terminal itself.
    const { attachTerminal } = await import("../src/daemon/termws.js");
    tmuxTarget = null;
    agentState = "spawning";
    const ws = new FakeWs();

    await attachTerminal(ws.asWs(), 7);

    expect(ws.closes).toEqual([{ code: undefined, reason: undefined }]);
    expect(windowPresence).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it.each([
    ["the agent row is gone", () => (agentExists = false)],
    ["the agent is dead", () => (agentState = "dead")],
  ])("closes permanently when %s", async (_why, arrange) => {
    const { attachTerminal } = await import("../src/daemon/termws.js");
    arrange();
    const ws = new FakeWs();

    await attachTerminal(ws.asWs(), 7);

    expect(ws.closes).toEqual([
      { code: TERM_CLOSE_PERMANENT, reason: "this agent is no longer running" },
    ]);
    expect(windowPresence).not.toHaveBeenCalled();
    expect(events).toEqual([{ kind: "terminal.agent_gone", agentId: 7 }]);
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
