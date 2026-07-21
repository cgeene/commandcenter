import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let tmpDir: string;
let root: string;
let repo: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-workspace-api-"));
  tmpDir = fs.realpathSync(tmpDir);
  process.env.CC_DATA_DIR = path.join(tmpDir, "data");
  root = path.join(tmpDir, "repos");
  repo = path.join(root, "notetaker");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  process.env.CC_REPO_ROOTS = root;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  delete process.env.CC_REPO_ROOTS;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("workspace API", () => {
  it("serves only the configured repository catalog", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const response = await buildApp().request("/api/workspaces");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      roots: [{ path: root }],
      repositories: [{ path: repo, relative_path: "notetaker" }],
      scratch_retention_days: 7,
    });
  });

  it("creates explicit repository tasks as main-orchestrated", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const { listEvents } = await import("../src/db/events.js");
    const response = await buildApp().request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "change it",
        prompt: "do the work",
        workspace_kind: "repo",
        repo,
        worker_provider: "codex",
      }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      repo,
      workspace_kind: "repo",
      dispatch_mode: "orchestrated",
      parent_task_id: null,
    });
    expect(listEvents(10).map((event) => event.kind)).toContain("task.awaiting_main");
  });

  it("creates portfolio parents and server-owned scratch tasks without PRs", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const app = buildApp();
    const portfolioResponse = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "change several repos",
        prompt: "find every affected repo",
        workspace_kind: "portfolio",
        repo_root: root,
        worker_provider: "codex",
        model: "gpt-5.6-sol",
        reasoning_effort: "xhigh",
        priority: 1,
      }),
    });
    const portfolio = (await portfolioResponse.json()) as { id: number };
    expect(portfolioResponse.status).toBe(201);
    expect(portfolio).toMatchObject({
      repo: root,
      workspace_kind: "portfolio",
      dispatch_mode: "orchestrated",
      open_pr: 0,
    });

    const childResponse = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "notetaker child",
        prompt: "change notetaker",
        workspace_kind: "repo",
        repo,
        parent_task_id: portfolio.id,
      }),
    });
    expect(await childResponse.json()).toMatchObject({
      parent_task_id: portfolio.id,
      dispatch_mode: "orchestrated",
      worker_provider: "codex",
      model: "gpt-5.6-sol",
      reasoning_effort: "xhigh",
      priority: 1,
    });
    const duplicateResponse = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "duplicate notetaker child",
        prompt: "do not duplicate work",
        workspace_kind: "repo",
        repo,
        parent_task_id: portfolio.id,
      }),
    });
    expect(duplicateResponse.status).toBe(409);

    const scratchResponse = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "triage",
        prompt: "inspect Kubernetes",
        workspace_kind: "scratch",
        worker_provider: "codex",
      }),
    });
    const scratch = (await scratchResponse.json()) as {
      repo: string;
      workspace_kind: string;
      open_pr: number;
    };
    expect(scratch).toMatchObject({ workspace_kind: "scratch", open_pr: 0 });
    expect(scratch.repo.startsWith(path.join(process.env.CC_DATA_DIR!, "scratch"))).toBe(true);
    expect(fs.statSync(scratch.repo).mode & 0o777).toBe(0o700);
  });

  it("recreates a missing scratch workspace when a terminal task is requeued", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const { removeScratchWorkspace } = await import("../src/daemon/workspaces.js");
    const { updateTask } = await import("../src/db/tasks.js");
    const app = buildApp();
    const createdResponse = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "retry investigation",
        prompt: "inspect it",
        workspace_kind: "scratch",
      }),
    });
    const created = (await createdResponse.json()) as { id: number; repo: string };
    updateTask(created.id, { status: "failed" });
    removeScratchWorkspace(created.repo);

    const response = await app.request(`/api/tasks/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "queued" }),
    });
    const requeued = (await response.json()) as { repo: string; status: string };
    expect(response.status).toBe(200);
    expect(requeued.status).toBe("queued");
    expect(requeued.repo).not.toBe(created.repo);
    expect(fs.statSync(requeued.repo).isDirectory()).toBe(true);
  });

  it("keeps portfolio children inside the selected root", async () => {
    const otherRoot = path.join(tmpDir, "other-repos");
    const otherRepo = path.join(otherRoot, "other");
    fs.mkdirSync(path.join(otherRepo, ".git"), { recursive: true });
    process.env.CC_REPO_ROOTS = `${root}${path.delimiter}${otherRoot}`;
    const { buildApp } = await import("../src/daemon/api.js");
    const app = buildApp();
    const parentResponse = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "root-scoped",
        prompt: "change repositories under one root",
        workspace_kind: "portfolio",
        repo_root: root,
      }),
    });
    const parent = (await parentResponse.json()) as { id: number };
    const childResponse = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "outside child",
        prompt: "should fail",
        workspace_kind: "repo",
        repo: otherRepo,
        parent_task_id: parent.id,
      }),
    });
    expect(childResponse.status).toBe(400);
    expect(await childResponse.json()).toMatchObject({
      error: "child repository is outside the parent repository root",
    });

    const validChildResponse = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "inside child",
        prompt: "start inside the selected root",
        workspace_kind: "repo",
        repo,
        parent_task_id: parent.id,
      }),
    });
    const validChild = (await validChildResponse.json()) as { id: number };
    expect(validChildResponse.status).toBe(201);

    const moveResponse = await app.request(`/api/tasks/${validChild.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: otherRepo }),
    });
    expect(moveResponse.status).toBe(400);
    expect(await moveResponse.json()).toMatchObject({
      error: "child repository is outside the parent repository root",
    });
  });

  it("rejects explicit repositories outside the allow-list", async () => {
    const outside = path.join(tmpDir, "outside");
    fs.mkdirSync(path.join(outside, ".git"), { recursive: true });
    const { buildApp } = await import("../src/daemon/api.js");
    const response = await buildApp().request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "bad",
        prompt: "bad",
        workspace_kind: "repo",
        repo: outside,
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "repository is not an allowed Git root",
    });
  });

  it("preserves explicit absolute-path tasks when no repository roots are configured", async () => {
    delete process.env.CC_REPO_ROOTS;
    const { buildApp } = await import("../src/daemon/api.js");
    const response = await buildApp().request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "compatible cloud task",
        prompt: "use the existing repository path",
        workspace_kind: "repo",
        repo,
      }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      repo,
      workspace_kind: "repo",
      dispatch_mode: "orchestrated",
    });
  });

  it("skips triage delegation for a task main filed itself", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    const main = createAgent({ kind: "main", state: "idle" });
    const response = await buildApp().request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "main's own task",
        prompt: "do the work",
        workspace_kind: "repo",
        repo,
        agent_id: main.id,
      }),
    });
    expect(response.status).toBe(201);
    // Main already knows about a task it created; it must not be pinged to
    // triage it — neither delivered nor left awaiting.
    const kinds = listEvents(10).map((event) => event.kind);
    expect(kinds).not.toContain("task.awaiting_main");
    expect(kinds).not.toContain("task.delegated_to_main");
  });

  it("delegates a human-submitted task with no creating agent", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const { listEvents } = await import("../src/db/events.js");
    const response = await buildApp().request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "human task",
        prompt: "do the work",
        workspace_kind: "repo",
        repo,
      }),
    });
    expect(response.status).toBe(201);
    // No live main is available, so delegation is attempted and left awaiting.
    const events = listEvents(10);
    expect(events.map((event) => event.kind)).toContain("task.awaiting_main");
    const created = events.find((event) => event.kind === "task.created")!;
    expect(JSON.parse(created.payload!).creator_kind).toBe(null);
  });

  it("delegates a worker-filed follow-up and records the worker as creator", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    const worker = createAgent({ kind: "worker", state: "working" });
    const response = await buildApp().request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "follow-up",
        prompt: "do the work",
        workspace_kind: "repo",
        repo,
        agent_id: worker.id,
      }),
    });
    expect(response.status).toBe(201);
    // Worker-filed follow-ups genuinely need main's triage.
    const events = listEvents(10);
    expect(events.map((event) => event.kind)).toContain("task.awaiting_main");
    const created = events.find((event) => event.kind === "task.created")!;
    expect(JSON.parse(created.payload!).creator_kind).toBe("worker");
  });

  it("ignores an unknown creator id and treats it as a human submission", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const { listEvents } = await import("../src/db/events.js");
    const response = await buildApp().request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "stale id task",
        prompt: "do the work",
        workspace_kind: "repo",
        repo,
        agent_id: 9999,
      }),
    });
    expect(response.status).toBe(201);
    const events = listEvents(10);
    expect(events.map((event) => event.kind)).toContain("task.awaiting_main");
    const created = events.find((event) => event.kind === "task.created")!;
    expect(JSON.parse(created.payload!).creator_kind).toBe(null);
  });
});
