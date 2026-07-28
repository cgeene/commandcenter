import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import pty from "node-pty";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { localeEnv } from "../src/daemon/locale.js";

// End-to-end proof that grouped viewer sessions (`ccv-*`) no longer leak: an
// armed viewer destroys itself the moment its client detaches, and
// sweepStaleViewerSessions reaps old-style viewers that were never armed —
// while the primary session's shared windows survive both.
//
// It drives a real tmux server, so TMUX_TMPDIR is pointed at a scratch
// directory before anything touches tmux — that moves the default socket the
// daemon code uses, and the whole server is torn down afterwards. Nothing here
// can reach the operator's own tmux session.
const TMPDIR = `/tmp/cc-vs-${process.pid}`;
const SESSION = `cc-test-vs-${process.pid}`;

const tmuxAvailable = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

// Real-process orchestration with polling delays.
vi.setConfig({ testTimeout: 60_000 });

function tmux(...args: string[]): string {
  return execFileSync("tmux", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function hasSession(name: string): boolean {
  return (
    spawnSync("tmux", ["has-session", "-t", `=${name}`], { stdio: "ignore" })
      .status === 0
  );
}

// Read attachment through list-sessions: display-message with a -t that no
// longer resolves silently falls back to the current session instead of
// failing, which would make this helper lie. Colon-separated because session
// names cannot contain colons, while a literal tab in format output is
// downgraded to `_` under this process's non-UTF-8 locale.
function attachedClients(name: string): number {
  const row = tmux("list-sessions", "-F", "#{session_name}:#{session_attached}")
    .trim()
    .split("\n")
    .map((line) => line.split(":"))
    .find(([sessionName]) => sessionName === name);
  return row ? Number(row[1]) : 0;
}

function windowNames(session: string): string[] {
  return tmux("list-windows", "-t", `=${session}`, "-F", "#{window_name}")
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
}

async function until(
  cond: () => boolean,
  timeoutMs = 15_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return cond();
}

/** A live tmux client, the way the daemon's viewer PTY attaches. */
function attachClient(session: string): pty.IPty {
  const term = pty.spawn("tmux", ["-u", "attach", "-t", session], {
    name: "xterm-256color",
    cols: 100,
    rows: 30,
    env: localeEnv(),
  });
  term.onData(() => {});
  return term;
}

let dataDir: string;
let windowId: string;

describe.skipIf(!tmuxAvailable)("viewer session lifecycle", () => {
  beforeAll(() => {
    fs.mkdirSync(TMPDIR, { recursive: true });
    process.env.TMUX_TMPDIR = TMPDIR;
    process.env.CC_TMUX_SESSION = SESSION;
    delete process.env.TMUX; // don't let a surrounding tmux hijack the target
    dataDir = fs.mkdtempSync("/tmp/cc-vs-db-");
    process.env.CC_DATA_DIR = dataDir;

    tmux("new-session", "-d", "-s", SESSION, "-n", "hub");
    tmux("new-window", "-d", "-t", `=${SESSION}`, "-n", "agent");
    windowId = tmux(
      "display-message", "-p", "-t", `=${SESSION}:agent`, "#{window_id}",
    ).trim();
  });

  afterAll(async () => {
    const { closeDb } = await import("../src/db/db.js");
    closeDb();
    spawnSync("tmux", ["kill-server"], { stdio: "ignore" });
    fs.rmSync(TMPDIR, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
    delete process.env.CC_TMUX_SESSION;
    delete process.env.TMUX_TMPDIR;
    delete process.env.CC_DATA_DIR;
  });

  it("an armed viewer session destroys itself on detach, keeping the primary intact", async () => {
    const { createViewerSession, armViewerSelfDestruct } = await import(
      "../src/daemon/termws.js"
    );
    const viewer = "ccv-1-abc123";

    await createViewerSession(viewer, SESSION, windowId);
    expect(hasSession(viewer)).toBe(true);

    const client = attachClient(viewer);
    try {
      // The production arming path: wait for the client to be attached, then
      // set destroy-unattached on the viewer session only.
      expect(await armViewerSelfDestruct(viewer)).toBe(true);
      expect(attachedClients(viewer)).toBeGreaterThan(0);
      // Plain target name: show-options does not resolve the `=` exact-match
      // prefix (observed on tmux 3.7b: "no such session: =ccv-...").
      expect(
        tmux("show-options", "-v", "-t", viewer, "destroy-unattached").trim(),
      ).toBe("on");
    } finally {
      client.kill();
    }

    // Client gone -> tmux reaps the grouped session on its own; no daemon
    // cleanup involved.
    expect(await until(() => !hasSession(viewer))).toBe(true);
    expect(hasSession(SESSION)).toBe(true);
    expect(windowNames(SESSION)).toEqual(["agent", "hub"]);
  });

  it("does not arm a viewer session that was already cleaned up", async () => {
    const { armViewerSelfDestruct } = await import("../src/daemon/termws.js");
    expect(await armViewerSelfDestruct("ccv-9-gone99")).toBe(false);
  });

  it("sweeps only stale unattached ccv-* sessions", async () => {
    const { sweepStaleViewerSessions } = await import("../src/daemon/termws.js");

    // Old-code-path viewers: grouped sessions that were never armed with
    // destroy-unattached.
    tmux("new-session", "-d", "-t", `=${SESSION}`, "-s", "ccv-20-dead01");
    tmux("new-session", "-d", "-t", `=${SESSION}`, "-s", "ccv-42-live02");
    // A non-viewer detached session must never be touched.
    tmux("new-session", "-d", "-s", "bystander");

    const client = attachClient("ccv-42-live02");
    try {
      expect(await until(() => attachedClients("ccv-42-live02") > 0)).toBe(true);

      // Everything was created moments ago, so with the real clock nothing
      // qualifies as stale.
      expect(await sweepStaleViewerSessions()).toEqual([]);
      expect(hasSession("ccv-20-dead01")).toBe(true);

      // Two hours later: the unattached viewer is reaped, the attached viewer
      // and the non-viewer sessions survive.
      const swept = await sweepStaleViewerSessions(Date.now() + 2 * 60 * 60_000);
      expect(swept).toEqual(["ccv-20-dead01"]);
      expect(await until(() => !hasSession("ccv-20-dead01"))).toBe(true);
      expect(hasSession("ccv-42-live02")).toBe(true);
      expect(hasSession("bystander")).toBe(true);
      expect(hasSession(SESSION)).toBe(true);
      expect(windowNames(SESSION)).toEqual(["agent", "hub"]);
    } finally {
      client.kill();
    }
  });
});
