import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

// killAgent / the kill endpoint touch tmux; stub it so the DB path is all we test.
vi.mock("../src/daemon/tmux.js", () => ({
  windowExists: () => false,
  killWindow: () => {},
  capturePane: () => "",
  clearInputLine: () => {},
  sendText: async () => {},
  sendEnter: () => {},
}));

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-kill-"));
  process.env.CC_DATA_DIR = tmpDir;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("POST /api/agents/:id/kill", () => {
  it("refuses to kill the main agent (403) and leaves it alive", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const main = createAgent({ kind: "main", state: "working" });

    const app = buildApp();
    const res = await app.request(`/api/agents/${main.id}/kill`, { method: "POST" });

    expect(res.status).toBe(403);
    expect(getAgent(main.id)?.state).toBe("working");
  });

  it("kills a worker agent", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const worker = createAgent({ kind: "worker", state: "working" });

    const app = buildApp();
    const res = await app.request(`/api/agents/${worker.id}/kill`, { method: "POST" });

    expect(res.status).toBe(200);
    expect(getAgent(worker.id)?.state).toBe("dead");
  });
});
