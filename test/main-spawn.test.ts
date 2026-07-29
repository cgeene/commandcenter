import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const newWindow = vi.fn(
  (_name: string, _cwd: string, _command: string) => "cc:@7",
);
const windowExists = vi.fn(() => false);
const killWindow = vi.fn((_target: string) => [] as number[]);
const paneProcess = vi.fn((_target: string) => null as { pid: number } | null);

vi.mock("../src/daemon/tmux.js", () => ({
  newWindow: (name: string, cwd: string, command: string) =>
    newWindow(name, cwd, command),
  windowExists: (target: string) => windowExists(target),
  killWindow: (target: string) => killWindow(target),
  paneProcess: (target: string) => paneProcess(target),
}));

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-main-spawn-"));
  process.env.CC_DATA_DIR = tmpDir;
  delete process.env.CC_MAIN_WORKSPACE;
  delete process.env.CC_MAIN_MODEL;
  newWindow.mockReset();
  newWindow.mockReturnValue("cc:@7");
  windowExists.mockReset();
  windowExists.mockReturnValue(false);
  killWindow.mockClear();
  paneProcess.mockReset();
  paneProcess.mockReturnValue(null);
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  delete process.env.CC_MAIN_WORKSPACE;
  delete process.env.CC_MAIN_MODEL;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("main orchestrator spawn", () => {
  it("defaults to fable, runs in $HOME, and waits for SessionStart", async () => {
    // The orchestrator now defaults to Fable 5 (suited to long-running
    // orchestration and delegation), runs in $HOME, and stays "spawning"
    // until its SessionStart hook reports in.
    const { spawnMain } = await import("../src/daemon/spawn.js");

    const main = spawnMain();

    expect(main).toMatchObject({
      kind: "main",
      provider: "claude",
      model: "fable",
      state: "spawning",
      tmux_target: "cc:@7",
    });
    expect(newWindow).toHaveBeenCalledWith(
      "main",
      os.homedir(),
      expect.any(String),
    );
    const command = String(newWindow.mock.calls[0]?.[2]);
    const isolationDir = path.join(tmpDir, "agent-tmux", String(main.id));
    expect(command).toContain(
      `env -u TMUX -u TMUX_PANE TMUX_TMPDIR='${isolationDir}'`,
    );
    expect(fs.statSync(isolationDir).mode & 0o777).toBe(0o700);

    const settings = JSON.parse(
      fs.readFileSync(main.runtime_config_path!, "utf8"),
    );
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining([
        "Bash(tmux kill*)",
        "Bash(*tmux * kill*)",
      ]),
    );
  });

  it("lets CC_MAIN_MODEL override the fable default", async () => {
    const { spawnMain } = await import("../src/daemon/spawn.js");

    process.env.CC_MAIN_MODEL = "opus";
    expect(spawnMain().model).toBe("opus");
  });

  it("is not blocked by a live main row whose spawn never attached a pane", async () => {
    const { spawnMain } = await import("../src/daemon/spawn.js");
    const { createAgent, getAgent, listAgents } = await import(
      "../src/db/agents.js"
    );
    const { listEvents } = await import("../src/db/events.js");
    // What a spawn interrupted between createAgent and attachPane leaves behind.
    const leaked = createAgent({ kind: "main", state: "spawning" });

    const main = spawnMain();

    expect(main.id).not.toBe(leaked.id);
    expect(main.tmux_target).toBe("cc:@7");
    // The leaked row is retired, not merely stepped over, so only one main row
    // answers for the orchestrator.
    expect(getAgent(leaked.id)?.state).toBe("dead");
    expect(listAgents({ live: true }).filter((a) => a.kind === "main")).toHaveLength(1);
    expect(listEvents(10).map((event) => event.kind)).toContain(
      "main.spawn_abandoned",
    );
  });

  it("still refuses to start a second main while one holds a pane, even idle", async () => {
    // `idle` is the orchestrator's resting state between turns, not a zombie:
    // it is exactly when triage delegation wants it, so it must keep refusing.
    const { spawnMain } = await import("../src/daemon/spawn.js");
    const { createAgent, updateAgent } = await import("../src/db/agents.js");

    for (const state of ["idle", "working", "waiting_input", "stalled"] as const) {
      const live = createAgent({ kind: "main", state, tmux_target: "cc:@3" });
      expect(() => spawnMain()).toThrow(/already live/);
      updateAgent(live.id, { state: "dead" });
    }
  });

  it("leaves no live main row behind when the spawn throws before attaching", async () => {
    const { spawnMain } = await import("../src/daemon/spawn.js");
    const { listAgents } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    newWindow.mockImplementation(() => {
      throw new Error("tmux new-window failed");
    });

    expect(() => spawnMain()).toThrow(/tmux new-window failed/);

    expect(listAgents({ live: true })).toEqual([]);
    expect(listEvents(10).map((event) => event.kind)).toContain(
      "agent.spawn_failed",
    );
    // No window was created, so there is nothing to tear down.
    expect(killWindow).not.toHaveBeenCalled();

    // And the wedge is gone: the next attempt gets through.
    newWindow.mockImplementation(() => "cc:@8");
    expect(spawnMain().tmux_target).toBe("cc:@8");
  });

  it("kills the window it opened when the spawn throws after newWindow", async () => {
    const { spawnMain } = await import("../src/daemon/spawn.js");
    const { listAgents } = await import("../src/db/agents.js");
    windowExists.mockReturnValue(true);
    paneProcess.mockImplementation(() => {
      throw new Error("pane lookup failed");
    });

    expect(() => spawnMain()).toThrow(/pane lookup failed/);

    expect(killWindow).toHaveBeenCalledWith("cc:@7");
    expect(listAgents({ live: true })).toEqual([]);
  });

  it("can kill a live split-brain process even when its DB row says dead", async () => {
    const { killAgent } = await import("../src/daemon/spawn.js");
    const { createAgent, updateAgent } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    const agent = createAgent({
      kind: "main",
      state: "working",
      tmux_target: "cc:@9",
    });
    updateAgent(agent.id, { state: "dead" });
    windowExists.mockReturnValue(true);

    expect(killAgent(agent.id).state).toBe("dead");
    expect(killWindow).toHaveBeenCalledWith("cc:@9");
    expect(listEvents(10).map((event) => event.kind)).toContain("agent.killed");
  });
});
