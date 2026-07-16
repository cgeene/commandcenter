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

  it("preserves legacy direct/repository defaults and stores orchestration metadata", async () => {
    const { createTask } = await import("../src/db/tasks.js");
    expect(createTask({ title: "legacy", prompt: "x", repo: "/r" })).toMatchObject({
      workspace_kind: "repo",
      dispatch_mode: "direct",
      parent_task_id: null,
    });
    expect(
      createTask({
        title: "new",
        prompt: "x",
        repo: "/root",
        workspace_kind: "portfolio",
        dispatch_mode: "orchestrated",
        open_pr: false,
      }),
    ).toMatchObject({
      workspace_kind: "portfolio",
      dispatch_mode: "orchestrated",
    });
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

  it("readyTasks can isolate direct scheduler work from main-orchestrated work", async () => {
    const { createTask, readyTasks } = await import("../src/db/tasks.js");
    const direct = createTask({ title: "direct", prompt: "x", repo: "/r" });
    const orchestrated = createTask({
      title: "main",
      prompt: "x",
      repo: "/r",
      dispatch_mode: "orchestrated",
    });
    expect(readyTasks("direct").map((task) => task.id)).toEqual([direct.id]);
    expect(readyTasks("orchestrated").map((task) => task.id)).toEqual([
      orchestrated.id,
    ]);
  });

  it("rejects invalid status updates", async () => {
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const t = createTask({ title: "t", prompt: "x", repo: "/r" });
    expect(() =>
      updateTask(t.id, { status: "bogus" as never }),
    ).toThrow(/invalid status/);
  });

  it("defaults open_pr to true", async () => {
    const { createTask } = await import("../src/db/tasks.js");
    const t = createTask({ title: "t", prompt: "x", repo: "/r" });
    expect(t.open_pr).toBe(1);
  });

  it("createTask respects open_pr: false", async () => {
    const { createTask } = await import("../src/db/tasks.js");
    const t = createTask({ title: "t", prompt: "x", repo: "/r", open_pr: false });
    expect(t.open_pr).toBe(0);
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

  it("creates a branch-only task via open_pr: false", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const app = buildApp();
    const create = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "t", prompt: "x", repo: "/r", open_pr: false }),
    });
    const task = (await create.json()) as { open_pr: number };
    expect(task.open_pr).toBe(0);
  });

  it("PATCH flips open_pr to false and back without erroring", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const app = buildApp();
    const create = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "t", prompt: "x", repo: "/r" }),
    });
    const task = (await create.json()) as { id: number };

    const off = await app.request(`/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ open_pr: false }),
    });
    expect(off.status).toBe(200);
    expect(((await off.json()) as { open_pr: number }).open_pr).toBe(0);

    // a PATCH that omits open_pr must not touch it (regression guard: binding
    // an explicit `undefined` for a NOT NULL column throws, per the
    // crons.enabled bug of the same shape)
    const untouched = await app.request(`/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ priority: 1 }),
    });
    expect(untouched.status).toBe(200);
    expect(((await untouched.json()) as { open_pr: number }).open_pr).toBe(0);

    const on = await app.request(`/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ open_pr: true }),
    });
    expect(((await on.json()) as { open_pr: number }).open_pr).toBe(1);
  });
});
