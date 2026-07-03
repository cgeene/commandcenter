import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-test-"));
  process.env.CC_DATA_DIR = tmpDir;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("task queue", () => {
  it("creates and lists tasks ordered by priority", async () => {
    const { createTask, listTasks } = await import("../src/db/tasks.js");
    createTask({ title: "low", prompt: "x", repo: "/r", priority: 3 });
    createTask({ title: "high", prompt: "x", repo: "/r", priority: 0 });
    const tasks = listTasks("queued");
    expect(tasks.map((t) => t.title)).toEqual(["high", "low"]);
  });

  it("claims atomically — second claim loses", async () => {
    const { createTask, claimTask } = await import("../src/db/tasks.js");
    const t = createTask({ title: "t", prompt: "x", repo: "/r" });
    expect(claimTask(t.id)?.status).toBe("claimed");
    expect(claimTask(t.id)).toBeUndefined();
  });

  it("readyTasks excludes tasks with open blockers", async () => {
    const { createTask, readyTasks, updateTask } = await import(
      "../src/db/tasks.js"
    );
    const a = createTask({ title: "a", prompt: "x", repo: "/r" });
    const b = createTask({
      title: "b",
      prompt: "x",
      repo: "/r",
      blocked_by: a.id,
    });
    expect(readyTasks().map((t) => t.id)).toEqual([a.id]);
    updateTask(a.id, { status: "done" });
    expect(readyTasks().map((t) => t.id)).toEqual([b.id]);
  });

  it("rejects invalid status updates", async () => {
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const t = createTask({ title: "t", prompt: "x", repo: "/r" });
    expect(() =>
      updateTask(t.id, { status: "bogus" as never }),
    ).toThrow(/invalid status/);
  });
});

describe("api", () => {
  it("serves tasks end-to-end", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const app = buildApp();
    const create = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "t1", prompt: "do it", repo: "/r" }),
    });
    expect(create.status).toBe(201);
    const task = (await create.json()) as { id: number; status: string };
    expect(task.status).toBe("queued");

    const claim = await app.request(`/api/tasks/${task.id}/claim`, {
      method: "POST",
    });
    expect(claim.status).toBe(200);
    const conflict = await app.request(`/api/tasks/${task.id}/claim`, {
      method: "POST",
    });
    expect(conflict.status).toBe(409);
  });

  it("validates task creation", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const app = buildApp();
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "" }),
    });
    expect(res.status).toBe(400);
  });
});
