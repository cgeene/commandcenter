import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sendText = vi.fn(async () => {});

vi.mock("../src/daemon/tmux.js", () => ({
  windowExists: () => true,
  sendText: (...args: unknown[]) => sendText(...args),
  capturePane: () => "",
}));

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-resume-"));
  process.env.CC_DATA_DIR = tmpDir;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  sendText.mockClear();
  sendText.mockImplementation(async () => {});
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("resumeAgent", () => {
  it("refuses to inject into a waiting_input agent unless interrupting", async () => {
    const { resumeAgent } = await import("../src/daemon/resume.js");
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const agent = createAgent({
      kind: "worker",
      state: "waiting_input",
      tmux_target: "cc:@1",
    });
    // unsolicited text would be typed into the pending permission menu
    expect(await resumeAgent(agent.id, "pr feedback")).toBe("waiting_input");
    expect(sendText).not.toHaveBeenCalled();
    expect(getAgent(agent.id)?.state).toBe("waiting_input");

    expect(await resumeAgent(agent.id, "2", { interrupt: true })).toBe("sent");
    expect(sendText).toHaveBeenCalledOnce();
    expect(getAgent(agent.id)?.state).toBe("working");
  });

  it("reports not_live for dead agents and windowless agents", async () => {
    const { resumeAgent } = await import("../src/daemon/resume.js");
    const { createAgent } = await import("../src/db/agents.js");
    const dead = createAgent({ kind: "worker", state: "dead", tmux_target: "cc:@1" });
    const windowless = createAgent({ kind: "worker", state: "idle" });
    expect(await resumeAgent(dead.id, "x")).toBe("not_live");
    expect(await resumeAgent(windowless.id, "x")).toBe("not_live");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("reports not_live when the send itself fails, without touching state", async () => {
    const { resumeAgent } = await import("../src/daemon/resume.js");
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const agent = createAgent({ kind: "worker", state: "idle", tmux_target: "cc:@1" });
    sendText.mockImplementationOnce(async () => {
      throw new Error("window vanished");
    });
    // callers fall back (requeue/defer) instead of losing the message
    expect(await resumeAgent(agent.id, "x")).toBe("not_live");
    expect(getAgent(agent.id)?.state).toBe("idle");
  });

  it("does not resurrect an agent that died while the text was in flight", async () => {
    const { resumeAgent } = await import("../src/daemon/resume.js");
    const { createAgent, getAgent, updateAgent } = await import("../src/db/agents.js");
    const agent = createAgent({ kind: "worker", state: "idle", tmux_target: "cc:@1" });
    sendText.mockImplementationOnce(async () => {
      updateAgent(agent.id, { state: "dead" }); // Stop-hook/kill during the ≥300ms send
    });
    expect(await resumeAgent(agent.id, "x")).toBe("sent");
    expect(getAgent(agent.id)?.state).toBe("dead");
  });

  it("does not mask a wait that started while the text was in flight", async () => {
    const { resumeAgent } = await import("../src/daemon/resume.js");
    const { createAgent, getAgent, updateAgent } = await import("../src/db/agents.js");
    const agent = createAgent({ kind: "worker", state: "working", tmux_target: "cc:@1" });
    sendText.mockImplementationOnce(async () => {
      updateAgent(agent.id, { state: "waiting_input" }); // Notification mid-send
    });
    expect(await resumeAgent(agent.id, "x")).toBe("sent");
    // the new wait must stay visible to delegation + the escalate watchdog
    expect(getAgent(agent.id)?.state).toBe("waiting_input");
  });
});
