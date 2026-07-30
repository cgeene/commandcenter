import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WebSocket } from "ws";

vi.setConfig({ testTimeout: 30_000 });

let tmpDir: string;
let originalPath: string | undefined;

// Default bound for these tests. Generous on purpose: the cases that are NOT
// about hanging drive a real /bin/sh fake through to completion, and a loaded
// box can take most of a second just to spawn it. A tight default here made
// "sanitises stale-target send failures" report a timeout instead of the error
// it was asserting on.
const TMUX_TIMEOUT_MS = 15_000;

// Bound for the deliberately-hung cases, via armHang().
//
// THE RULE, because getting it wrong produces a load flake that looks like a
// real failure: this short bound is only valid when the FIRST tmux invocation on
// the path under test is the one that hangs. Then the fake execs `sleep 60`,
// never returns, and there is nothing to race — the only question is whether the
// bound fires, and the elapsed assertions use the wide BOUNDED_MS ceiling below.
//
// If any tmux call has to SUCCEED before the hanging one, that call must beat the
// bound too, and on a loaded box spawning /bin/sh can take most of a second. Such
// cases pass MIXED_PATH_HANG_MS instead. `hang-enter` is exactly that shape:
// sendText issues `send-keys -l` first and only hangs on the following `Enter`,
// so a short bound can time out on the literal and the test then fails asserting
// which calls were made. (`hang-capture` is NOT that shape — capturePane is the
// only tmux call on the peek path.)
const HANG_TIMEOUT_MS = 500;

// For paths where something must complete before the hang, and for the /healthz
// ordering test, which needs the hung send to still be outstanding while health
// is served. The wider bound is the whole cost of these cases.
const MIXED_PATH_HANG_MS = 3_000;

// What a bounded call must beat. The fake tmux below hangs for 60s, so any
// return comfortably under that proves the timeout fired — while staying wide
// enough that a loaded box cannot fail it on scheduling jitter alone. Asserting
// a tight multiple of TMUX_TIMEOUT_MS instead would be a wall-clock race, which
// is the class of flake this suite is trying to be rid of.
const BOUNDED_MS = 20_000;

const fakeTmux = `#!/bin/sh
mode="\${CC_FAKE_TMUX_MODE:-ok}"

if [ "$mode" = "hang-all" ]; then
  exec sleep 60
fi

# Observation never answers, but session management and the client attach both
# work — so one terminal can be streaming while another is still deciding
# whether its window exists.
if [ "$mode" = "hang-observe" ]; then
  case " $* " in
    *" attach "*)
      while :; do printf 'tick\\r\\n'; sleep 1; done ;;
  esac
  if [ "$1" = "list-windows" ] || [ "$1" = "display-message" ]; then
    exec sleep 60
  fi
  exit 0
fi

if [ "$mode" = "missing-socket" ] && [ "$1" = "has-session" ]; then
  printf 'error connecting to /private/tmp/tmux-501/default (No such file or directory)\\n' >&2
  exit 1
fi

if [ "$1" = "new-session" ]; then
  printf 'new-session\\n' >> "$CC_FAKE_TMUX_LOG"
  exit 0
fi

# Server-level failures: every command except new-session fails, which is what
# a stale or unreachable socket really looks like (new-session replaces it).
if [ "$mode" = "no-server" ]; then
  printf 'no server running on /private/tmp/tmux-501/default\\n' >&2
  exit 1
fi
if [ "$mode" = "connection-refused" ]; then
  printf 'error connecting to /private/tmp/tmux-501/default (Connection refused)\\n' >&2
  exit 1
fi
if [ "$mode" = "connect-failed" ]; then
  printf 'failed to connect to server\\n' >&2
  exit 1
fi

if [ "$1" = "list-windows" ]; then
  if [ "$mode" = "garbled-windows" ]; then
    # What a non-UTF-8 client does to a separator, or a half-written read: the
    # line is there but the fields cannot be told apart.
    printf 'cc:@1_0\\ncc:@2_0\\n'
    exit 0
  fi
  if [ "$mode" = "dead-window" ]; then
    printf 'cc:@1:0\\nmy session:@2:1\\n'
    exit 0
  fi
  printf 'cc:@1:0\\n'
  exit 0
fi

if [ "$1" = "capture-pane" ]; then
  if [ "$mode" = "hang-capture" ]; then
    exec sleep 60
  fi
  printf 'worker pane\\n'
  exit 0
fi

if [ "$1" = "send-keys" ]; then
  printf '%s\\n' "$4" >> "$CC_FAKE_TMUX_LOG"
  if [ "$mode" = "hang-literal" ] && [ "$4" = "-l" ]; then
    exec sleep 60
  fi
  if [ "$mode" = "hang-enter" ] && [ "$4" = "Enter" ]; then
    exec sleep 60
  fi
  if [ "$mode" = "stale-target" ]; then
    printf "can't find pane\\n" >&2
    exit 1
  fi
  if [ "$mode" = "no-client" ]; then
    printf 'no current client\\n' >&2
    exit 1
  fi
fi

exit 0
`;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-tmux-timeout-"));
  const binDir = path.join(tmpDir, "bin");
  fs.mkdirSync(binDir);
  const command = path.join(binDir, "tmux");
  fs.writeFileSync(command, fakeTmux, { mode: 0o755 });
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  process.env.CC_FAKE_TMUX_LOG = path.join(tmpDir, "calls.log");
  process.env.CC_DATA_DIR = path.join(tmpDir, "data");
  const { _setTmuxTimeoutForTest } = await import("../src/daemon/tmux.js");
  _setTmuxTimeoutForTest(TMUX_TIMEOUT_MS);
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  const { _setTmuxTimeoutForTest } = await import("../src/daemon/tmux.js");
  closeDb();
  _setTmuxTimeoutForTest();
  process.env.PATH = originalPath;
  delete process.env.CC_FAKE_TMUX_MODE;
  delete process.env.CC_FAKE_TMUX_LOG;
  delete process.env.CC_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  await new Promise((resolve) => setImmediate(resolve));
});

