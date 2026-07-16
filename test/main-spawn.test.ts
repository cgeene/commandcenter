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
  it("defaults to opus, runs in $HOME, and waits for SessionStart", async () => {
    // The Codex landing keeps main's current orchestrator behavior: opus model,
    // cwd = $HOME, and no extra deny list. The Fable-model switch + workspace
    // isolation + Edit/Write/Bash lock-down (from the codex branch's f55e0e9)
    // are intentionally split out into a separate, deliberate change.
    const { spawnMain } = await import("../src/daemon/spawn.js");

    const main = spawnMain();

    expect(main).toMatchObject({
      kind: "main",
      provider: "claude",
      model: "opus",
      state: "spawning",
      tmux_target: "cc:@7",
    });
    expect(newWindow).toHaveBeenCalledWith(
      "main",
      os.homedir(),
      expect.any(String),
    );
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
