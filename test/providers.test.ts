import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;
let savedRepoRoots: string | undefined;
let savedRepoRoot: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-provider-"));
  process.env.CC_DATA_DIR = tmpDir;
  delete process.env.CC_WORKER_PROVIDER;
  delete process.env.CC_REVIEWER_MODEL;
  delete process.env.CC_CODEX_BIN;
  delete process.env.CC_CODEX_HOME;
  delete process.env.CC_CODEX_PROFILE;
  // Keep task creation on the legacy absolute-path branch regardless of any
  // CC_REPO_ROOTS in the ambient environment, so these tests are hermetic.
  savedRepoRoots = process.env.CC_REPO_ROOTS;
  savedRepoRoot = process.env.CC_REPO_ROOT;
  delete process.env.CC_REPO_ROOTS;
  delete process.env.CC_REPO_ROOT;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (savedRepoRoots === undefined) delete process.env.CC_REPO_ROOTS;
  else process.env.CC_REPO_ROOTS = savedRepoRoots;
  if (savedRepoRoot === undefined) delete process.env.CC_REPO_ROOT;
  else process.env.CC_REPO_ROOT = savedRepoRoot;
});

describe("provider metadata", () => {
  it("defaults old call sites to Claude and accepts explicit Codex", async () => {
    const { createTask } = await import("../src/db/tasks.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { createCron } = await import("../src/db/crons.js");

    expect(createTask({ title: "a", prompt: "x", repo: "/r" })).toMatchObject({
      worker_provider: "claude",
      reasoning_effort: null,
    });
    expect(
      createTask({
        title: "b",
        prompt: "x",
        repo: "/r",
        worker_provider: "codex",
      }),
    ).toMatchObject({ worker_provider: "codex", reasoning_effort: "high" });
    expect(createAgent({ provider: "codex" }).provider).toBe("codex");
    expect(
      createCron({
        name: "codex-nightly",
        schedule: "0 3 * * *",
        prompt: "x",
        repo: "/r",
        worker_provider: "codex",
      }),
    ).toMatchObject({ worker_provider: "codex", reasoning_effort: "high" });
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
      INSERT INTO tasks (id, title, prompt, repo) VALUES (1, 'legacy', 'x', '/r');
    `);
    legacy.close();

    const { getDb } = await import("../src/db/db.js");
    const db = getDb();
    const names = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
        (column) => column.name,
      );
    expect(names("tasks")).toEqual(
      expect.arrayContaining([
        "worker_provider",
        "session_provider",
        "reasoning_effort",
        "workspace_kind",
        "dispatch_mode",
        "parent_task_id",
        "publication_mode",
        "publication_state",
        "review_snapshot_base",
        "review_snapshot_tree",
      ]),
    );
    expect(
      db.prepare("SELECT publication_mode FROM tasks WHERE id = 1").get(),
    ).toEqual({ publication_mode: "agent" });
    expect(names("agents")).toEqual(
      expect.arrayContaining([
        "provider",
        "transcript_path",
        "runtime_config_path",
        "reasoning_effort",
      ]),
    );
    expect(names("crons")).toEqual(
      expect.arrayContaining(["worker_provider", "reasoning_effort"]),
    );
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
    expect(await created.json()).toMatchObject({
      worker_provider: "codex",
      reasoning_effort: "high",
    });

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

    const invalidEffort = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "bad effort",
        prompt: "x",
        repo: "/r",
        worker_provider: "codex",
        reasoning_effort: "impossible",
      }),
    });
    expect(invalidEffort.status).toBe(400);

    const claudeEffort = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "wrong provider",
        prompt: "x",
        repo: "/r",
        worker_provider: "claude",
        reasoning_effort: "high",
      }),
    });
    expect(claudeEffort.status).toBe(400);
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
      (await changed.json()) as {
        worker_provider: string;
        model: string | null;
        reasoning_effort: string | null;
      },
    ).toMatchObject({
      worker_provider: "codex",
      model: null,
      reasoning_effort: "high",
    });

    const changedBack = await app.request(`/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worker_provider: "claude" }),
    });
    expect(await changedBack.json()).toMatchObject({
      worker_provider: "claude",
      model: null,
      reasoning_effort: null,
    });
  });

  it("rejects a provider change while the task has a live agent", async () => {
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { buildApp } = await import("../src/daemon/api.js");
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    const agent = createAgent({
      kind: "worker",
      provider: "claude",
      state: "working",
      task_id: task.id,
    });
    updateTask(task.id, { status: "in_progress", agent_id: agent.id });

    const changed = await buildApp().request(`/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worker_provider: "codex" }),
    });
    expect(changed.status).toBe(409);
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
      reasoningEffort: "ultra",
      workspaceKind: "repo",
      promptFile: "/tmp/prompt.md",
      resumeSession: "session-123",
    });
    expect(command).toContain("CODEX_HOME='/tmp/cc codex'");
    expect(command).toContain("CC_AGENT_ID='7'");
    expect(command).toContain("--sandbox workspace-write");
    expect(command).toContain("--ask-for-approval on-request");
    expect(command).toContain("--config 'model_reasoning_effort=\"ultra\"'");
    expect(command).toContain("resume 'session-123'");
    expect(command).not.toMatch(/danger-full-access|--yolo|bypass-hook-trust/);
  });

  it("never resumes a session across providers and isolates reviewer models", async () => {
    process.env.CC_REVIEWER_MODEL = "review-opus";
    process.env.CC_CODEX_HOME = path.join(tmpDir, "codex");
    const sid = "codex-session";
    const sessions = path.join(process.env.CC_CODEX_HOME, "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(
      path.join(sessions, `rollout-${sid}.jsonl`),
      JSON.stringify({ type: "session_meta", payload: { id: sid } }),
    );
    const {
      _resumableSessionForTest,
      _resolveReviewerModelForTest,
    } = await import("../src/daemon/spawn.js");
    const task = {
      session_id: sid,
      session_provider: "codex",
    } as never;
    expect(_resumableSessionForTest(task, "codex")).toBe(sid);
    expect(_resumableSessionForTest(task, "claude")).toBeUndefined();
    expect(_resumableSessionForTest(task, "codex", true)).toBeUndefined();
    expect(_resolveReviewerModelForTest(task)).toBe("review-opus");
    expect(_resolveReviewerModelForTest(task, "manual-reviewer")).toBe(
      "manual-reviewer",
    );
    fs.rmSync(path.join(sessions, `rollout-${sid}.jsonl`));
    expect(_resumableSessionForTest(task, "codex")).toBeUndefined();
  });

  it("preserves a Claude task model for reviewers but never reuses a Codex model", async () => {
    delete process.env.CC_REVIEWER_MODEL;
    const { _resolveReviewerModelForTest } = await import("../src/daemon/spawn.js");
    expect(
      _resolveReviewerModelForTest({ worker_provider: "claude", model: "sonnet" } as never),
    ).toBe("sonnet");
    expect(
      _resolveReviewerModelForTest({ worker_provider: "codex", model: "gpt-codex" } as never),
    ).toBe("opus");
  });

  it("selects the reviewer provider by override, pin, variety policy, then Claude", async () => {
    const prevProvider = process.env.CC_REVIEWER_PROVIDER;
    const prevVariety = process.env.CC_REVIEWER_VARIETY;
    delete process.env.CC_REVIEWER_PROVIDER;
    delete process.env.CC_REVIEWER_VARIETY;
    const { _resolveReviewerProviderForTest } = await import("../src/daemon/spawn.js");
    const claudeTask = { worker_provider: "claude" } as never;
    const codexTask = { worker_provider: "codex" } as never;
    try {
      // Default: reviewers stay Claude (nothing changes unless asked).
      expect(_resolveReviewerProviderForTest(claudeTask)).toBe("claude");
      expect(_resolveReviewerProviderForTest(codexTask)).toBe("claude");
      // Explicit override wins; an invalid value falls back to Claude.
      expect(_resolveReviewerProviderForTest(claudeTask, "codex")).toBe("codex");
      expect(_resolveReviewerProviderForTest(codexTask, "bogus")).toBe("claude");
      // CC_REVIEWER_PROVIDER pin.
      process.env.CC_REVIEWER_PROVIDER = "codex";
      expect(_resolveReviewerProviderForTest(claudeTask)).toBe("codex");
      delete process.env.CC_REVIEWER_PROVIDER;
      // Variety policy: opposite of the worker; a Codex worker always yields a
      // Claude reviewer (the always-available direction).
      process.env.CC_REVIEWER_VARIETY = "1";
      expect(_resolveReviewerProviderForTest(claudeTask)).toBe("codex");
      expect(_resolveReviewerProviderForTest(codexTask)).toBe("claude");
    } finally {
      if (prevProvider === undefined) delete process.env.CC_REVIEWER_PROVIDER;
      else process.env.CC_REVIEWER_PROVIDER = prevProvider;
      if (prevVariety === undefined) delete process.env.CC_REVIEWER_VARIETY;
      else process.env.CC_REVIEWER_VARIETY = prevVariety;
    }
  });

  it("records Codex session ownership, transcript path, and permission waits", async () => {
    const { createTask, updateTask, getTask } = await import("../src/db/tasks.js");
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
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
      model: "gpt-5.6-luna",
      reasoning_effort: "max",
      state: "working",
      task_id: task.id,
    });
    updateTask(task.id, { status: "in_progress", agent_id: agent.id });
    process.env.CC_CODEX_HOME = path.join(tmpDir, "commandcenter-codex");
    const sessions = path.join(process.env.CC_CODEX_HOME, "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    const transcript = path.join(sessions, "rollout-codex-123.jsonl");
    fs.writeFileSync(
      transcript,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "codex-123" } }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "implemented safely" }],
          },
        }),
      ].join("\n"),
    );

    await handleHookEvent(agent.id, {
      hook_event_name: "SessionStart",
      session_id: "codex-123",
      transcript_path: transcript,
    });
    expect(getTask(task.id)?.session_provider).toBe("codex");
    expect(getAgent(agent.id)?.transcript_path).toBe(transcript);

    const { buildApp } = await import("../src/daemon/api.js");
    const app = buildApp();
    const response = await app.request(`/api/agents/${agent.id}/session`);
    const session = (await response.json()) as {
      provider: string;
      model: string | null;
      reasoning_effort: string | null;
      session_id: string;
      resume_command: string;
    };
    expect(session).toMatchObject({
      provider: "codex",
      model: "gpt-5.6-luna",
      reasoning_effort: "max",
      session_id: "codex-123",
    });
    expect(session.resume_command).toContain("codex");
    expect(session.resume_command).toContain("--model 'gpt-5.6-luna'");
    expect(session.resume_command).toContain(
      "--config 'model_reasoning_effort=\"max\"'",
    );
    expect(session.resume_command).toContain("resume 'codex-123'");
    const transcriptResponse = await app.request(`/api/agents/${agent.id}/transcript`);
    expect(transcriptResponse.status).toBe(200);
    expect(
      (await transcriptResponse.json()) as { provider: string; entries: unknown[] },
    ).toMatchObject({
      provider: "codex",
      entries: [{ role: "assistant", text: "implemented safely" }],
    });

    await handleHookEvent(agent.id, {
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "git push -u origin agent/task-1" },
    });
    expect(getAgent(agent.id)?.state).toBe("working");
    expect(listEvents(10).map((event) => event.kind)).toContain(
      "permission.auto_approved",
    );

    await handleHookEvent(agent.id, {
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { description: "needs network for git push" },
    });
    expect(getAgent(agent.id)?.state).toBe("waiting_input");
  });
});

describe("Codex worker permission policy", () => {
  it("allows only the exact task-branch push", async () => {
    const { codexPermissionDecision } = await import("../src/codex-policy.js");
    const payload = (command: string, event = "PermissionRequest") => ({
      hook_event_name: event,
      tool_name: "Bash",
      tool_input: { command },
    });
    expect(
      codexPermissionDecision(payload("git push -u origin agent/task-12"), "12", "repo")
        ?.behavior,
    ).toBe("allow");
    expect(
      codexPermissionDecision(payload("git push origin agent/task-12:main"), "12", "repo")
        ?.behavior,
    ).toBe("deny");
    expect(
      codexPermissionDecision(payload("git push --force origin main"), "12", "repo")?.behavior,
    ).toBe("deny");
    expect(codexPermissionDecision(payload("gh pr merge 44"), "12", "repo")?.behavior).toBe(
      "deny",
    );
    expect(codexPermissionDecision(payload("npm test"), "12", "repo")).toBeUndefined();
    expect(
      codexPermissionDecision(payload("env git push origin main", "PreToolUse"), "12", "repo")
        ?.behavior,
    ).toBe("deny");
    expect(
      codexPermissionDecision(
        payload("git push origin agent/task-12", "PreToolUse"),
        "12",
        "repo",
      )?.behavior,
    ).toBe("allow");
    expect(
      codexPermissionDecision(
        payload("git push origin agent/task-12"),
        "12",
        "scratch",
      )?.behavior,
    ).toBe("deny");
  });
});

describe("Codex profile generation", () => {
  it("auto-reviews approval requests without weakening the worker sandbox", async () => {
    const { _codexApprovalConfigForTest } = await import(
      "../src/daemon/genconfig.js"
    );
    expect(_codexApprovalConfigForTest()).toEqual([
      'approval_policy = "on-request"',
      'approvals_reviewer = "auto_review"',
      'sandbox_mode = "workspace-write"',
    ]);
  });

  it("preserves Codex-managed trust state while replacing generated settings", async () => {
    const { _mergeCodexProfileForTest } = await import(
      "../src/daemon/genconfig.js"
    );
    const generated = [
      'approval_policy = "on-request"',
      'approvals_reviewer = "auto_review"',
      "[features]",
      "hooks = true",
      "[mcp_servers.cc]",
      'command = "/new/node"',
    ].join("\n");
    const existing = [
      'approval_policy = "never"',
      "[features]",
      "hooks = false",
      "[mcp_servers.cc]",
      'command = "/old/node"',
      '[projects."/tmp/repo"]',
      'trust_level = "trusted"',
      "[hooks.state]",
      '[hooks.state."hook-key"]',
      'trusted_hash = "sha256:abc"',
      "[tui.model_availability_nux]",
      '"gpt-example" = 1',
    ].join("\n");

    const merged = _mergeCodexProfileForTest(generated, existing);
    expect(merged).toContain('command = "/new/node"');
    expect(merged).toContain('approvals_reviewer = "auto_review"');
    expect(merged).not.toContain('approval_policy = "never"');
    expect(merged).not.toContain('command = "/old/node"');
    expect(merged).toContain('[projects."/tmp/repo"]');
    expect(merged).toContain('trusted_hash = "sha256:abc"');
    expect(merged).toContain('[tui.model_availability_nux]');
  });
});
