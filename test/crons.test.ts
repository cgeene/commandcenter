import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-cron-"));
  process.env.CC_DATA_DIR = tmpDir;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const TEMPLATE = {
  name: "nightly",
  schedule: "0 3 * * *",
  prompt: "do the nightly thing",
  repo: "/r",
};

describe("crons", () => {
  it("rejects invalid schedules", async () => {
    const { createCron } = await import("../src/db/crons.js");
    expect(() => createCron({ ...TEMPLATE, schedule: "not a cron" })).toThrow();
  });

  it("computes next_run_at on create", async () => {
    const { createCron } = await import("../src/db/crons.js");
    const c = createCron(TEMPLATE);
    expect(c.next_run_at).toBeTruthy();
    expect(new Date(c.next_run_at!).getTime()).toBeGreaterThan(Date.now());
  });

  it("fires due crons: enqueues a task and advances next_run_at", async () => {
    const { createCron, updateCron, getCron } = await import("../src/db/crons.js");
    const { listTasks } = await import("../src/db/tasks.js");
    const { fireDueCrons } = await import("../src/daemon/scheduler.js");

    const c = createCron(TEMPLATE);
    updateCron(c.id, { next_run_at: "2020-01-01T00:00:00.000Z" }); // force due
    const now = new Date();
    fireDueCrons(now);

    const tasks = listTasks("queued");
    expect(tasks.length).toBe(1);
    expect(tasks[0].cron_id).toBe(c.id);
    expect(tasks[0].prompt).toBe(TEMPLATE.prompt);

    const after = getCron(c.id)!;
    expect(after.last_run_at).toBe(now.toISOString());
    expect(new Date(after.next_run_at!).getTime()).toBeGreaterThan(now.getTime());
  });

  it("skips firing while a previous task from this cron is still open", async () => {
    const { createCron, updateCron } = await import("../src/db/crons.js");
    const { listTasks } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { fireDueCrons } = await import("../src/daemon/scheduler.js");

    const c = createCron(TEMPLATE);
    updateCron(c.id, { next_run_at: "2020-01-01T00:00:00.000Z" });
    fireDueCrons(new Date());
    updateCron(c.id, { next_run_at: "2020-01-01T00:00:00.000Z" }); // force due again
    fireDueCrons(new Date());

    expect(listTasks().length).toBe(1); // no duplicate
    expect(listEvents(10).map((e) => e.kind)).toContain("cron.skipped");
  });

  it("fires again once the previous task completes", async () => {
    const { createCron, updateCron } = await import("../src/db/crons.js");
    const { listTasks, updateTask } = await import("../src/db/tasks.js");
    const { fireDueCrons } = await import("../src/daemon/scheduler.js");

    const c = createCron(TEMPLATE);
    updateCron(c.id, { next_run_at: "2020-01-01T00:00:00.000Z" });
    fireDueCrons(new Date());
    updateTask(listTasks()[0].id, { status: "done" });
    updateCron(c.id, { next_run_at: "2020-01-01T00:00:00.000Z" });
    fireDueCrons(new Date());
    expect(listTasks().length).toBe(2);
  });

  it("disabled crons never fire; re-enabling schedules from now", async () => {
    const { createCron, updateCron, dueCrons, getCron } = await import(
      "../src/db/crons.js"
    );
    const c = createCron(TEMPLATE);
    updateCron(c.id, { next_run_at: "2020-01-01T00:00:00.000Z", enabled: 0 });
    expect(dueCrons(new Date()).length).toBe(0);
    updateCron(c.id, { enabled: 1 });
    // stale past next_run_at must have been replaced with a future one
    const after = getCron(c.id)!;
    expect(new Date(after.next_run_at!).getTime()).toBeGreaterThan(Date.now());
  });
});
