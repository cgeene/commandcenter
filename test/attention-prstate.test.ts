import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The "Needs You" panel resolves PR lifecycle from the persisted pr_state
 * column only. These tests pin the two properties the 2026-07-28 ghost-item
 * incident violated: an unresolvable state must fail CLOSED, and computing the
 * panel must never shell out to `gh`.
 */

// Every child-process entry point the daemon uses, spied on so a reintroduced
// `gh` call inside computeAttention fails the suite instead of hitting GitHub.
const proc = vi.hoisted(() => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, ...proc };
});

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-attention-prstate-"));
  process.env.CC_DATA_DIR = tmpDir;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  proc.execFile.mockClear();
  proc.execFileSync.mockClear();
  proc.spawn.mockClear();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // The unknown-state latch is module state; a fresh DB reuses task ids.
  const { _resetPrStateLatch } = await import("../src/daemon/attention.js");
  _resetPrStateLatch();
});

/** An approved task with a PR awaiting a human merge. `pr_state` is left NULL
 *  (never synced) unless the caller sets it. */
async function approvedPrTask(pr_state?: string | null) {
  const { createTask, updateTask } = await import("../src/db/tasks.js");
  const t = createTask({ title: "ship it", prompt: "do a thing", repo: "/r" });
  return updateTask(t.id, {
    status: "review",
    review_verdict: "approve",
    result_summary: "implemented X",
    pr_url: `https://github.com/nylas/repo/pull/${t.id}`,
    ...(pr_state === undefined ? {} : { pr_state }),
  })!;
}

async function mergeItems() {
  const { computeAttention } = await import("../src/daemon/attention.js");
  return (await computeAttention()).filter((i) => i.kind === "merge_pr");
}

async function unknownEvents(taskId: number) {
  const { countTaskEvents } = await import("../src/db/events.js");
  return countTaskEvents(taskId, "attention.pr_state_unknown");
}

describe("normalizePrState — the single casing boundary", () => {
  // The one casing boundary in the system: gh speaks UPPERCASE, the column stores
  // lowercase. Anything unrecognized must be null so callers fail CLOSED rather
  // than treating it as open.
  it("folds recognized states to lowercase and everything else to null", async () => {
    const { normalizePrState } = await import("../src/lib/prstate.js");
    for (const [raw, want] of [
      ["OPEN", "open"],
      ["MERGED", "merged"],
      ["CLOSED", "closed"],
      ["open", "open"],
      ["merged", "merged"],
      ["closed", "closed"],
      [" Merged ", "merged"],
      [null, null],
      [undefined, null],
      ["", null],
      ["unknown", null],
      ["DRAFT", null],
    ] as [string | null | undefined, string | null][]) {
      expect(normalizePrState(raw), String(raw)).toBe(want);
    }
  });

  it("prsync persists the lowercase form gh's UPPERCASE state maps to", async () => {
    const { recordSyncSuccess } = await import("../src/daemon/prsync.js");
    const { getTask } = await import("../src/db/tasks.js");
    const t = await approvedPrTask();
    recordSyncSuccess(t.id, { state: "MERGED", reviewDecision: null, comments: [] });
    expect(getTask(t.id)!.pr_state).toBe("merged");
  });
});

describe("computeAttention — PR lifecycle from the persisted column", () => {
  it("surfaces a merge item for a PR the column says is open", async () => {
    const t = await approvedPrTask("open");
    const items = await mergeItems();
    expect(items).toHaveLength(1);
    expect(items[0].task_id).toBe(t.id);
    expect(await unknownEvents(t.id)).toBe(0);
  });

  it("hides a merged or closed PR", async () => {
    await approvedPrTask("merged");
    await approvedPrTask("closed");
    expect(await mergeItems()).toHaveLength(0);
  });

  it("normalizes casing on read: an UPPERCASE column value behaves identically", async () => {
    // The guard for the mismatch this incident could have shipped — prsync
    // writes lowercase, gh speaks UPPERCASE. Either spelling must resolve.
    const merged = await approvedPrTask("MERGED");
    const open = await approvedPrTask("OPEN");
    const items = await mergeItems();
    expect(items.map((i) => i.task_id)).toEqual([open.id]);
    expect(await unknownEvents(merged.id)).toBe(0);
    expect(await unknownEvents(open.id)).toBe(0);
  });
});

describe("computeAttention — unknown PR state fails closed", () => {
  it("withholds the item and logs the situation once when the state is unknown", async () => {
    const t = await approvedPrTask(null);
    expect(await mergeItems()).toHaveLength(0);
    expect(await unknownEvents(t.id)).toBe(1);
    // The dashboard polls every couple of seconds — one event per episode, not
    // one per poll.
    await mergeItems();
    await mergeItems();
    expect(await unknownEvents(t.id)).toBe(1);
  });

  it("withholds the item for an unrecognized state too", async () => {
    const t = await approvedPrTask("unknown");
    expect(await mergeItems()).toHaveLength(0);
    expect(await unknownEvents(t.id)).toBe(1);
  });

  it("never floods: a whole history of merged PRs stays out of the panel", async () => {
    // The incident shape — many approved tasks, cold process, gh unavailable.
    // The column is what answers now, so the panel stays empty.
    for (let i = 0; i < 20; i++) await approvedPrTask("merged");
    expect(await mergeItems()).toHaveLength(0);
  });

  it("re-arms the latch: the item returns once prsync resolves the state", async () => {
    const { updateTask } = await import("../src/db/tasks.js");
    const t = await approvedPrTask(null);
    expect(await mergeItems()).toHaveLength(0);
    expect(await unknownEvents(t.id)).toBe(1);

    updateTask(t.id, { pr_state: "open" });
    expect(await mergeItems()).toHaveLength(1);
    expect(await unknownEvents(t.id)).toBe(1); // resolved, nothing new to say

    updateTask(t.id, { pr_state: null });
    expect(await mergeItems()).toHaveLength(0);
    expect(await unknownEvents(t.id)).toBe(2); // a fresh episode is worth logging
  });
});

describe("computeAttention — no gh burst", () => {
  it("spawns no child process, however many PRs are in play", async () => {
    // The cold-start burst was one `gh pr view` per approved PR, all at once.
    // Reading a column cannot burst: assert zero process spawns outright.
    for (let i = 0; i < 10; i++) await approvedPrTask(i % 2 ? "open" : null);
    proc.execFile.mockClear();
    proc.execFileSync.mockClear();
    proc.spawn.mockClear();

    await mergeItems();

    expect(proc.execFile).not.toHaveBeenCalled();
    expect(proc.execFileSync).not.toHaveBeenCalled();
    expect(proc.spawn).not.toHaveBeenCalled();
  });
});
