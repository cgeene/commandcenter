import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PrState } from "../src/daemon/prsync.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-prsync-"));
  process.env.CC_DATA_DIR = tmpDir;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function setupPrTask() {
  const { createTask, updateTask } = await import("../src/db/tasks.js");
  const { createAgent } = await import("../src/db/agents.js");
  const task = createTask({ title: "t", prompt: "x", repo: "/r" });
  const worker = createAgent({ kind: "worker", state: "idle", task_id: task.id });
  updateTask(task.id, {
    status: "review",
    agent_id: worker.id,
    branch: `agent/task-${task.id}`,
    pr_url: "https://github.com/nylas/unicorn-k8s/pull/2198",
  });
  return { task, worker };
}

const open = (over: Partial<PrState> = {}): PrState => ({
  state: "OPEN",
  reviewDecision: null,
  comments: [],
  ...over,
});

describe("parsePrUrl", () => {
  it("parses a GitHub PR url", async () => {
    const { parsePrUrl } = await import("../src/daemon/prsync.js");
    expect(parsePrUrl("https://github.com/nylas/unicorn-k8s/pull/2198")).toEqual({
      owner: "nylas",
      repo: "unicorn-k8s",
      number: 2198,
    });
    expect(parsePrUrl("https://gitlab.com/x/y/pull/1")).toBeUndefined();
  });
});

describe("applyPrState", () => {
  it("merged PR completes the task", async () => {
    const { applyPrState } = await import("../src/daemon/prsync.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { task } = await setupPrTask();
    await applyPrState(task.id, open({ state: "MERGED" }));
    expect(getTask(task.id)?.status).toBe("done");
    expect(listEvents(10).map((e) => e.kind)).toContain("pr.merged");
  });

  it("closed-unmerged PR blocks the task", async () => {
    const { applyPrState } = await import("../src/daemon/prsync.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { task } = await setupPrTask();
    await applyPrState(task.id, open({ state: "CLOSED" }));
    const t = getTask(task.id)!;
    expect(t.status).toBe("blocked");
    expect(t.review_notes).toContain("closed without merging");
  });

  it("new comments requeue a dead worker's task with the feedback as notes", async () => {
    const { applyPrState } = await import("../src/daemon/prsync.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { task } = await setupPrTask();
    await applyPrState(
      task.id,
      open({
        comments: [
          { author: "caleb", body: "use a data source here", created_at: "2026-07-04T02:00:00Z" },
        ],
      }),
    );
    const t = getTask(task.id)!;
    expect(t.status).toBe("queued");
    expect(t.review_notes).toContain("use a data source here");
    expect(t.pr_feedback_at).toBe("2026-07-04T02:00:00Z");
  });

  it("already-forwarded comments are not re-sent", async () => {
    const { applyPrState } = await import("../src/daemon/prsync.js");
    const { getTask, updateTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { task } = await setupPrTask();
    updateTask(task.id, { pr_feedback_at: "2026-07-04T02:00:00Z" });
    await applyPrState(
      task.id,
      open({
        comments: [
          { author: "caleb", body: "old comment", created_at: "2026-07-04T01:00:00Z" },
        ],
      }),
    );
    expect(getTask(task.id)?.status).toBe("review"); // untouched
    expect(listEvents(10).map((e) => e.kind)).not.toContain("pr.feedback");
  });

  it("does nothing for tasks not in review", async () => {
    const { applyPrState } = await import("../src/daemon/prsync.js");
    const { getTask, updateTask } = await import("../src/db/tasks.js");
    const { task } = await setupPrTask();
    updateTask(task.id, { status: "done" });
    await applyPrState(task.id, open({ state: "MERGED" }));
    expect(getTask(task.id)?.status).toBe("done");
  });
});