/** Arm a fake-tmux mode that never returns, bounded tightly. */
async function armHang(mode: string, boundMs = HANG_TIMEOUT_MS): Promise<void> {
  process.env.CC_FAKE_TMUX_MODE = mode;
  const { _setTmuxTimeoutForTest } = await import("../src/daemon/tmux.js");
  _setTmuxTimeoutForTest(boundMs);
}

/** The slice of the ws API attachTerminal uses, with what it did recorded. */
class StubSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  data: string[] = [];
  closed = 0;
  terminated = 0;
  send(data: string, cb?: (err?: Error) => void): void {
    this.data.push(data);
    cb?.();
  }
  close(): void {
    this.closed++;
    this.readyState = 3;
  }
  terminate(): void {
    this.terminated++;
    this.readyState = 3;
  }
  ping(): void {}
  asWs(): WebSocket {
    return this as unknown as WebSocket;
  }
}

async function until(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return cond();
}

function calls(): string[] {
  const log = process.env.CC_FAKE_TMUX_LOG!;
  return fs.existsSync(log)
    ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
    : [];
}

describe("bounded daemon tmux commands", () => {
  it("bounds a hung literal send", async () => {
    const { sendText } = await import("../src/daemon/tmux.js");
    await armHang("hang-literal");
    const started = Date.now();

    const failure = await sendText("cc:@1", "sensitive message").catch((error) => error);

    expect(Date.now() - started).toBeLessThan(BOUNDED_MS);
    expect(failure).toMatchObject({
      code: "timeout",
      message: "tmux send-keys timed out",
    });
    expect(String(failure)).not.toContain("sensitive message");
    expect(String(failure)).not.toContain("cc:@1");
  });

  it("bounds Enter delivery after the literal text succeeds", async () => {
    const { sendText } = await import("../src/daemon/tmux.js");
    await armHang("hang-enter", MIXED_PATH_HANG_MS);
    const started = Date.now();

    const failure = await sendText("cc:@1", "message").catch((error) => error);

    expect(Date.now() - started).toBeLessThan(BOUNDED_MS);
    expect(failure).toMatchObject({ code: "timeout" });
    expect(calls()).toEqual(["-l", "Enter"]);
  });

  it.each([
    ["stale-target", "target_missing"],
    ["no-client", "no_client"],
  ])("sanitises %s send failures", async (mode, code) => {
    const { sendText } = await import("../src/daemon/tmux.js");
    process.env.CC_FAKE_TMUX_MODE = mode;

    const failure = await sendText("cc:@1", "private input").catch((error) => error);

    expect(failure).toMatchObject({
      code,
      message: "tmux send-keys failed",
    });
    expect(JSON.stringify(failure)).not.toContain("private input");
    expect(JSON.stringify(failure)).not.toContain("cc:@1");
  });

  it("bounds synchronous scheduler observation and remains usable afterward", async () => {
    const { listWindows } = await import("../src/daemon/tmux.js");
    await armHang("hang-all");
    const started = Date.now();

    expect(listWindows()).toBeNull();

    expect(Date.now() - started).toBeLessThan(BOUNDED_MS);
    process.env.CC_FAKE_TMUX_MODE = "ok";
    const { _setTmuxTimeoutForTest } = await import("../src/daemon/tmux.js");
    _setTmuxTimeoutForTest(TMUX_TIMEOUT_MS);
    expect(listWindows()).toEqual({
      live: ["cc:@1"],
      dead: [],
      server: "running",
    });
  });

  it("trusts an empty listing only when tmux proves nothing is running", async () => {
    // "no server running" is proof. A connection that could not be made is
    // not: the socket may be stale, but it is equally a live server that could
    // not accept a client right now — under precisely the concurrent-tmux load
    // that makes the watchdog's answer matter.
    const { listWindows } = await import("../src/daemon/tmux.js");

    process.env.CC_FAKE_TMUX_MODE = "no-server";
    expect(listWindows()).toEqual({ live: [], dead: [], server: "absent" });

    process.env.CC_FAKE_TMUX_MODE = "connection-refused";
    expect(listWindows()).toBeNull();

    process.env.CC_FAKE_TMUX_MODE = "connect-failed";
    expect(listWindows()).toBeNull();
  });

  it("still recreates the session when the socket is only refusing connections", async () => {
    // ensureSession must keep clearing up a socket left behind by a server
    // that died, even though observation no longer calls that proof of death.
    const { ensureSession } = await import("../src/daemon/tmux.js");
    process.env.CC_FAKE_TMUX_MODE = "connection-refused";

    expect(() => ensureSession()).not.toThrow();
    expect(calls()).toContain("new-session");
  });

  it("does not vanish live agents when the tmux server refuses connections", async () => {
    // End to end through the real classifier and the real default deps: the
    // shape of the overnight incident, where several agents were flagged in a
    // single pass because a failed query read as an empty one.
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const { createTask, getTask, updateTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { watchdog, _resetSchedulerState } = await import(
      "../src/daemon/scheduler.js"
    );
    _resetSchedulerState();

    const made = ["cc:@1004", "cc:@1015"].map((target, i) => {
      const task = createTask({ title: `t${i}`, prompt: "x", repo: "/r" });
      const agent = createAgent({
        kind: "worker",
        state: "working",
        task_id: task.id,
        tmux_target: target,
      });
      updateTask(task.id, { status: "in_progress", agent_id: agent.id });
      return { agent, task };
    });
    process.env.CC_FAKE_TMUX_MODE = "connection-refused";

    watchdog();
    watchdog();

    for (const { agent, task } of made) {
      expect(getAgent(agent.id)?.state).toBe("working");
      expect(getTask(task.id)?.status).toBe("in_progress");
    }
    const kinds = listEvents(20).map((event) => event.kind);
    expect(kinds).not.toContain("agent.window_missing");
    expect(kinds).not.toContain("agent.vanished");
    expect(kinds).toContain("watchdog.tmux_unavailable");
  });

  it("reports a window listing it cannot parse as unobservable, not as empty", async () => {
    // The dangerous shape: tmux exits 0, so the caller would otherwise take the
    // result at face value and conclude every agent's window is gone.
    const { listWindows } = await import("../src/daemon/tmux.js");
    process.env.CC_FAKE_TMUX_MODE = "garbled-windows";

    expect(listWindows()).toBeNull();
  });

  it("separates windows whose pane process has exited", async () => {
    // A session name may contain spaces, so only the last colon separates the
    // pane-dead flag — getting that wrong would void the whole snapshot.
    const { listWindows } = await import("../src/daemon/tmux.js");
    process.env.CC_FAKE_TMUX_MODE = "dead-window";

    expect(listWindows()).toEqual({
      live: ["cc:@1"],
      dead: ["my session:@2"],
      server: "running",
    });
  });

  it("lets a caller choose what an unobservable tmux means", async () => {
    const { windowExists, windowPresence } = await import("../src/daemon/tmux.js");
    await armHang("hang-all");

    expect(windowPresence("cc:@1")).toBe("unknown");
    // Reachability callers skip and retry; teardown callers still try.
    expect(windowExists("cc:@1")).toBe(false);
    expect(windowExists("cc:@1", { whenUnobservable: "present" })).toBe(true);
  });

  it("recreates the configured session when the tmux socket is absent", async () => {
    const { ensureSession } = await import("../src/daemon/tmux.js");
    process.env.CC_FAKE_TMUX_MODE = "missing-socket";

    expect(() => ensureSession()).not.toThrow();
    expect(calls()).toContain("new-session");
  });

  it("bounds pane capture on an API path and serves health afterward", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const { createAgent } = await import("../src/db/agents.js");
    const agent = createAgent({
      kind: "worker",
      state: "working",
      tmux_target: "cc:@1",
    });
    const app = buildApp();
    await armHang("hang-capture");
    const started = Date.now();

    const peek = await app.request(`/api/agents/${agent.id}/peek`);

    expect(Date.now() - started).toBeLessThan(BOUNDED_MS);
    expect(peek.status).toBe(503);
    expect(await peek.json()).toEqual({ error: "tmux pane unavailable" });
    const health = await app.request("/healthz");
    expect(health.status).toBe(200);
  });

  it("bounds hook-path observation and serves health afterward", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const { createAgent } = await import("../src/db/agents.js");
    const agent = createAgent({
      kind: "worker",
      state: "working",
      tmux_target: "cc:@1",
    });
    const app = buildApp();
    await armHang("hang-all");
    const started = Date.now();

    const hook = await app.request(`/api/hooks/agent/${agent.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hook_event_name: "Notification",
        notification_type: "permission_prompt",
      }),
    });

    expect(Date.now() - started).toBeLessThan(BOUNDED_MS);
    expect(hook.status).toBe(200);
    const health = await app.request("/healthz");
    expect(health.status).toBe(200);
  });

  it("keeps health responsive while send_to_worker delivery is hung", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    const agent = createAgent({
      kind: "worker",
      state: "idle",
      tmux_target: "cc:@1",
    });
    const app = buildApp();
    // A WIDE bound for this case specifically. The assertion below is an
    // ordering one, and how long /healthz takes to be served is the thing under
    // test — so the hung send has to stay outstanding for far longer than a
    // loaded box could plausibly take to answer one in-process request. At the
    // 500ms armHang() default /healthz would have had ~450ms to win, which is
    // tighter than the 1500ms the previous version of this test allowed.
    await armHang("hang-literal", MIXED_PATH_HANG_MS);

    const send = app.request(`/api/agents/${agent.id}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "do not log this" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Ordering, not elapsed time: /healthz must come back while the hung send is
    // STILL outstanding. A blocked event loop would serve it only after the send
    // gave up, so losing this race is exactly the regression — and unlike a
    // millisecond bound it cannot be failed by a busy machine.
    const servedFirst = await Promise.race([
      Promise.resolve(app.request("/healthz")).then((res) => ({
        who: "health" as const,
        res,
      })),
      Promise.resolve(send).then(() => ({ who: "send" as const, res: null })),
    ]);
    expect(servedFirst.who).toBe("health");
    expect(servedFirst.res?.status).toBe(200);

    const response = await send;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "tmux message delivery failed",
    });
    expect(getAgent(agent.id)?.state).toBe("idle");
    const failure = listEvents(10).find((event) => event.kind === "agent.send_failed");
    expect(failure?.payload).toBe('{"reason":"timeout"}');
    expect(failure?.payload).not.toContain("do not log this");
    expect(failure?.payload).not.toContain("cc:@1");
  });

  it("keeps the daemon and other terminals alive while an attach waits on tmux", async () => {
    // The interactive attach asks whether the agent's window exists, and the
    // answer it retries on is a tmux that will not answer. Every one of those
    // queries has to be off the event loop: a synchronous one freezes HTTP, MCP,
    // the scheduler and every other open terminal's data pump for as long as the
    // timeouts take — and on unblocking, sockets past their heartbeat get
    // terminated, so one agent's unobservable tmux would disconnect all the
    // others. That is a bigger reconnect storm than the one being fixed.
    const { buildApp } = await import("../src/daemon/api.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { attachTerminal } = await import("../src/daemon/termws.js");
    const agent = createAgent({
      kind: "worker",
      state: "working",
      tmux_target: "cc:@1",
    });
    const app = buildApp();
    // Mixed path: new-session/set-option/select-window and the client attach all
    // have to succeed before the hung observation queries are reached.
    await armHang("hang-observe", MIXED_PATH_HANG_MS);

    const open = new StubSocket();
    const second = new StubSocket();
    try {
      await attachTerminal(open.asWs(), agent.id, { cols: 80, rows: 24 });
      expect(await until(() => open.data.length > 0, BOUNDED_MS)).toBe(true);
      const streamed = open.data.length;

      // A 50ms pulse measures whether the loop keeps turning at all. It is the
      // assertion that discriminates: an ordering race against /healthz does
      // not, because a synchronous query blocks inside the call that starts the
      // attach, i.e. before any race can be set up.
      let pulses = 0;
      const pulse = setInterval(() => pulses++, 50);
      const started = Date.now();
      let elapsed: number;
      let health: Response;
      try {
        const attaching = attachTerminal(second.asWs(), agent.id, {
          cols: 80,
          rows: 24,
        });
        health = await app.request("/healthz");
        await attaching;
        elapsed = Date.now() - started;
      } finally {
        clearInterval(pulse);
      }

      expect(health.status).toBe(200);
      // A quarter of the pulses it should have had is a wide allowance for a
      // loaded box; a blocked loop delivers a couple in total.
      expect(pulses).toBeGreaterThan(elapsed / 50 / 4);
      // The whole check is budgeted, so it cannot run the timeout once per query
      // per retry: that is 6x MIXED_PATH_HANG_MS, which would blow this.
      expect(elapsed).toBeLessThan(12_000);

      // The terminal that was already open kept streaming throughout, and was
      // neither closed nor terminated.
      expect(open.data.length).toBeGreaterThan(streamed);
      expect({ closed: open.closed, terminated: open.terminated }).toEqual({
        closed: 0,
        terminated: 0,
      });
      // Both sockets stayed attached: an unobservable tmux is not evidence the
      // window is gone.
      expect(second.closed + second.terminated).toBe(0);
    } finally {
      open.emit("close");
      second.emit("close");
    }
  });

  it("does not classify an unobservable live target as a dead worker", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const agent = createAgent({
      kind: "worker",
      state: "idle",
      tmux_target: "cc:@1",
    });
    const app = buildApp();
    await armHang("hang-all");

    const response = await app.request(`/api/agents/${agent.id}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "retry safely" }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "tmux message delivery failed",
    });
    expect(getAgent(agent.id)?.state).toBe("idle");
  });

  it.each([
    ["stale-target", 409, "no live tmux window"],
    ["no-client", 503, "tmux message delivery failed"],
  ])("returns a controlled API failure for %s", async (mode, status, message) => {
    const { buildApp } = await import("../src/daemon/api.js");
    const { createAgent } = await import("../src/db/agents.js");
    const agent = createAgent({
      kind: "worker",
      state: "idle",
      tmux_target: "cc:@1",
    });
    const app = buildApp();
    process.env.CC_FAKE_TMUX_MODE = mode;

    const response = await app.request(`/api/agents/${agent.id}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "private input" }),
    });

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: message });
  });
});
