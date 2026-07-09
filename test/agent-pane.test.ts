import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;
let paneContent = "";
const sendKeys = { enter: 0, ctrlU: 0 };

vi.mock("../src/daemon/tmux.js", () => ({
  windowExists: () => true,
  sendText: async () => {},
  capturePane: () => paneContent,
  sendEnter: () => {
    sendKeys.enter += 1;
  },
  clearInputLine: () => {
    sendKeys.ctrlU += 1;
  },
}));

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-pane-"));
  process.env.CC_DATA_DIR = tmpDir;
  paneContent = "";
  sendKeys.enter = 0;
  sendKeys.ctrlU = 0;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /api/agents/:id/pane", () => {
  it("404s for an unknown agent", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const app = buildApp();
    const res = await app.request("/api/agents/999/pane");
    expect(res.status).toBe(404);
  });

  it("409s when the agent has no live tmux window", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const { createAgent } = await import("../src/db/agents.js");
    const agent = createAgent({ kind: "worker", state: "waiting_input" });

    const app = buildApp();
    const res = await app.request(`/api/agents/${agent.id}/pane`);
    expect(res.status).toBe(409);
  });

  it("returns the parsed pane for a live agent", async () => {
    paneContent = [
      "⏺ Anything else before I merge?",
      "",
      `╭${"─".repeat(40)}╮`,
      "│ ❯ please double check first                │",
      `╰${"─".repeat(40)}╯`,
    ].join("\n");

    const { buildApp } = await import("../src/daemon/api.js");
    const { createAgent } = await import("../src/db/agents.js");
    const agent = createAgent({
      kind: "worker",
      state: "waiting_input",
      tmux_target: "cc:@5",
    });

    const app = buildApp();
    const res = await app.request(`/api/agents/${agent.id}/pane`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      target: string;
      pending_question: string | null;
      unsubmitted_input: string | null;
    };
    expect(body.target).toBe("cc:@5");
    expect(body.pending_question).toBe("Anything else before I merge?");
    expect(body.unsubmitted_input).toBe("please double check first");
  });
});

describe("POST /api/agents/:id/submit-input", () => {
  it("presses Enter (not retype) and clears waiting_input", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const agent = createAgent({
      kind: "worker",
      state: "waiting_input",
      tmux_target: "cc:@6",
    });

    const app = buildApp();
    const res = await app.request(`/api/agents/${agent.id}/submit-input`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    expect(sendKeys.enter).toBe(1);
    expect(getAgent(agent.id)?.state).toBe("working");
  });

  it("404s for an unknown agent", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const app = buildApp();
    const res = await app.request("/api/agents/999/submit-input", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/agents/:id/clear-input", () => {
  it("sends Ctrl-U and never submits", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const agent = createAgent({
      kind: "worker",
      state: "waiting_input",
      tmux_target: "cc:@7",
    });

    const app = buildApp();
    const res = await app.request(`/api/agents/${agent.id}/clear-input`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    expect(sendKeys.ctrlU).toBe(1);
    expect(sendKeys.enter).toBe(0);
    // clearing never delivers input, so it must not flip the agent's state
    expect(getAgent(agent.id)?.state).toBe("waiting_input");
  });

  it("404s for an unknown agent", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const app = buildApp();
    const res = await app.request("/api/agents/999/clear-input", { method: "POST" });
    expect(res.status).toBe(404);
  });
});
