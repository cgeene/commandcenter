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

function deps(
  overrides: Partial<{
    spawned: number[];
    windows: string[] | null;
    now: Date;
  }> = {},
) {
  const spawned: number[] = overrides.spawned ?? [];
  return {
    spawned,
    deps: {
      spawn: (id: number) => spawned.push(id),
      windowIds: () =>
        Object.prototype.hasOwnProperty.call(overrides, "windows")
          ? (overrides.windows ?? null)
          : [],
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

  it("never bypasses Claude main for orchestrated tasks", async () => {
    const { createTask } = await import("../src/db/tasks.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    const { tick } = await import("../src/daemon/scheduler.js");
    setSchedulerConfig({ enabled: true, max_concurrent: 3 });
    createTask({
      title: "human task",
      prompt: "x",
      repo: "/r",
      dispatch_mode: "orchestrated",
    });
    const { spawned, deps: d } = deps();
    tick(d);
    expect(spawned).toEqual([]);
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

  it("confirms a missing window before requeueing, then fails on a second confirmed vanish", async () => {
    const { createTask, getTask, updateTask } = await import("../src/db/tasks.js");
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const { watchdog } = await import("../src/daemon/scheduler.js");

    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    const a1 = createAgent({ kind: "worker", state: "working", task_id: task.id, tmux_target: "cc:@9" });
    updateTask(task.id, { status: "in_progress", agent_id: a1.id });

    const missing = { spawn: () => {}, windowIds: () => [], now: () => new Date() };
    watchdog(missing);
    expect(getAgent(a1.id)?.state).toBe("working");
    expect(getTask(task.id)?.status).toBe("in_progress");
    watchdog(missing);
    expect(getAgent(a1.id)?.state).toBe("dead");
    expect(getTask(task.id)?.status).toBe("queued"); // first vanish -> retry

    const a2 = createAgent({ kind: "worker", state: "working", task_id: task.id, tmux_target: "cc:@10" });
    updateTask(task.id, { status: "in_progress", agent_id: a2.id });
    watchdog(missing);
    expect(getAgent(a2.id)?.state).toBe("working");
    watchdog(missing);
    expect(getTask(task.id)?.status).toBe("failed"); // second vanish -> give up
  });

  it("never mutates agents when tmux cannot be observed reliably", async () => {
    const { createTask, getTask, updateTask } = await import("../src/db/tasks.js");
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    const { watchdog } = await import("../src/daemon/scheduler.js");
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    const agent = createAgent({
      kind: "worker",
      state: "working",
      task_id: task.id,
      tmux_target: "cc:@9",
    });
    updateTask(task.id, { status: "in_progress", agent_id: agent.id });

    watchdog({ spawn: () => {}, windowIds: () => null, now: () => new Date() });
    watchdog({ spawn: () => {}, windowIds: () => null, now: () => new Date() });

    expect(getAgent(agent.id)?.state).toBe("working");
    expect(getTask(task.id)?.status).toBe("in_progress");
    expect(
      listEvents(20).filter((event) => event.kind === "watchdog.tmux_unavailable"),
    ).toHaveLength(1);
  });

  it("surfaces a startup trust prompt before SessionStart is available", async () => {
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    const { watchdog } = await import("../src/daemon/scheduler.js");
    const main = createAgent({
      kind: "main",
      provider: "claude",
      state: "spawning",
      tmux_target: "cc:@9",
    });

    watchdog({
      spawn: () => {},
      windowIds: () => ["cc:@9"],
      now: () => new Date(),
      pendingPermission: () => ({
        question: "Security guide",
        options: [
          { n: 1, label: "Yes, I trust this folder" },
          { n: 2, label: "No, exit" },
        ],
      }),
    });

    expect(getAgent(main.id)?.state).toBe("waiting_input");
    expect(listEvents(10).map((event) => event.kind)).toContain(
      "agent.startup_permission",
    );
  });

  it("recovers a false vanish only while its original task is still unclaimed", async () => {
    const { createTask, getTask, updateTask } = await import("../src/db/tasks.js");
    const { createAgent, getAgent, updateAgent } = await import("../src/db/agents.js");
    const { watchdog } = await import("../src/daemon/scheduler.js");
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    const agent = createAgent({
      kind: "worker",
      provider: "codex",
      state: "working",
      task_id: task.id,
      tmux_target: "cc:@9",
    });
    updateTask(task.id, { status: "in_progress", agent_id: agent.id });
    const missing = { spawn: () => {}, windowIds: () => [], now: () => new Date() };
    watchdog(missing);
    watchdog(missing);
    expect(getTask(task.id)?.status).toBe("queued");

    watchdog({
      spawn: () => {},
      windowIds: () => ["cc:@9"],
      now: () => new Date(),
      pendingPermission: () => ({
        question: "run command?",
        options: [
          { n: 1, label: "Yes, proceed" },
          { n: 2, label: "No" },
        ],
      }),
    });

    expect(getAgent(agent.id)?.state).toBe("waiting_input");
    expect(getTask(task.id)).toMatchObject({
      status: "in_progress",
      agent_id: agent.id,
    });

    // The recovered false signal must not spend the task's one real retry.
    updateAgent(agent.id, { state: "working" });
    watchdog(missing);
    watchdog(missing);
    expect(getTask(task.id)?.status).toBe("queued");
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

describe("watchdog auto-reap", () => {
  async function setup() {
    const tasks = await import("../src/db/tasks.js");
    const agents = await import("../src/db/agents.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    const { watchdog } = await import("../src/daemon/scheduler.js");
    const { listEvents } = await import("../src/db/events.js");
    setSchedulerConfig({ reap_after_minutes: 10 });
    return { ...tasks, ...agents, watchdog, listEvents };
  }

  // window still alive throughout; only the reap decision is under test
  function reapDeps(killed: number[], nowIso: string) {
    return {
      spawn: () => {},
      kill: (id: number) => killed.push(id),
      windowIds: () => ["cc:@9"],
      now: () => new Date(nowIso),
    };
  }

  it("reaps a finished worker once the grace period elapses, freeing its slot", async () => {
    const { createTask, updateTask, createAgent, updateAgent, watchdog, listEvents } = await setup();
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    const a = createAgent({ kind: "worker", state: "idle", task_id: task.id, tmux_target: "cc:@9" });
    updateTask(task.id, { status: "done", agent_id: a.id });
    updateAgent(a.id, { last_event_at: "2026-07-03T10:00:00.000Z" });

    const killed: number[] = [];
    watchdog(reapDeps(killed, "2026-07-03T10:20:00.000Z")); // 20m > 10m grace
    expect(killed).toEqual([a.id]);
    const reaped = listEvents().find((e) => e.kind === "agent.reaped");
    expect(reaped?.agent_id).toBe(a.id);
    expect(reaped?.task_id).toBe(task.id);
  });

  it("does NOT reap before the grace period elapses", async () => {
    const { createTask, updateTask, createAgent, updateAgent, watchdog } = await setup();
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    const a = createAgent({ kind: "worker", state: "idle", task_id: task.id, tmux_target: "cc:@9" });
    updateTask(task.id, { status: "done", agent_id: a.id });
    updateAgent(a.id, { last_event_at: "2026-07-03T10:00:00.000Z" });

    const killed: number[] = [];
    watchdog(reapDeps(killed, "2026-07-03T10:05:00.000Z")); // 5m < 10m grace
    expect(killed).toEqual([]);
  });

  it("reaps for every terminal status but never a non-terminal one", async () => {
    const { createTask, updateTask, createAgent, updateAgent, watchdog } = await setup();
    const mk = (status: string) => {
      const t = createTask({ title: status, prompt: "x", repo: "/r" });
      const a = createAgent({ kind: "worker", state: "idle", task_id: t.id, tmux_target: "cc:@9" });
      updateTask(t.id, { status: status as never, agent_id: a.id });
      updateAgent(a.id, { last_event_at: "2026-07-03T10:00:00.000Z" });
      return a.id;
    };
    const done = mk("done");
    const cancelled = mk("cancelled");
    const failed = mk("failed");
    const inProgress = mk("in_progress"); // active — must survive
    const review = mk("review"); // may still get rejection feedback — survive

    const killed: number[] = [];
    watchdog(reapDeps(killed, "2026-07-03T11:00:00.000Z"));
    expect(killed.sort((x, y) => x - y)).toEqual([done, cancelled, failed].sort((x, y) => x - y));
    expect(killed).not.toContain(inProgress);
    expect(killed).not.toContain(review);
  });

  it("never reaps the main agent or a reviewer, even on a terminal task", async () => {
    const { createTask, updateTask, createAgent, updateAgent, watchdog } = await setup();
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    updateTask(task.id, { status: "done" });
    const main = createAgent({ kind: "main", state: "idle", tmux_target: "cc:@9" });
    updateAgent(main.id, { last_event_at: "2026-07-03T10:00:00.000Z" });
    const reviewer = createAgent({ kind: "reviewer", state: "working", task_id: task.id, tmux_target: "cc:@9" });
    updateAgent(reviewer.id, { last_event_at: "2026-07-03T10:00:00.000Z" });

    const killed: number[] = [];
    watchdog(reapDeps(killed, "2026-07-03T11:00:00.000Z"));
    expect(killed).toEqual([]);
  });

});

describe("watchdog stall detection (unaffected by idle-in-review suppression)", () => {
  async function setup() {
    const tasks = await import("../src/db/tasks.js");
    const agents = await import("../src/db/agents.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    const { watchdog } = await import("../src/daemon/scheduler.js");
    const { listEvents } = await import("../src/db/events.js");
    setSchedulerConfig({ stall_minutes: 15 });
    return { ...tasks, ...agents, watchdog, listEvents };
  }

  function stallDeps(nowIso: string) {
    return {
      spawn: () => {},
      kill: () => {},
      windowIds: () => ["cc:@9"],
      now: () => new Date(nowIso),
    };
  }

  it("still stalls a silent working WORKER (stall is a separate detector from idle suppression)", async () => {
    const { createTask, updateTask, createAgent, updateAgent, watchdog, listEvents } = await setup();
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    const a = createAgent({ kind: "worker", state: "working", task_id: task.id, tmux_target: "cc:@9" });
    updateTask(task.id, { status: "in_progress", agent_id: a.id });
    updateAgent(a.id, { last_event_at: "2026-07-03T10:00:00.000Z" });

    watchdog(stallDeps("2026-07-03T10:20:00.000Z")); // 20m > 15m stall
    const stalled = listEvents().filter((e) => e.kind === "agent.stalled");
    expect(stalled.map((e) => e.agent_id)).toEqual([a.id]);
    expect(listEvents().map((e) => e.kind)).not.toContain("waiting.suppressed_in_review");
  });

  it("stalls (escalates) a frozen working REVIEWER mid-review — idle suppression does not touch it", async () => {
    const { createTask, updateTask, createAgent, updateAgent, watchdog, listEvents } = await setup();
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    updateTask(task.id, { status: "review" });
    const reviewer = createAgent({
      kind: "reviewer",
      state: "working",
      task_id: task.id,
      tmux_target: "cc:@9",
    });
    updateAgent(reviewer.id, { last_event_at: "2026-07-03T10:00:00.000Z" });

    watchdog(stallDeps("2026-07-03T10:20:00.000Z")); // 20m > 15m stall
    const stalled = listEvents().filter((e) => e.kind === "agent.stalled");
    expect(stalled.map((e) => e.agent_id)).toEqual([reviewer.id]);
    const { getAgent } = await import("../src/db/agents.js");
    expect(getAgent(reviewer.id)?.state).toBe("stalled");
    expect(listEvents().map((e) => e.kind)).not.toContain("waiting.suppressed_in_review");
  });

  it("does NOT stall before stall_minutes elapses", async () => {
    const { createTask, updateTask, createAgent, updateAgent, watchdog, listEvents } = await setup();
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    updateTask(task.id, { status: "review" });
    const reviewer = createAgent({ kind: "reviewer", state: "working", task_id: task.id, tmux_target: "cc:@9" });
    updateAgent(reviewer.id, { last_event_at: "2026-07-03T10:00:00.000Z" });

    watchdog(stallDeps("2026-07-03T10:05:00.000Z")); // 5m < 15m
    expect(listEvents().map((e) => e.kind)).not.toContain("agent.stalled");
  });
});

describe("scheduler capacity_blocked visibility", () => {
  it("emits capacity_blocked (once, throttled) when ready work has no free slot", async () => {
    const { createTask } = await import("../src/db/tasks.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    const { countEventsToday } = await import("../src/db/events.js");
    const { tick } = await import("../src/daemon/scheduler.js");
    setSchedulerConfig({ enabled: true, max_concurrent: 1 });
    createAgent({ kind: "worker", state: "idle" }); // holds the only slot
    createTask({ title: "waiting", prompt: "x", repo: "/r" });

    const { spawned, deps: d } = deps({ now: new Date("2026-07-03T12:00:00Z") });
    tick(d);
    tick(d); // same minute -> throttled, no second event
    expect(spawned).toEqual([]);
    expect(countEventsToday("scheduler.capacity_blocked")).toBe(1);
  });

  it("does not emit capacity_blocked when the queue is empty", async () => {
    const { createAgent } = await import("../src/db/agents.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    const { countEventsToday } = await import("../src/db/events.js");
    const { tick } = await import("../src/daemon/scheduler.js");
    setSchedulerConfig({ enabled: true, max_concurrent: 1 });
    createAgent({ kind: "worker", state: "idle" });

    const { deps: d } = deps();
    tick(d);
    expect(countEventsToday("scheduler.capacity_blocked")).toBe(0);
  });
});
