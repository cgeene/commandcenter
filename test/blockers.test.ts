import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  blockerChainReaches,
  blockerEffect,
  blockerNote,
} from "../src/lib/blockers.js";

let tmpDir: string;
let savedRepoRoots: string | undefined;
let savedRepoRoot: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-blockers-"));
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

async function patch(id: number, body: unknown) {
  const { buildApp } = await import("../src/daemon/api.js");
  return buildApp().request(`/api/tasks/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("blocker chain helpers", () => {
  it("detects a chain that leads back to the target", () => {
    const chain = new Map([
      [1, null],
      [2, 1],
      [3, 2],
    ]);
    const blockerOf = (id: number) => chain.get(id) ?? null;
    expect(blockerChainReaches(3, 1, blockerOf)).toBe(true);
    expect(blockerChainReaches(1, 3, blockerOf)).toBe(false);
  });

  it("terminates on a pre-existing cycle instead of looping forever", () => {
    const chain = new Map([
      [1, 2],
      [2, 1],
    ]);
    expect(blockerChainReaches(1, 99, (id) => chain.get(id) ?? null)).toBe(false);
  });

  it("classifies what a blocker's status means for the ready queue", () => {
    expect(blockerEffect("done")).toBe("already-satisfied");
    expect(blockerEffect("cancelled")).toBe("never-satisfied");
    expect(blockerEffect("failed")).toBe("never-satisfied");
    expect(blockerEffect("queued")).toBe("pending");
    expect(blockerEffect("in_progress")).toBe("pending");
    expect(blockerNote(7, "done")).toMatch(/already done/);
    expect(blockerNote(7, "cancelled")).toMatch(/never become done/);
  });
});

describe("updateTask blocked_by", () => {
  it("sets and clears a blocker", async () => {
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const a = createTask({ title: "a", prompt: "x", repo: "/r" });
    const b = createTask({ title: "b", prompt: "x", repo: "/r" });

    expect(updateTask(b.id, { blocked_by: a.id })?.blocked_by).toBe(a.id);
    expect(updateTask(b.id, { blocked_by: null })?.blocked_by).toBeNull();
  });

  it("rejects a task blocking on itself", async () => {
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const t = createTask({ title: "t", prompt: "x", repo: "/r" });
    expect(() => updateTask(t.id, { blocked_by: t.id })).toThrow(
      /cannot be blocked by itself/,
    );
    expect(updateTask(t.id, { priority: 1 })?.blocked_by).toBeNull();
  });

  it("rejects a two-task cycle", async () => {
    const { createTask, getTask, updateTask } = await import("../src/db/tasks.js");
    const a = createTask({ title: "a", prompt: "x", repo: "/r" });
    const b = createTask({ title: "b", prompt: "x", repo: "/r" });
    updateTask(b.id, { blocked_by: a.id });

    expect(() => updateTask(a.id, { blocked_by: b.id })).toThrow(
      /dependency cycle/,
    );
    expect(getTask(a.id)?.blocked_by).toBeNull();
  });

  it("rejects a longer cycle", async () => {
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const a = createTask({ title: "a", prompt: "x", repo: "/r" });
    const b = createTask({ title: "b", prompt: "x", repo: "/r", blocked_by: a.id });
    const c = createTask({ title: "c", prompt: "x", repo: "/r", blocked_by: b.id });

    expect(() => updateTask(a.id, { blocked_by: c.id })).toThrow(
      /dependency cycle/,
    );
  });

  it("still allows a diamond — two tasks waiting on the same blocker", async () => {
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const a = createTask({ title: "a", prompt: "x", repo: "/r" });
    const b = createTask({ title: "b", prompt: "x", repo: "/r" });
    const c = createTask({ title: "c", prompt: "x", repo: "/r" });

    expect(updateTask(b.id, { blocked_by: a.id })?.blocked_by).toBe(a.id);
    expect(updateTask(c.id, { blocked_by: a.id })?.blocked_by).toBe(a.id);
  });

  it("rejects an unknown blocker instead of failing at the FK constraint", async () => {
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const t = createTask({ title: "t", prompt: "x", repo: "/r" });
    expect(() => updateTask(t.id, { blocked_by: 9999 })).toThrow(/does not exist/);
  });

  it("createTask also rejects an unknown blocker", async () => {
    const { createTask } = await import("../src/db/tasks.js");
    expect(() =>
      createTask({ title: "t", prompt: "x", repo: "/r", blocked_by: 4242 }),
    ).toThrow(/does not exist/);
  });

  it("accepts a blocker that is already done — the task stays ready", async () => {
    const { createTask, readyTasks, updateTask } = await import("../src/db/tasks.js");
    const a = createTask({ title: "a", prompt: "x", repo: "/r" });
    const b = createTask({ title: "b", prompt: "x", repo: "/r" });
    updateTask(a.id, { status: "done" });

    expect(updateTask(b.id, { blocked_by: a.id })?.blocked_by).toBe(a.id);
    expect(readyTasks().map((t) => t.id)).toEqual([b.id]);
  });
});

describe("ready queue", () => {
  it("excludes a task blocked via update_task and releases it when the blocker completes", async () => {
    const { createTask, readyTasks, updateTask } = await import("../src/db/tasks.js");
    const a = createTask({ title: "a", prompt: "x", repo: "/r" });
    const b = createTask({ title: "b", prompt: "x", repo: "/r" });
    expect(readyTasks().map((t) => t.id)).toEqual([a.id, b.id]);

    updateTask(b.id, { blocked_by: a.id });
    expect(readyTasks().map((t) => t.id)).toEqual([a.id]);

    updateTask(a.id, { status: "done" });
    expect(readyTasks().map((t) => t.id)).toEqual([b.id]);
  });

  it("keeps a task with a cancelled blocker out of the ready queue", async () => {
    const { createTask, readyTasks, updateTask } = await import("../src/db/tasks.js");
    const a = createTask({ title: "a", prompt: "x", repo: "/r" });
    const b = createTask({ title: "b", prompt: "x", repo: "/r" });
    updateTask(b.id, { blocked_by: a.id });
    updateTask(a.id, { status: "cancelled" });
    expect(readyTasks().map((t) => t.id)).toEqual([]);
  });

  it("GET /api/tasks?ready=true honours a blocker set over the API", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const { createTask } = await import("../src/db/tasks.js");
    const a = createTask({ title: "a", prompt: "x", repo: "/r" });
    const b = createTask({ title: "b", prompt: "x", repo: "/r" });
    expect((await patch(b.id, { blocked_by: a.id })).status).toBe(200);

    const readyIds = async () =>
      ((await (await buildApp().request("/api/tasks?ready=true")).json()) as {
        id: number;
      }[]).map((t) => t.id);

    expect(await readyIds()).toEqual([a.id]);
    expect((await patch(a.id, { status: "done" })).status).toBe(200);
    expect(await readyIds()).toEqual([b.id]);
  });
});

describe("PATCH /api/tasks/:id blocked_by", () => {
  it("sets and clears the blocker", async () => {
    const { createTask } = await import("../src/db/tasks.js");
    const a = createTask({ title: "a", prompt: "x", repo: "/r" });
    const b = createTask({ title: "b", prompt: "x", repo: "/r" });

    const set = await patch(b.id, { blocked_by: a.id });
    expect(set.status).toBe(200);
    expect(((await set.json()) as { blocked_by: number | null }).blocked_by).toBe(a.id);

    const cleared = await patch(b.id, { blocked_by: null });
    expect(cleared.status).toBe(200);
    expect(
      ((await cleared.json()) as { blocked_by: number | null }).blocked_by,
    ).toBeNull();
  });

  it("rejects a self-block with 409", async () => {
    const { createTask, getTask } = await import("../src/db/tasks.js");
    const t = createTask({ title: "t", prompt: "x", repo: "/r" });
    const res = await patch(t.id, { blocked_by: t.id });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toEqual({
      error: `task #${t.id} cannot be blocked by itself`,
    });
    expect(getTask(t.id)?.blocked_by).toBeNull();
  });

  it("rejects a cycle with 409 and leaves the graph untouched", async () => {
    const { createTask, getTask } = await import("../src/db/tasks.js");
    const a = createTask({ title: "a", prompt: "x", repo: "/r" });
    const b = createTask({ title: "b", prompt: "x", repo: "/r", blocked_by: a.id });

    const res = await patch(a.id, { blocked_by: b.id });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /dependency cycle/,
    );
    expect(getTask(a.id)?.blocked_by).toBeNull();
    expect(getTask(b.id)?.blocked_by).toBe(a.id);
  });

  it("rejects an unknown blocker with 409", async () => {
    const { createTask } = await import("../src/db/tasks.js");
    const t = createTask({ title: "t", prompt: "x", repo: "/r" });
    const res = await patch(t.id, { blocked_by: 4242 });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /does not exist/,
    );
  });

  it("rejects a non-positive blocker id at the schema", async () => {
    const { createTask } = await import("../src/db/tasks.js");
    const t = createTask({ title: "t", prompt: "x", repo: "/r" });
    expect((await patch(t.id, { blocked_by: 0 })).status).toBe(400);
  });

  it("POST /api/tasks rejects an unknown blocker with 409", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const res = await buildApp().request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "t", prompt: "x", repo: "/r", blocked_by: 77 }),
    });
    expect(res.status).toBe(409);
  });
});

describe("cancel reporting", () => {
  it("still reports dependents pointed at the cancelled task over the API", async () => {
    const { cancelTask } = await import("../src/daemon/spawn.js");
    const { createTask } = await import("../src/db/tasks.js");
    const blocker = createTask({ title: "b", prompt: "x", repo: "/r" });
    const dependent = createTask({ title: "d", prompt: "x", repo: "/r" });
    expect((await patch(dependent.id, { blocked_by: blocker.id })).status).toBe(200);

    expect(cancelTask(blocker.id).open_dependents.map((t) => t.id)).toEqual([
      dependent.id,
    ]);
  });
});
