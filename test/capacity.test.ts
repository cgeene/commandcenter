import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A live worker has a real tmux window: windowExists=true and sendText a no-op,
// so resumeAgent delivers ("sent") and the reviewer-rejection path resumes the
// parked worker in place instead of requeueing it.
vi.mock("../src/daemon/tmux.js", () => ({
  windowExists: () => true,
  sendText: async () => {},
  sendEnter: async () => {},
  clearInputLine: async () => {},
  capturePane: () => "",
  killWindow: () => [],
  paneProcess: () => null,
  listWindowIds: () => [],
  listLiveWindowIds: () => [],
  ensureSession: () => {},
  newWindow: () => "cc:@1",
}));

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-capacity-"));
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

/** A live worker on a task in the given status. */
async function workerOn(status: "in_progress" | "review" | "done", state = "idle") {
  const { createTask, updateTask } = await import("../src/db/tasks.js");
  const { createAgent } = await import("../src/db/agents.js");
  const task = createTask({ title: status, prompt: "x", repo: "/r", open_pr: false });
  const agent = createAgent({
    kind: "worker",
    state: state as "idle",
    task_id: task.id,
    tmux_target: `cc:@${task.id}`,
  });
  updateTask(task.id, {
    status,
    agent_id: agent.id,
    branch: `agent/task-${task.id}`,
    result_summary: "done",
  });
  return { task, agent };
}

function schedulerDeps(spawned: number[], now = new Date("2026-07-28T12:00:00Z")) {
  return {
    spawn: (id: number) => spawned.push(id),
    windowIds: () => [],
    now: () => now,
  };
}

describe("workerSlots", () => {
  it("exempts a worker parked in review and counts one on active work", async () => {
    const { workerSlots } = await import("../src/daemon/capacity.js");
    const active = await workerOn("in_progress", "working");
    const parked = await workerOn("review");

    const slots = workerSlots();
    expect(slots.counted.map((a) => a.id)).toEqual([active.agent.id]);
    expect(slots.parked.map((a) => a.id)).toEqual([parked.agent.id]);
  });

  it("exempts a parked worker regardless of its agent state", async () => {
    const { workerSlots } = await import("../src/daemon/capacity.js");
    // A missed Stop hook (still "working"), a stall flag, or a permission prompt
    // must not silently re-consume the slot the reviewer will release.
    for (const state of ["working", "stalled", "waiting_input"]) {
      await workerOn("review", state);
    }
    const slots = workerSlots();
    expect(slots.counted).toHaveLength(0);
    expect(slots.parked).toHaveLength(3);
  });

  it("still counts a squatter idling on a finished task and a worker with no task", async () => {
    const { workerSlots } = await import("../src/daemon/capacity.js");
    const { createAgent } = await import("../src/db/agents.js");
    const squatter = await workerOn("done");
    const taskless = createAgent({ kind: "worker", state: "idle" });

    const counted = workerSlots().counted.map((a) => a.id);
    expect(counted.sort()).toEqual([squatter.agent.id, taskless.id].sort());
  });

  it("ignores reviewers, the main agent, and dead workers", async () => {
    const { workerSlots } = await import("../src/daemon/capacity.js");
    const { createAgent, updateAgent } = await import("../src/db/agents.js");
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    updateTask(task.id, { status: "review", agent_id: null });
    createAgent({ kind: "reviewer", state: "working", task_id: task.id });
    createAgent({ kind: "main", state: "idle" });
    const dead = await workerOn("in_progress", "working");
    updateAgent(dead.agent.id, { state: "dead" });

    expect(workerSlots().counted).toHaveLength(0);
    expect(workerSlots().parked).toHaveLength(0);
  });
});

