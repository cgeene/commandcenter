import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/agents is the human's direct spawn path, and the human outranks the
 * orchestrator: it must accept an orchestrated task the dashboard's "▶ Spawn
 * Worker" button targets, and refuse only a portfolio parent.
 */

const spawnWorker = vi.fn((taskId: number) => ({
  agent: { id: 1, kind: "worker" },
  task: { id: taskId, status: "in_progress" },
}));

vi.mock("../src/daemon/spawn.js", () => ({
  spawnWorker: (...args: unknown[]) =>
    (spawnWorker as unknown as (...a: unknown[]) => unknown)(...args),
  spawnMain: vi.fn(),
  spawnReviewer: vi.fn(),
  cancelTask: vi.fn(),
  killAgent: vi.fn(),
  paneAgeSeconds: vi.fn(() => 0),
  TaskCancellationValidationError: class extends Error {},
}));

let tmpDir: string;
let repo: string;

beforeEach(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-spawn-api-")));
  process.env.CC_DATA_DIR = path.join(tmpDir, "data");
  repo = path.join(tmpDir, "repos", "notetaker");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  process.env.CC_REPO_ROOTS = path.join(tmpDir, "repos");
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  spawnWorker.mockClear();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  delete process.env.CC_REPO_ROOTS;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("POST /api/agents", () => {
  it("spawns a queued orchestrated task — dispatch_mode is not a restriction", async () => {
    const { createTask } = await import("../src/db/tasks.js");
    const task = createTask({
      title: "ship it",
      prompt: "do the work",
      repo,
      dispatch_mode: "orchestrated",
    });
    const { buildApp } = await import("../src/daemon/api.js");

    const res = await buildApp().request("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task_id: task.id }),
    });
    expect(res.status).toBe(201);
    expect(spawnWorker).toHaveBeenCalledWith(task.id, undefined, expect.anything());
  });

  it("refuses a portfolio parent, which is split into children instead", async () => {
    const { createTask } = await import("../src/db/tasks.js");
    const task = createTask({
      title: "sweep every repo",
      prompt: "do the work",
      repo: path.join(tmpDir, "repos"),
      workspace_kind: "portfolio",
      dispatch_mode: "orchestrated",
    });
    const { buildApp } = await import("../src/daemon/api.js");

    const res = await buildApp().request("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task_id: task.id }),
    });
    expect(res.status).toBe(409);
    expect(spawnWorker).not.toHaveBeenCalled();
  });
});
