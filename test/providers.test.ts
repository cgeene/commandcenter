import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-provider-"));
  process.env.CC_DATA_DIR = tmpDir;
  delete process.env.CC_WORKER_PROVIDER;
  delete process.env.CC_REVIEWER_MODEL;
  delete process.env.CC_CODEX_BIN;
  delete process.env.CC_CODEX_HOME;
  delete process.env.CC_CODEX_PROFILE;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("provider metadata", () => {
  it("defaults old call sites to Claude and accepts explicit Codex", async () => {
    const { createTask } = await import("../src/db/tasks.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { createCron } = await import("../src/db/crons.js");

    expect(createTask({ title: "a", prompt: "x", repo: "/r" }).worker_provider).toBe(
      "claude",
    );
    expect(
      createTask({
        title: "b",
        prompt: "x",
        repo: "/r",
        worker_provider: "codex",
      }).worker_provider,
    ).toBe("codex");
    expect(createAgent({ provider: "codex" }).provider).toBe("codex");
    expect(
      createCron({
        name: "codex-nightly",
        schedule: "0 3 * * *",
        prompt: "x",
        repo: "/r",
        worker_provider: "codex",
      }).worker_provider,
    ).toBe("codex");
  });

  it("migrates provider columns onto a legacy database", async () => {
    const legacy = new Database(path.join(tmpDir, "state.db"));
    legacy.exec(`
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL,
        repo TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
        priority INTEGER NOT NULL DEFAULT 2, model TEXT, session_id TEXT
      );
      CREATE TABLE agents (id INTEGER PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'worker');
      CREATE TABLE crons (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    `);
    legacy.close();

    const { getDb } = await import("../src/db/db.js");
    const db = getDb();
    const names = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
        (column) => column.name,
      );
    expect(names("tasks")).toEqual(
      expect.arrayContaining(["worker_provider", "session_provider"]),
    );
    expect(names("agents")).toEqual(
      expect.arrayContaining([
        "provider",
        "transcript_path",
        "runtime_config_path",
      ]),
    );
    expect(names("crons")).toContain("worker_provider");
  });

  it("validates providers at the API boundary and honors the configured default", async () => {
    process.env.CC_WORKER_PROVIDER = "codex";
    const { buildApp } = await import("../src/daemon/api.js");
    const app = buildApp();
    const created = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "t", prompt: "x", repo: "/r" }),
    });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { worker_provider: string }).worker_provider).toBe(
      "codex",
    );

    const invalid = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "bad",
        prompt: "x",
        repo: "/r",
        worker_provider: "unknown",
      }),
    });
    expect(invalid.status).toBe(400);
  });

  it("clears an incompatible model when a task changes providers", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const app = buildApp();
    const created = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "t",
        prompt: "x",
        repo: "/r",
        worker_provider: "claude",
        model: "sonnet",
      }),
    });
    const task = (await created.json()) as { id: number };
    const changed = await app.request(`/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worker_provider: "codex" }),
    });
    expect(
      (await changed.json()) as { worker_provider: string; model: string | null },
    ).toMatchObject({ worker_provider: "codex", model: null });
  });
});

describe("Codex runtime isolation", () => {
  it("builds a sandboxed interactive command without unsafe bypasses", async () => {
    process.env.CC_CODEX_BIN = "/opt/codex";
    process.env.CC_CODEX_HOME = "/tmp/cc codex";
    process.env.CC_CODEX_PROFILE = "commandcenter";
    const { _buildCodexCmdForTest } = await import("../src/daemon/spawn.js");
    const command = _buildCodexCmdForTest({
      agentId: 7,
      taskId: 9,
      model: "gpt-codex",
      promptFile: "/tmp/prompt.md",
      resumeSession: "session-123",
    });
    expect(command).toContain("CODEX_HOME='/tmp/cc codex'");
    expect(command).toContain("CC_AGENT_ID='7'");
    expect(command).toContain("--sandbox workspace-write");
    expect(command).toContain("--ask-for-approval on-request");
    expect(command).toContain("resume 'session-123'");
    expect(command).not.toMatch(/danger-full-access|--yolo|bypass-hook-trust/);
  });

  it("never resumes a session across providers and isolates reviewer models", async () => {
    process.env.CC_REVIEWER_MODEL = "review-opus";
    const {
      _resumableSessionForTest,
      _resolveReviewerModelForTest,
    } = await import("../src/daemon/spawn.js");
    const task = {
      session_id: "codex-session",
      session_provider: "codex",
    } as never;
    expect(_resumableSessionForTest(task, "codex")).toBe("codex-session");
    expect(_resumableSessionForTest(task, "claude")).toBeUndefined();
    expect(_resumableSessionForTest(task, "codex", true)).toBeUndefined();
    expect(_resolveReviewerModelForTest()).toBe("review-opus");
    expect(_resolveReviewerModelForTest("manual-reviewer")).toBe("manual-reviewer");
  });

  it("records Codex session ownership, transcript path, and permission waits", async () => {
    const { createTask, updateTask, getTask } = await import("../src/db/tasks.js");
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const task = createTask({
      title: "t",
      prompt: "x",
      repo: "/r",
      worker_provider: "codex",
    });
    const agent = createAgent({
      kind: "worker",
      provider: "codex",
      state: "working",
      task_id: task.id,
    });
    updateTask(task.id, { status: "in_progress", agent_id: agent.id });

    await handleHookEvent(agent.id, {
      hook_event_name: "SessionStart",
      session_id: "codex-123",
      transcript_path: "/private/session.jsonl",
    });
    expect(getTask(task.id)?.session_provider).toBe("codex");
    expect(getAgent(agent.id)?.transcript_path).toBe("/private/session.jsonl");

    process.env.CC_CODEX_HOME = "/tmp/commandcenter-codex";
    const { buildApp } = await import("../src/daemon/api.js");
    const response = await buildApp().request(`/api/agents/${agent.id}/session`);
    const session = (await response.json()) as {
      provider: string;
      session_id: string;
      resume_command: string;
    };
    expect(session).toMatchObject({
      provider: "codex",
      session_id: "codex-123",
    });
    expect(session.resume_command).toContain("codex");
    expect(session.resume_command).toContain("resume 'codex-123'");

    await handleHookEvent(agent.id, {
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { description: "needs network for git push" },
    });
    expect(getAgent(agent.id)?.state).toBe("waiting_input");
  });
});