describe("scheduler capacity with parked workers", () => {
  it("spawns queued work while every live worker is parked in review", async () => {
    const { createTask } = await import("../src/db/tasks.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    const { countEventsToday } = await import("../src/db/events.js");
    const { tick } = await import("../src/daemon/scheduler.js");
    setSchedulerConfig({ enabled: true, max_concurrent: 1 });
    await workerOn("review"); // parked: holds no slot
    const waiting = createTask({ title: "waiting", prompt: "x", repo: "/r" });

    const spawned: number[] = [];
    tick(schedulerDeps(spawned));

    expect(spawned).toEqual([waiting.id]);
    expect(countEventsToday("scheduler.capacity_blocked")).toBe(0);
  });

  it("reports parked workers separately when the counted slots really are full", async () => {
    const { createTask } = await import("../src/db/tasks.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    const { listEvents } = await import("../src/db/events.js");
    const { tick } = await import("../src/daemon/scheduler.js");
    setSchedulerConfig({ enabled: true, max_concurrent: 1 });
    await workerOn("in_progress", "working"); // takes the only slot
    await workerOn("review"); // parked, exempt
    createTask({ title: "waiting", prompt: "x", repo: "/r" });

    const spawned: number[] = [];
    tick(schedulerDeps(spawned));

    expect(spawned).toEqual([]);
    const blocked = listEvents(20).find((e) => e.kind === "scheduler.capacity_blocked");
    expect(blocked).toBeDefined();
    const payload = JSON.parse(blocked!.payload!);
    expect(payload.live_workers).toBe(1);
    expect(payload.parked_workers).toBe(1);
  });

  it("keeps the Needs You panel quiet when only parked workers are live", async () => {
    const { createTask } = await import("../src/db/tasks.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    const { logEvent } = await import("../src/db/events.js");
    const { getDb } = await import("../src/db/db.js");
    const { deriveAttention } = await import("../src/daemon/attention.js");
    setSchedulerConfig({ enabled: true, max_concurrent: 1 });
    await workerOn("review");
    createTask({ title: "waiting", prompt: "x", repo: "/r" });
    // A stale blockage anchor from before the parked worker was exempt.
    logEvent("scheduler.capacity_blocked", { payload: { max_concurrent: 1 } });
    getDb()
      .prepare("UPDATE events SET ts = ? WHERE kind = 'scheduler.capacity_blocked'")
      .run(new Date(Date.now() - 20 * 60_000).toISOString());

    const items = deriveAttention({ isPrOpen: () => true });
    expect(items.some((i) => i.kind === "scheduler_stalled")).toBe(false);
  });
});

describe("rejection re-entry into the cap", () => {
  it("logs the temporary over-cap when rework wakes a parked worker past the cap", async () => {
    const { handleVerdict } = await import("../src/daemon/review.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    const { listEvents } = await import("../src/db/events.js");
    const { workerSlots } = await import("../src/daemon/capacity.js");
    setSchedulerConfig({ enabled: true, max_concurrent: 1 });
    await workerOn("in_progress", "working"); // already at the cap
    const parked = await workerOn("review");

    await handleVerdict(parked.task.id, 99, "reject", "fix the empty-input case");

    // Rework is a continuation: it is never refused, so the worker keeps the task.
    const task = getTask(parked.task.id)!;
    expect(task.status).toBe("in_progress");
    expect(task.agent_id).toBe(parked.agent.id);
    // ...and it now counts again, which puts the fleet over the cap.
    expect(workerSlots().counted).toHaveLength(2);

    const over = listEvents(20).find((e) => e.kind === "scheduler.worker_over_cap");
    expect(over).toBeDefined();
    expect(over!.task_id).toBe(parked.task.id);
    expect(over!.agent_id).toBe(parked.agent.id);
    const payload = JSON.parse(over!.payload!);
    expect(payload).toMatchObject({
      reason: "review_rejected_rework",
      counted_workers: 2,
      max_concurrent: 1,
    });
  });

  it("stays silent when the woken worker fits inside the cap", async () => {
    const { handleVerdict } = await import("../src/daemon/review.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    const { countEventsToday } = await import("../src/db/events.js");
    setSchedulerConfig({ enabled: true, max_concurrent: 3 });
    const parked = await workerOn("review");

    await handleVerdict(parked.task.id, 99, "reject", "restore the deleted retry test");

    expect(getTask(parked.task.id)!.status).toBe("in_progress");
    expect(countEventsToday("scheduler.worker_over_cap")).toBe(0);
  });
});
