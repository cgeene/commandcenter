import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  blockerChainReaches,
  blockerEffect,
  blockerNote,
  parseBlockedByFlag,
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

describe("CLI --blocked-by parsing", () => {
  it("accepts a positive task id", () => {
    expect(parseBlockedByFlag("9")).toBe(9);
    expect(parseBlockedByFlag(" 9 ")).toBe(9);
  });

  it("treats the clear verbs as null", () => {
    for (const verb of ["none", "NONE", "null", ""]) {
      expect(parseBlockedByFlag(verb)).toBeNull();
    }
  });

  it("rejects anything that is not an id or a clear verb", () => {
    for (const bad of ["abc", "#9", "tsk-9", "9,10", "9.5", "-1", "0", "1e3"]) {
      expect(() => parseBlockedByFlag(bad)).toThrow(/positive task id/);
    }
  });

  it("an unparseable id never reaches the API, so the blocker survives", async () => {
    const { createTask, getTask } = await import("../src/db/tasks.js");
    const blocker = createTask({ title: "b", prompt: "x", repo: "/r" });
    const dependent = createTask({
      title: "d",
      prompt: "x",
      repo: "/r",
      blocked_by: blocker.id,
    });

    // The hazard this guard exists for: Number("abc") is NaN, JSON.stringify
    // turns NaN into null, and blocked_by is nullable — so an unvalidated typo
    // would land as an explicit CLEAR.
    expect(JSON.stringify({ blocked_by: Number("abc") })).toBe('{"blocked_by":null}');
    expect((await patch(dependent.id, { blocked_by: null })).status).toBe(200);
    expect(getTask(dependent.id)?.blocked_by).toBeNull();

    // With the guard, the CLI throws before any request is built.
    const restored = createTask({
      title: "d2",
      prompt: "x",
      repo: "/r",
      blocked_by: blocker.id,
    });
    expect(() => parseBlockedByFlag("abc")).toThrow(/positive task id/);
    expect(getTask(restored.id)?.blocked_by).toBe(blocker.id);
  });
});

describe("updateTask blocked_by", () => {
  // The five ways a blocker assignment is refused at the DB layer. One test
  // rather than five near-identical ones: each is "this call throws, and the
  // graph is left exactly as it was". Kept SEPARATE from the API-layer cases,
  // which assert a different job — translating these throws into 409 rather than
  // a 500, with the error text the UI shows.
  it("refuses every invalid blocker shape, leaving the graph untouched", async () => {
    const { createTask, getTask, updateTask } = await import("../src/db/tasks.js");
    const mk = (over: Record<string, unknown> = {}) =>
      createTask({ title: "t", prompt: "x", repo: "/r", ...over });

    const self = mk();
    expect(() => updateTask(self.id, { blocked_by: self.id })).toThrow(
      /cannot be blocked by itself/,
    );
    // still usable afterwards, and still unblocked
    expect(updateTask(self.id, { priority: 1 })?.blocked_by).toBeNull();

    const a = mk({ title: "a" });
    const b2 = mk({ title: "b" });
    updateTask(b2.id, { blocked_by: a.id });
    expect(() => updateTask(a.id, { blocked_by: b2.id })).toThrow(/dependency cycle/);
    expect(getTask(a.id)?.blocked_by).toBeNull();

    // a longer chain: c1 <- c2 <- c3, then c1 -> c3 would close the loop
    const c1 = mk({ title: "c1" });
    const c2 = mk({ title: "c2", blocked_by: c1.id });
    const c3 = mk({ title: "c3", blocked_by: c2.id });
    expect(() => updateTask(c1.id, { blocked_by: c3.id })).toThrow(/dependency cycle/);

    // unknown blocker, caught before the FK constraint would fire — on both paths
    const u = mk();
    expect(() => updateTask(u.id, { blocked_by: 9999 })).toThrow(/does not exist/);
    expect(() => mk({ blocked_by: 4242 })).toThrow(/does not exist/);
  });

  it("sets and clears a blocker", async () => {
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const a = createTask({ title: "a", prompt: "x", repo: "/r" });
    const b = createTask({ title: "b", prompt: "x", repo: "/r" });

    expect(updateTask(b.id, { blocked_by: a.id })?.blocked_by).toBe(a.id);
    expect(updateTask(b.id, { blocked_by: null })?.blocked_by).toBeNull();
  });

  it("still allows a diamond — two tasks waiting on the same blocker", async () => {
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const a = createTask({ title: "a", prompt: "x", repo: "/r" });
    const b = createTask({ title: "b", prompt: "x", repo: "/r" });
    const c = createTask({ title: "c", prompt: "x", repo: "/r" });

    expect(updateTask(b.id, { blocked_by: a.id })?.blocked_by).toBe(a.id);
    expect(updateTask(c.id, { blocked_by: a.id })?.blocked_by).toBe(a.id);
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
  // The same refusals through the API, one row each. What this layer adds over
  // the DB tests is the STATUS mapping (409 for a graph conflict, 400 for a
  // schema violation — never a 500) and the error text; the graph-untouched
  // checks ride along so a refusal can never half-apply.
  it("maps every blocker refusal to the right status without touching the graph", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const { createTask, getTask } = await import("../src/db/tasks.js");
    const mk = (over: Record<string, unknown> = {}) =>
      createTask({ title: "t", prompt: "x", repo: "/r", ...over });

    for (const { why, build, status, error } of [
      {
        why: "a self-block",
        build: () => {
          const t = mk();
          return { id: t.id, body: { blocked_by: t.id }, stillUnblocked: t.id };
        },
        status: 409,
        error: /cannot be blocked by itself/,
      },
      {
        why: "a cycle",
        build: () => {
          const x = mk({ title: "x" });
          const y = mk({ title: "y", blocked_by: x.id });
          return { id: x.id, body: { blocked_by: y.id }, stillUnblocked: x.id };
        },
        status: 409,
        error: /dependency cycle/,
      },
      {
        why: "an unknown blocker",
        build: () => ({ id: mk().id, body: { blocked_by: 4242 }, stillUnblocked: undefined }),
        status: 409,
        error: /does not exist/,
      },
      {
        why: "a non-positive blocker id (schema, not graph)",
        build: () => ({ id: mk().id, body: { blocked_by: 0 }, stillUnblocked: undefined }),
        status: 400,
        error: undefined,
      },
    ]) {
      const { id, body, stillUnblocked } = build();
      const res = await patch(id, body);
      expect(res.status, why).toBe(status);
      if (error) {
        expect(((await res.json()) as { error: string }).error, why).toMatch(error);
      }
      if (stillUnblocked !== undefined) {
        expect(getTask(stillUnblocked)?.blocked_by, why).toBeNull();
      }
    }

    // The create path refuses the same way, with the same status.
    const created = await buildApp().request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "t", prompt: "x", repo: "/r", blocked_by: 77 }),
    });
    expect(created.status).toBe(409);
  });

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

  it("accepts an already-done blocker and leaves the task ready", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const a = createTask({ title: "a", prompt: "x", repo: "/r" });
    const b = createTask({ title: "b", prompt: "x", repo: "/r" });
    updateTask(a.id, { status: "done" });

    const res = await patch(b.id, { blocked_by: a.id });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { blocked_by: number | null }).blocked_by).toBe(a.id);

    // already-satisfied: recording the dependency must not park the task
    const ready = (await (await buildApp().request("/api/tasks?ready=true")).json()) as {
      id: number;
    }[];
    expect(ready.map((t) => t.id)).toEqual([b.id]);
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
