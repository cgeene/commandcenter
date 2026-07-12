import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-sched-"));
  process.env.CC_DATA_DIR = tmpDir;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  const { _resetSchedulerState } = await import("../src/daemon/scheduler.js");
  _resetSchedulerState();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function deps(overrides: Partial<{ spawned: number[]; windows: string[]; now: Date }> = {}) {
  const spawned: number[] = overrides.spawned ?? [];
  return {
    spawned,
    deps: {
      spawn: (id: number) => spawned.push(id),
      windowIds: () => overrides.windows ?? [],
      now: () => overrides.now ?? new Date("2026-07-03T12:00:00"),
    },
  };
}

describe("inActiveWindow", () => {
  it("handles normal and overnight ranges", async () => {
    const { inActiveWindow } = await import("../src/daemon/scheduler.js");
    const at = (h: number) => new Date(2026, 6, 3, h, 30);
    expect(inActiveWindow({ start: 9, end: 17 }, at(12))).toBe(true);
    expect(inActiveWindow({ start: 9, end: 17 }, at(8))).toBe(false);
    expect(inActiveWindow({ start: 22, end: 6 }, at(23))).toBe(true);
    expect(inActiveWindow({ start: 22, end: 6 }, at(3))).toBe(true);
    expect(inActiveWindow({ start: 22, end: 6 }, at(12))).toBe(false);
  });
});

describe("scheduler tick", () => {
  it("does nothing when disabled", async () => {
    const { createTask } = await import("../src/db/tasks.js");
    const { tick } = await import("../src/daemon/scheduler.js");
    createTask({ title: "t", prompt: "x", repo: "/r" });
    const { spawned, deps: d } = deps();
    tick(d);
    expect(spawned).toEqual([]);
  });

  it("spawns ready tasks up to max_concurrent, counting live workers", async () => {
    const { createTask } = await import("../src/db/tasks.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    const { tick } = await import("../src/daemon/scheduler.js");
    setSchedulerConfig({ enabled: true, max_concurrent: 3 });
    createAgent({ kind: "worker", state: "working" }); // occupies one slot
    const t1 = createTask({ title: "a", prompt: "x", repo: "/r" });
    const t2 = createTask({ title: "b", prompt: "x", repo: "/r" });
    createTask({ title: "c", prompt: "x", repo: "/r" }); // over capacity
    const { spawned, deps: d } = deps();
    tick(d);
    expect(spawned).toEqual([t1.id, t2.id]);
  });

  it("stops at the daily spawn budget", async () => {
    const { createTask } = await import("../src/db/tasks.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    const { logEvent } = await import("../src/db/events.js");
    const { tick } = await import("../src/daemon/scheduler.js");
    setSchedulerConfig({ enabled: true, max_concurrent: 5, daily_spawn_limit: 2 });
    logEvent("scheduler.spawned"); // 1 already used today
    const t1 = createTask({ title: "a", prompt: "x", repo: "/r" });
    createTask({ title: "b", prompt: "x", repo: "/r" });
    const { spawned, deps: d } = deps();
    tick(d);
    expect(spawned).toEqual([t1.id]); // only 1 more allowed
  });

  it("respects the active window", async () => {
    const { createTask } = await import("../src/db/tasks.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    const { tick } = await import("../src/daemon/scheduler.js");
    setSchedulerConfig({
      enabled: true,
      active_hours: { start: 22, end: 6 },
    });
    createTask({ title: "a", prompt: "x", repo: "/r" });
    const noon = deps({ now: new Date(2026, 6, 3, 12, 0) });
    tick(noon.deps);
    expect(noon.spawned).toEqual([]);
    const night = deps({ now: new Date(2026, 6, 3, 23, 0) });
    tick(night.deps);
    expect(night.spawned.length).toBe(1);
  });

  it("blocks a task whose spawn fails instead of hot-looping", async () => {
    const { createTask, getTask } = await import("../src/db/tasks.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    const { tick } = await import("../src/daemon/scheduler.js");
    setSchedulerConfig({ enabled: true });
    const t = createTask({ title: "a", prompt: "x", repo: "/r" });
    tick({
      spawn: () => {
        throw new Error("worktree exploded");
      },
      windowIds: () => [],
      now: () => new Date(),
    });
    const after = getTask(t.id)!;
    expect(after.status).toBe("blocked");
    expect(after.result_summary).toContain("worktree exploded");
  });
});

describe("watchdog", () => {
  it("surfaces a worker whose SessionStart hook never arrives", async () => {
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const { getDb } = await import("../src/db/db.js");
    const { listEvents } = await import("../src/db/events.js");
    const { watchdog } = await import("../src/daemon/scheduler.js");
    const agent = createAgent({
      kind: "worker",
      provider: "codex",
      state: "spawning",
    });
    getDb()
      .prepare("UPDATE agents SET spawned_at = ? WHERE id = ?")
      .run("2026-07-03T10:00:00.000Z", agent.id);

    watchdog({
      spawn: () => {},
      windowIds: () => [],
      now: () => new Date("2026-07-03T10:02:00.000Z"),
    });
    expect(getAgent(agent.id)?.state).toBe("stalled");
    expect(listEvents(10).map((event) => event.kind)).toContain(
      "agent.session_start_missing",
    );
  });

  it("reaps vanished windows: requeue once, fail on second vanish", async () => {
    const { createTask, getTask, updateTask } = await import("../src/db/tasks.js");
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const { watchdog } = await import("../src/daemon/scheduler.js");

    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    const a1 = createAgent({ kind: "worker", state: "working", task_id: task.id, tmux_target: "cc:@9" });
    updateTask(task.id, { status: "in_progress", agent_id: a1.id });

    watchdog({ spawn: () => {}, windowIds: () => [], now: () => new Date() });
    expect(getAgent(a1.id)?.state).toBe("dead");
    expect(getTask(task.id)?.status).toBe("queued"); // first vanish -> retry

    const a2 = createAgent({ kind: "worker", state: "working", task_id: task.id, tmux_target: "cc:@10" });
    updateTask(task.id, { status: "in_progress", agent_id: a2.id });
    watchdog({ spawn: () => {}, windowIds: () => [], now: () => new Date() });
    expect(getTask(task.id)?.status).toBe("failed"); // second vanish -> give up
  });

  it("marks silent working agents stalled", async () => {
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const { createAgent, getAgent, updateAgent } = await import("../src/db/agents.js");
    const { watchdog } = await import("../src/daemon/scheduler.js");

    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    const agent = createAgent({ kind: "worker", state: "working", task_id: task.id, tmux_target: "cc:@9" });
    updateTask(task.id, { status: "in_progress", agent_id: agent.id });
    updateAgent(agent.id, { last_event_at: "2026-07-03T10:00:00.000Z" });

    // 20 minutes later, window still alive, no events since
    watchdog({
      spawn: () => {},
      windowIds: () => ["cc:@9"],
      now: () => new Date("2026-07-03T10:20:00.000Z"),
    });
    expect(getAgent(agent.id)?.state).toBe("stalled");
  });
});
