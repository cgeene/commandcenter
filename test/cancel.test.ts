import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-cancel-"));
  process.env.CC_DATA_DIR = tmpDir;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("cancelTask", () => {
  it("cancels a queued task", async () => {
    const { cancelTask } = await import("../src/daemon/spawn.js");
    const { createTask, getTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    const r = cancelTask(task.id);
    expect(getTask(task.id)?.status).toBe("cancelled");
    expect(r.killed_agents).toEqual([]);
    expect(listEvents(10).map((e) => e.kind)).toContain("task.cancelled");
  });

  it("kills the live worker AND reviewer, but never the main agent", async () => {
    const { cancelTask } = await import("../src/daemon/spawn.js");
    const { createTask, updateTask, getTask } = await import("../src/db/tasks.js");
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    const worker = createAgent({ kind: "worker", state: "working", task_id: task.id });
    const reviewer = createAgent({ kind: "reviewer", state: "working", task_id: task.id });
    const main = createAgent({ kind: "main", state: "working" });
    updateTask(task.id, { status: "in_progress", agent_id: worker.id });

    const r = cancelTask(task.id);
    expect(getTask(task.id)?.status).toBe("cancelled");
    expect(r.killed_agents.sort()).toEqual([worker.id, reviewer.id].sort());
    expect(getAgent(worker.id)?.state).toBe("dead");
    expect(getAgent(reviewer.id)?.state).toBe("dead");
    expect(getAgent(main.id)?.state).toBe("working");
  });

  it("is idempotent", async () => {
    const { cancelTask } = await import("../src/daemon/spawn.js");
    const { createTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    cancelTask(task.id);
    const r = cancelTask(task.id);
    expect(r.task.status).toBe("cancelled");
    expect(r.killed_agents).toEqual([]);
    const cancels = listEvents(20).filter((e) => e.kind === "task.cancelled");
    expect(cancels.length).toBe(1);
  });

  it("cancelled tasks are never ready to spawn", async () => {
    const { cancelTask } = await import("../src/daemon/spawn.js");
    const { createTask, readyTasks } = await import("../src/db/tasks.js");
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    expect(readyTasks().map((t) => t.id)).toContain(task.id);
    cancelTask(task.id);
    expect(readyTasks().map((t) => t.id)).not.toContain(task.id);
  });

  it("reports open dependents that will never unblock", async () => {
    const { cancelTask } = await import("../src/daemon/spawn.js");
    const { createTask } = await import("../src/db/tasks.js");
    const blocker = createTask({ title: "b", prompt: "x", repo: "/r" });
    const dependent = createTask({
      title: "d",
      prompt: "x",
      repo: "/r",
      blocked_by: blocker.id,
    });
    const r = cancelTask(blocker.id);
    expect(r.open_dependents.map((t) => t.id)).toEqual([dependent.id]);
  });

  it("a verify finishing mid-cancel cannot resurrect the task", async () => {
    const { cancelTask } = await import("../src/daemon/spawn.js");
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { createTask, updateTask, getTask } = await import("../src/db/tasks.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    const task = createTask({
      title: "t",
      prompt: "x",
      repo: "/r",
      verify_cmd: "sleep 0.3", // passes, slowly
    });
    const worker = createAgent({ kind: "worker", state: "working", task_id: task.id });
    updateTask(task.id, {
      status: "in_progress",
      agent_id: worker.id,
      worktree: tmpDir,
    });

    const stop = handleHookEvent(worker.id, { hook_event_name: "Stop" });
    await new Promise((r) => setTimeout(r, 50)); // verify is now running
    cancelTask(task.id);
    await stop;

    expect(getTask(task.id)?.status).toBe("cancelled");
    expect(listEvents(20).map((e) => e.kind)).not.toContain("verify.passed");
  });
});
