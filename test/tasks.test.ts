import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

let savedRepoRoots: string | undefined;
let savedRepoRoot: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-test-"));
  process.env.CC_DATA_DIR = tmpDir;
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

});

// block_cause names the gate holding a blocked task. Merge-safety decisions read
// it (review.blockedByReviewLoop), so the invariant it relies on is enforced
// here rather than at each of the half-dozen paths that block a task.
describe("block_cause", () => {
  async function blockedTask() {
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    updateTask(task.id, { status: "blocked", block_cause: "verify_failed" });
    return task.id;
  }

  it("is NULL until a task is blocked, and names the cause once it is", async () => {
    const { getTask } = await import("../src/db/tasks.js");
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    expect(getTask(task.id)!.block_cause).toBeNull();
    updateTask(task.id, { status: "blocked", block_cause: "pr_closed" });
    expect(getTask(task.id)!.block_cause).toBe("pr_closed");
  });

  it("clears the cause whenever the task leaves the blocked status", async () => {
    const { getTask, updateTask } = await import("../src/db/tasks.js");
    const id = await blockedTask();
    updateTask(id, { status: "queued" });
    expect(getTask(id)!.block_cause).toBeNull();
  });

  // The defect this exists for: a rejection at the review cycle cap re-blocks a
  // task a failing verify_cmd already blocked. Relabelling it would make the
  // block look like one a reviewer's approve is entitled to lift.
  it("keeps the original cause when an already-blocked task is blocked again", async () => {
    const { getTask, updateTask } = await import("../src/db/tasks.js");
    const id = await blockedTask();
    updateTask(id, { status: "blocked", block_cause: "review_loop" });
    expect(getTask(id)!.block_cause).toBe("verify_failed");
  });

  it("defaults to 'reported' when a blocking path names no cause", async () => {
    const { createTask, getTask, updateTask } = await import("../src/db/tasks.js");
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    updateTask(task.id, { status: "blocked" });
    expect(getTask(task.id)!.block_cause).toBe("reported");
  });

  it("ignores a cause sent without a status change", async () => {
    const { getTask, updateTask } = await import("../src/db/tasks.js");
    const id = await blockedTask();
    updateTask(id, { block_cause: "review_loop", priority: 1 });
    const t = getTask(id)!;
    expect(t.block_cause).toBe("verify_failed");
    expect(t.priority).toBe(1); // the rest of the patch still applied
  });

  it("rejects an unknown cause", async () => {
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    expect(() =>
      updateTask(task.id, {
        status: "blocked",
        block_cause: "made_up" as "verify_failed",
      }),
    ).toThrow(/invalid block cause/);
  });

  // An API PATCH must not be able to set the cause directly: it is derived from
  // the status transition, and a caller-supplied value could contradict it.
  it("is not settable through the task PATCH route", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const { getTask } = await import("../src/db/tasks.js");
    const app = buildApp();
    const id = await blockedTask();
    const res = await app.request(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ block_cause: "review_loop" }),
    });
    expect(res.status).toBeLessThan(500);
    expect(getTask(id)!.block_cause).toBe("verify_failed");
  });
});
