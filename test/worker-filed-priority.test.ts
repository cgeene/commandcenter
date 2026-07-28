/**
 * Worker-filed tasks are capped at the low-priority floor (see
 * src/lib/task-priority.ts) so a follow-up can never jump ahead of the queue
 * the human and the orchestrator have already sequenced. Exercised through the
 * API because that is the only layer that knows who filed the task.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearComposer } from "./fixtures/pane.js";

// A live main with an empty composer, so the one test that checks the triage
// text sees a real delivery. The tasks filed before a main exists still take the
// "no live main" path.
const sendText = vi.fn(async () => {});
vi.mock("../src/daemon/tmux.js", () => ({
  windowExists: () => true,
  capturePane: () => clearComposer(),
  sendText: (...args: unknown[]) => sendText(...args),
  sendEnter: vi.fn(),
}));

let tmpDir: string;
let root: string;
let repo: string;

beforeEach(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-worker-priority-")));
  process.env.CC_DATA_DIR = path.join(tmpDir, "data");
  root = path.join(tmpDir, "repos");
  repo = path.join(root, "notetaker");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  process.env.CC_REPO_ROOTS = root;
  sendText.mockClear();
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  delete process.env.CC_REPO_ROOTS;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A worker mid-task: its own task at `priority`, and the agent running it. */
async function workingWorker(priority: number) {
  const { createTask } = await import("../src/db/tasks.js");
  const { createAgent } = await import("../src/db/agents.js");
  const parent = createTask({
    title: "the work that spawned the follow-up",
    prompt: "do the work",
    repo,
    priority,
  });
  const agent = createAgent({ kind: "worker", state: "working", task_id: parent.id });
  return { parent, agent };
}

async function fileTask(body: Record<string, unknown>) {
  const { buildApp } = await import("../src/daemon/api.js");
  const response = await buildApp().request("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "follow-up",
      prompt: "the hardening we noticed",
      workspace_kind: "repo",
      repo,
      ...body,
    }),
  });
  return { response, task: (await response.json()) as { id: number; priority: number } };
}

async function createdPayload(taskId: number) {
  const { listEvents } = await import("../src/db/events.js");
  const created = listEvents(50).find(
    (event) => event.kind === "task.created" && event.task_id === taskId,
  )!;
  return JSON.parse(created.payload!) as Record<string, unknown>;
}

describe("worker-filed task priority", () => {
  it("clamps an urgent worker request to the floor and records the request", async () => {
    const { agent } = await workingWorker(2);
    const { response, task } = await fileTask({ priority: 1, agent_id: agent.id });
    expect(response.status).toBe(201);
    expect(task.priority).toBe(3);
    expect(await createdPayload(task.id)).toMatchObject({
      creator_kind: "worker",
      requested_priority: 1,
      granted_priority: 3,
    });
  });

  it("defaults a worker follow-up to the floor when it requests nothing", async () => {
    const { agent } = await workingWorker(2);
    const { task } = await fileTask({ agent_id: agent.id });
    expect(task.priority).toBe(3);
    // Nothing was overruled, so there is no request to report.
    const payload = await createdPayload(task.id);
    expect(payload.requested_priority).toBeUndefined();
    expect(payload.granted_priority).toBeUndefined();
  });

  it("keeps a follow-up at the filer's own priority when that is lower", async () => {
    const { agent } = await workingWorker(4);
    const { task } = await fileTask({ agent_id: agent.id });
    expect(task.priority).toBe(4);
  });

  it("lets a worker file something less urgent than the floor", async () => {
    const { agent } = await workingWorker(2);
    const { task } = await fileTask({ priority: 4, agent_id: agent.id });
    expect(task.priority).toBe(4);
    expect((await createdPayload(task.id)).requested_priority).toBeUndefined();
  });

  it("leaves the orchestrator's requested priority alone", async () => {
    const { createAgent } = await import("../src/db/agents.js");
    const main = createAgent({ kind: "main", state: "idle" });
    const { task } = await fileTask({ priority: 0, agent_id: main.id });
    expect(task.priority).toBe(0);
    expect((await createdPayload(task.id)).requested_priority).toBeUndefined();
  });

  it("leaves a human submission alone", async () => {
    const { task } = await fileTask({ priority: 1 });
    expect(task.priority).toBe(1);
    const { task: defaulted } = await fileTask({ title: "no priority given" });
    expect(defaulted.priority).toBe(2);
  });

  it("clamps the priority a worker would inherit from a portfolio parent", async () => {
    const { agent } = await workingWorker(2);
    const { buildApp } = await import("../src/daemon/api.js");
    const app = buildApp();
    const parentResponse = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "urgent portfolio work",
        prompt: "sweep every repo",
        workspace_kind: "portfolio",
        repo_root: root,
        priority: 0,
      }),
    });
    const portfolio = (await parentResponse.json()) as { id: number };
    const { task } = await fileTask({
      agent_id: agent.id,
      parent_task_id: portfolio.id,
    });
    expect(task.priority).toBe(3);
    expect(await createdPayload(task.id)).toMatchObject({
      requested_priority: 0,
      granted_priority: 3,
    });
  });

  it("tells the orchestrator at triage what the worker asked for", async () => {
    const { agent } = await workingWorker(2);
    const { task } = await fileTask({ priority: 1, agent_id: agent.id });
    const { delegateTaskToMainDetailed } = await import("../src/daemon/orchestration.js");
    const { createAgent } = await import("../src/db/agents.js");
    const main = createAgent({ kind: "main", state: "idle", tmux_target: "cc:@1" });
    expect(await delegateTaskToMainDetailed(task.id, main)).toBe("delivered");
    expect(sendText).toHaveBeenCalledWith(
      main.tmux_target,
      expect.stringContaining("asked for priority 1"),
      expect.anything(),
    );
    expect(sendText.mock.calls[0][1]).toContain("queued at 3");
  });

  it("says nothing about priority when the worker's request stood", async () => {
    const { agent } = await workingWorker(2);
    const { task } = await fileTask({ agent_id: agent.id });
    const { delegateTaskToMainDetailed } = await import("../src/daemon/orchestration.js");
    const { createAgent } = await import("../src/db/agents.js");
    const main = createAgent({ kind: "main", state: "idle", tmux_target: "cc:@1" });
    expect(await delegateTaskToMainDetailed(task.id, main)).toBe("delivered");
    expect(sendText.mock.calls[0][1]).toContain("worker-filed follow-up");
    expect(sendText.mock.calls[0][1]).not.toContain("asked for priority");
  });
});
