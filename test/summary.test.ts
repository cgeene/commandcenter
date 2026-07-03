import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-summary-"));
  process.env.CC_DATA_DIR = tmpDir;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const RANGE = {
  since: "2020-01-01T00:00:00.000Z",
  until: "2030-01-01T00:00:00.000Z",
};

describe("activity summary", () => {
  it("aggregates tasks, events, friction, and memories", async () => {
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const { logEvent } = await import("../src/db/events.js");
    const { addMemory } = await import("../src/db/memories.js");
    const { activitySummary } = await import("../src/daemon/summary.js");

    const t1 = createTask({ title: "done task", prompt: "x", repo: "/r" });
    updateTask(t1.id, { status: "done", result_summary: "shipped it" });
    const t2 = createTask({ title: "flaky task", prompt: "x", repo: "/r" });
    logEvent("verify.failed", { taskId: t2.id });
    logEvent("verify.failed", { taskId: t2.id });
    logEvent("agent.stalled", { agentId: 7, taskId: t2.id });
    logEvent("scheduler.spawned", { taskId: t1.id });
    logEvent("agent.spawned", { agentId: 7, taskId: t1.id });
    addMemory({ text: "a lesson learned today" });

    const s = activitySummary(RANGE.since, RANGE.until);

    const done = s.tasks_touched.find((t) => t.id === t1.id)!;
    expect(done.status).toBe("done");
    expect(done.result_summary).toBe("shipped it");
    const flaky = s.tasks_touched.find((t) => t.id === t2.id)!;
    expect(flaky.verify_fails).toBe(2);

    expect(s.open_queue.map((t) => t.id)).toEqual([t2.id]); // done excluded
    expect(s.friction.stalled).toEqual([{ agent_id: 7, task_id: t2.id }]);
    expect(s.friction.verify_failed_tasks).toEqual([{ task_id: t2.id, count: 2 }]);
    expect(s.memories_added.length).toBe(1);
    expect(s.spawns).toEqual({ scheduler: 1, total: 1 });
  });

  it("excludes activity outside the range", async () => {
    const { createTask } = await import("../src/db/tasks.js");
    const { activitySummary } = await import("../src/daemon/summary.js");
    createTask({ title: "t", prompt: "x", repo: "/r" });
    const s = activitySummary(
      "2010-01-01T00:00:00.000Z",
      "2011-01-01T00:00:00.000Z",
    );
    expect(s.tasks_touched.length).toBe(0);
    expect(s.memories_added.length).toBe(0);
    // open_queue is a snapshot of NOW, not range-bound
    expect(s.open_queue.length).toBe(1);
  });

  it("crons can be created disabled (dream setup path)", async () => {
    const { createCron, dueCrons, updateCron } = await import("../src/db/crons.js");
    const c = createCron({
      name: "dreaming",
      schedule: "0 4 * * *",
      prompt: "reflect",
      repo: "/r",
      enabled: false,
    });
    expect(c.enabled).toBe(0);
    updateCron(c.id, { next_run_at: "2020-01-01T00:00:00.000Z" });
    expect(dueCrons(new Date()).length).toBe(0); // disabled -> never due
  });
});
