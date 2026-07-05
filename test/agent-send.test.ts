import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

vi.mock("../src/daemon/tmux.js", () => ({
  windowExists: () => true,
  sendText: async () => {},
  capturePane: () => "",
}));

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-send-"));
  process.env.CC_DATA_DIR = tmpDir;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * A resumed Claude Code session has no hook that fires when it picks work
 * back up — only Notification (sets waiting_input) and Stop (sets idle) touch
 * agent state. Delivering input via /send must clear waiting_input itself,
 * or the dashboard shows a stuck agent until the next Stop/Notification.
 */
describe("POST /api/agents/:id/send", () => {
  it("moves a waiting_input agent back to working when input is delivered", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const agent = createAgent({
      kind: "worker",
      state: "waiting_input",
      tmux_target: "cc:@1",
    });

    const app = buildApp();
    const res = await app.request(`/api/agents/${agent.id}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "yes" }),
    });

    expect(res.status).toBe(200);
    expect(getAgent(agent.id)?.state).toBe("working");
  });

  it("leaves a working agent's state untouched", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const agent = createAgent({
      kind: "worker",
      state: "working",
      tmux_target: "cc:@2",
    });

    const app = buildApp();
    await app.request(`/api/agents/${agent.id}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "feedback" }),
    });

    expect(getAgent(agent.id)?.state).toBe("working");
  });

  it("moves an idle agent to working — a follow-up instruction starts a turn", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const agent = createAgent({
      kind: "worker",
      state: "idle",
      tmux_target: "cc:@3",
    });

    const app = buildApp();
    await app.request(`/api/agents/${agent.id}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "also update the docs" }),
    });

    const a = getAgent(agent.id)!;
    expect(a.state).toBe("working");
    expect(a.last_event_at).not.toBeNull(); // stall clock restarts at the resume
  });
});
