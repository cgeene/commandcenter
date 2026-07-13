import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const newWindow = vi.fn(
  (_name: string, _cwd: string, _command: string) => "cc:@7",
);
const windowExists = vi.fn(() => false);
const killWindow = vi.fn();

vi.mock("../src/daemon/tmux.js", () => ({
  newWindow: (name: string, cwd: string, command: string) =>
    newWindow(name, cwd, command),
  windowExists: (target: string) => windowExists(target),
  killWindow: (target: string) => killWindow(target),
}));

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-main-spawn-"));
  process.env.CC_DATA_DIR = tmpDir;
  delete process.env.CC_MAIN_WORKSPACE;
  newWindow.mockClear();
  windowExists.mockReset();
  windowExists.mockReturnValue(false);
  killWindow.mockClear();
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  delete process.env.CC_MAIN_WORKSPACE;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("main orchestrator spawn", () => {
  it("uses a private dedicated workspace and waits for SessionStart", async () => {
    const { spawnMain } = await import("../src/daemon/spawn.js");
    const { mainWorkspaceDir } = await import("../src/config.js");

    const main = spawnMain("fable");
    const workspace = mainWorkspaceDir();

    expect(main).toMatchObject({
      kind: "main",
      provider: "claude",
      model: "fable",
      state: "spawning",
      tmux_target: "cc:@7",
    });
    expect(newWindow).toHaveBeenCalledWith(
      "main",
      workspace,
      expect.any(String),
    );
    expect(fs.statSync(workspace).mode & 0o777).toBe(0o700);
    expect(workspace.startsWith(tmpDir + path.sep)).toBe(true);
    expect(workspace).not.toBe(os.homedir());
    const settings = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "settings", "main.json"), "utf8"),
    ) as { permissions: { deny: string[] } };
    expect(settings.permissions.deny).toEqual([
      "Edit",
      "Write",
      "NotebookEdit",
      "Bash",
    ]);
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

  it("fails closed on a populated main workspace without stranding an agent", async () => {
    const { spawnMain } = await import("../src/daemon/spawn.js");
    const { listAgents } = await import("../src/db/agents.js");
    const workspace = path.join(tmpDir, "populated-main");
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, "CLAUDE.md"), "untrusted override");
    process.env.CC_MAIN_WORKSPACE = workspace;

    expect(() => spawnMain("fable")).toThrow("main workspace must be empty");
    expect(listAgents({ live: true })).toHaveLength(0);
    expect(newWindow).not.toHaveBeenCalled();
  });
});
