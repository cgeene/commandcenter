import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

// killAgent / the kill endpoint touch tmux; stub it so the DB path is all we test.
vi.mock("../src/daemon/tmux.js", () => ({
  windowExists: () => false,
  killWindow: () => [],
  paneProcess: () => null,
  capturePane: () => "",
  clearInputLine: () => {},
  sendText: async () => {},
  sendEnter: () => {},
}));

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-kill-"));
  process.env.CC_DATA_DIR = tmpDir;
  process.env.CC_CODEX_HOME = path.join(tmpDir, "codex");
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.CC_CODEX_HOME;
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

  it("reaps a worker without deleting its resumable provider session", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const { createAgent, getAgent, updateAgent } = await import(
      "../src/db/agents.js"
    );
    const { createTask, getTask, updateTask } = await import(
      "../src/db/tasks.js"
    );
    const task = createTask({
      title: "retained Codex session",
      prompt: "x",
      repo: "/repo",
      worker_provider: "codex",
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
    });
    const worker = createAgent({
      kind: "worker",
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
      state: "working",
      task_id: task.id,
    });
    const sessionId = "019f93d4-1b5d-7b10-8dd7-fd81e6fc3bfb";
    const transcriptPath = path.join(tmpDir, "codex-session.jsonl");
    fs.writeFileSync(transcriptPath, '{"type":"response_item"}\n', "utf8");
    updateAgent(worker.id, {
      session_id: sessionId,
      transcript_path: transcriptPath,
    });
    updateTask(task.id, {
      status: "in_progress",
      agent_id: worker.id,
      session_id: sessionId,
      session_provider: "codex",
      worktree: "/repo",
    });

    const app = buildApp();
    const killResponse = await app.request(`/api/agents/${worker.id}/kill`, {
      method: "POST",
    });
    expect(killResponse.status).toBe(200);
    expect(getAgent(worker.id)).toMatchObject({
      state: "dead",
      session_id: sessionId,
      transcript_path: transcriptPath,
    });
    expect(getTask(task.id)).toMatchObject({
      session_id: sessionId,
      session_provider: "codex",
    });
    expect(fs.existsSync(transcriptPath)).toBe(true);

    const sessionResponse = await app.request(
      `/api/tasks/${task.id}/session`,
    );
    expect(sessionResponse.status).toBe(200);
    const session = (await sessionResponse.json()) as {
      session_id: string;
      resume_command: string;
    };
    expect(session.session_id).toBe(sessionId);
    expect(session.resume_command).toContain(
      `CODEX_HOME='${process.env.CC_CODEX_HOME}'`,
    );
    expect(session.resume_command).toContain("--cd '/repo'");
    expect(session.resume_command).toContain(`resume '${sessionId}'`);
  });
});
