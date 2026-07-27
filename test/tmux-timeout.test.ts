import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;
let originalPath: string | undefined;

const fakeTmux = `#!/bin/sh
mode="\${CC_FAKE_TMUX_MODE:-ok}"

if [ "$mode" = "hang-all" ]; then
  exec sleep 60
fi

if [ "$mode" = "missing-socket" ] && [ "$1" = "has-session" ]; then
  printf 'error connecting to /private/tmp/tmux-501/default (No such file or directory)\\n' >&2
  exit 1
fi

if [ "$1" = "new-session" ]; then
  printf 'new-session\\n' >> "$CC_FAKE_TMUX_LOG"
  exit 0
fi

if [ "$1" = "list-windows" ]; then
  live=0
  for arg in "$@"; do
    case "$arg" in
      *pane_dead*) live=1 ;;
    esac
  done
  if [ "$live" = "1" ]; then
    printf 'cc:@1\\t0\\n'
  else
    printf 'cc:@1\\n'
  fi
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
  _setTmuxTimeoutForTest(500);
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
});

function calls(): string[] {
  const log = process.env.CC_FAKE_TMUX_LOG!;
  return fs.existsSync(log)
    ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
    : [];
}

describe("bounded daemon tmux commands", () => {
  it("bounds a hung literal send", async () => {
    const { sendText } = await import("../src/daemon/tmux.js");
    process.env.CC_FAKE_TMUX_MODE = "hang-literal";
    const started = Date.now();

    const failure = await sendText("cc:@1", "sensitive message").catch((error) => error);

    expect(Date.now() - started).toBeLessThan(1_200);
    expect(failure).toMatchObject({
      code: "timeout",
      message: "tmux send-keys timed out",
    });
    expect(String(failure)).not.toContain("sensitive message");
    expect(String(failure)).not.toContain("cc:@1");
  });

  it("bounds Enter delivery after the literal text succeeds", async () => {
    const { sendText } = await import("../src/daemon/tmux.js");
    process.env.CC_FAKE_TMUX_MODE = "hang-enter";
    const started = Date.now();

    const failure = await sendText("cc:@1", "message").catch((error) => error);

    expect(Date.now() - started).toBeLessThan(1_500);
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
    const { listLiveWindowIds } = await import("../src/daemon/tmux.js");
    process.env.CC_FAKE_TMUX_MODE = "hang-all";
    const started = Date.now();

    expect(listLiveWindowIds()).toBeNull();

    expect(Date.now() - started).toBeLessThan(1_200);
    process.env.CC_FAKE_TMUX_MODE = "ok";
    expect(listLiveWindowIds()).toEqual(["cc:@1"]);
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
    process.env.CC_FAKE_TMUX_MODE = "hang-capture";
    const started = Date.now();

    const peek = await app.request(`/api/agents/${agent.id}/peek`);

    expect(Date.now() - started).toBeLessThan(1_200);
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
    process.env.CC_FAKE_TMUX_MODE = "hang-all";
    const started = Date.now();

    const hook = await app.request(`/api/hooks/agent/${agent.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hook_event_name: "Notification",
        notification_type: "permission_prompt",
      }),
    });

    expect(Date.now() - started).toBeLessThan(1_200);
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
    process.env.CC_FAKE_TMUX_MODE = "hang-literal";

    const send = app.request(`/api/agents/${agent.id}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "do not log this" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const healthStarted = Date.now();
    const health = await app.request("/healthz");
    expect(health.status).toBe(200);
    expect(Date.now() - healthStarted).toBeLessThan(250);

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

  it("does not classify an unobservable live target as a dead worker", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const agent = createAgent({
      kind: "worker",
      state: "idle",
      tmux_target: "cc:@1",
    });
    const app = buildApp();
    process.env.CC_FAKE_TMUX_MODE = "hang-all";

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
