import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearComposer, permissionMenu } from "./fixtures/pane.js";

/**
 * What a review rejection does with the worker it just rejected, and what
 * happens to the task when that worker cannot take the notes.
 *
 * The failure this covers: `waiting_input` means both "finished its turn and
 * idled" and "sitting on a permission menu", so a rejection killed idle workers
 * it should have resumed — and then left the task in `queued` with no agent and
 * no signal to anybody, because nothing dispatches a requeued orchestrated task.
 */

const sendText = vi.fn(async () => true);
let paneContent = "";
vi.mock("../src/daemon/tmux.js", () => ({
  sendText: (...a: unknown[]) => sendText(...a),
  sendEnter: vi.fn(async () => {}),
  windowExists: () => true,
  capturePane: () => paneContent,
  killWindow: () => [],
  paneProcess: () => null,
  listLiveWindowIds: () => [],
}));

const killAgent = vi.fn((_id: number) => {});
const spawnWorker = vi.fn((_id: number) => {});
vi.mock("../src/daemon/spawn.js", () => ({
  spawnWorker: (id: number) => spawnWorker(id),
  spawnReviewer: vi.fn(() => ({ agent: { id: 999 }, task: {} })),
  killAgent: (id: number) => killAgent(id),
  paneAgeSeconds: () => 0,
}));

let tmpDir: string;
let fetchMock: ReturnType<typeof vi.fn>;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-rework-dispatch-"));
  process.env.CC_DATA_DIR = tmpDir;
  process.env.CC_NTFY_URL = "https://ntfy.test/cc";
  fetchMock = vi.fn(async () => new Response("ok"));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  sendText.mockReset();
  sendText.mockResolvedValue(true);
  paneContent = "";
  const { updateAgent } = await import("../src/db/agents.js");
  // Model the real thing: a killed agent is dead, which is what makes the task
  // stranded rather than merely idle.
  killAgent.mockReset();
  killAgent.mockImplementation((id: number) => {
    updateAgent(id, { state: "dead" });
  });
  spawnWorker.mockReset();
  spawnWorker.mockImplementation(() => {});
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  globalThis.fetch = realFetch;
  delete process.env.CC_NTFY_URL;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * A scratch task in `review` whose worker is parked in `waiting_input`.
 * `notificationType` is what the provider reported when it parked; `null` models
 * a wait with no hook history behind it at all — what the watchdog leaves after
 * re-deriving state from a pane on daemon restart.
 */
async function parkedWorker(notificationType: string | null) {
  const { createTask, updateTask } = await import("../src/db/tasks.js");
  const { createAgent } = await import("../src/db/agents.js");
  const { logEvent } = await import("../src/db/events.js");
  const task = createTask({
    title: "t",
    prompt: "x",
    repo: tmpDir,
    open_pr: false,
    workspace_kind: "scratch",
  });
  const worker = createAgent({
    kind: "worker",
    state: "waiting_input",
    task_id: task.id,
    tmux_target: "cc:@5",
  });
  updateTask(task.id, {
    status: "review",
    agent_id: worker.id,
    worktree: tmpDir,
    result_summary: "round 1 result",
  });
  if (notificationType !== null) {
    logEvent("hook.stop", { agentId: worker.id, taskId: task.id });
    logEvent("hook.notification", {
      agentId: worker.id,
      taskId: task.id,
      payload: { notification_type: notificationType },
    });
  }
  return { task, worker };
}

describe("rejecting a worker parked in waiting_input", () => {
  it("delivers the notes into the live session when it is only idle", async () => {
    const { handleVerdict } = await import("../src/daemon/review.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { getAgent } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    paneContent = clearComposer();
    const { task, worker } = await parkedWorker("idle_prompt");

    await handleVerdict(task.id, 99, "reject", "the retry test was deleted");

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(String(sendText.mock.calls[0][1])).toContain("retry test was deleted");
    const t = getTask(task.id)!;
    expect(t.status).toBe("in_progress");
    expect(t.agent_id).toBe(worker.id);
    expect(t.review_cycles).toBe(1);
    expect(killAgent).not.toHaveBeenCalled();
    expect(getAgent(worker.id)?.state).toBe("working");
    const kinds = listEvents(30).map((e) => e.kind);
    expect(kinds).toContain("agent.idle_wait_cleared");
    expect(kinds).not.toContain("task.requeued");
  });

  // Everything the platform cannot positively read as "only idle" keeps the old
  // behavior: unsolicited text must never be typed into a pending menu.
  const refused: [string, string | null, () => string][] = [
    ["the provider reported a permission prompt", "permission_prompt", clearComposer],
    ["the pane shows a permission menu", "idle_prompt", permissionMenu],
    ["there is no hook behind the wait at all", null, clearComposer],
  ];
  for (const [why, notificationType, pane] of refused) {
    it(`refuses delivery and requeues when ${why}`, async () => {
      const { handleVerdict } = await import("../src/daemon/review.js");
      const { getTask } = await import("../src/db/tasks.js");
      const { listEvents } = await import("../src/db/events.js");
      paneContent = pane();
      const { task, worker } = await parkedWorker(notificationType);

      await handleVerdict(task.id, 99, "reject", "the retry test was deleted");

      expect(sendText).not.toHaveBeenCalled();
      expect(killAgent).toHaveBeenCalledWith(worker.id);
      const t = getTask(task.id)!;
      expect(t.status).toBe("queued");
      expect(t.agent_id).toBeNull();
      expect(t.review_notes).toContain("retry test was deleted");
      expect(t.review_cycles).toBe(1);
      const kinds = listEvents(30).map((e) => e.kind);
      expect(kinds).toContain("task.requeued");
      expect(kinds).not.toContain("agent.idle_wait_cleared");
    });
  }
});

describe("a rejection that requeues never goes silent", () => {
  /** A rejected task back in the queue with no live worker — what the requeue
   *  branch leaves behind. `notificationType` picks the branch it took. */
  async function requeued() {
    const { handleVerdict } = await import("../src/daemon/review.js");
    const { getTask } = await import("../src/db/tasks.js");
    paneContent = permissionMenu();
    const { task, worker } = await parkedWorker("permission_prompt");
    await handleVerdict(task.id, 99, "reject", "fix the empty-input case");
    expect(getTask(task.id)!.status).toBe("queued");
    return { task, worker };
  }

  const deps = (nowMs: number) => ({
    spawn: (id: number) => spawnWorker(id),
    windowIds: () => [] as string[],
    now: () => new Date(nowMs),
  });

  /** What spawnWorker really does: claim the task, attach a live worker. */
  async function realisticSpawn() {
    const { createAgent } = await import("../src/db/agents.js");
    const { updateTask } = await import("../src/db/tasks.js");
    const { logEvent } = await import("../src/db/events.js");
    spawnWorker.mockImplementation((taskId: number) => {
      const agent = createAgent({
        kind: "worker",
        state: "spawning",
        task_id: taskId,
        tmux_target: "cc:@6",
      });
      updateTask(taskId, { status: "in_progress", agent_id: agent.id });
      logEvent("agent.spawned", { agentId: agent.id, taskId });
    });
  }

  it("the watchdog sweep restarts a worker on it", async () => {
    const { reworkDispatchSweep } = await import("../src/daemon/scheduler.js");
    const { strandedReworkTasks } = await import("../src/daemon/review.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { task } = await requeued();
    await realisticSpawn();

    expect(strandedReworkTasks().map((s) => s.task.id)).toEqual([task.id]);
    reworkDispatchSweep(deps(Date.now()));

    expect(spawnWorker).toHaveBeenCalledWith(task.id);
    expect(getTask(task.id)!.status).toBe("in_progress");
    expect(listEvents(40).map((e) => e.kind)).toContain("review.rework_respawned");
    // Standing state, so the situation is over — nothing left to name.
    expect(strandedReworkTasks()).toEqual([]);
  });

  it("does not respawn a task a worker is already on", async () => {
    const { reworkDispatchSweep } = await import("../src/daemon/scheduler.js");
    await requeued();
    await realisticSpawn();

    reworkDispatchSweep(deps(Date.now()));
    reworkDispatchSweep(deps(Date.now()));

    expect(spawnWorker).toHaveBeenCalledTimes(1);
  });

  const attentionItems = async (nowMs: number) => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    return deriveAttention({ now: new Date(nowMs), isPrOpen: () => false }).filter(
      (i) => i.title.startsWith("Rework not started"),
    );
  };

  const PAST_GRACE = () => Date.now() + 5 * 60_000;

  it("raises a Needs You item while the strand persists, and clears it when it ends", async () => {
    const { reworkDispatchSweep } = await import("../src/daemon/scheduler.js");
    const { task } = await requeued();

    const items = await attentionItems(PAST_GRACE());
    expect(items).toHaveLength(1);
    expect(items[0].task_id).toBe(task.id);
    expect(items[0].kind).toBe("stalled_transition");
    expect(items[0].context).toContain("empty-input case");

    await realisticSpawn();
    reworkDispatchSweep(deps(Date.now()));
    expect(await attentionItems(PAST_GRACE())).toEqual([]);
  });

  it("gives the sweep its grace period before bothering the human", async () => {
    await requeued();
    expect(await attentionItems(Date.now())).toEqual([]);
  });

  // The silent outcome the whole change exists to make impossible: queued, no
  // agent, and nothing anywhere saying so. A respawn that cannot run is the
  // hardest case, because the sweep gives up on it.
  it("stays visible and pushes when no worker can be started at all", async () => {
    const { reworkDispatchSweep } = await import("../src/daemon/scheduler.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { setNotificationSettings } = await import("../src/db/settings.js");
    setNotificationSettings({ events: { worker_stalled: true } });
    const { task } = await requeued();
    spawnWorker.mockImplementation(() => {
      throw new Error("worktree is locked");
    });

    // Attempts are spaced, so a single second cannot burn the whole budget.
    let now = Date.now();
    reworkDispatchSweep(deps(now));
    reworkDispatchSweep(deps(now + 1_000));
    expect(spawnWorker).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 5; i++) {
      now += 61_000;
      reworkDispatchSweep(deps(now));
    }
    expect(spawnWorker).toHaveBeenCalledTimes(3); // capped, no hot loop

    expect(getTask(task.id)!.status).toBe("queued");
    const failures = listEvents(80).filter(
      (e) => e.kind === "review.rework_dispatch_failed",
    );
    expect(failures).toHaveLength(3);
    expect(String(failures[0].payload)).toContain("worktree is locked");
    // The dashboard queue names it whatever the push settings are (every ntfy
    // event is off by default and the operator may have them all off), and the
    // push — enabled above — fires once, on the attempt that exhausts the budget.
    expect((await attentionItems(now)).map((i) => i.task_id)).toEqual([task.id]);
    const pushed = fetchMock.mock.calls.map(
      (call) => (call[1] as { headers: Record<string, string> }).headers.Title,
    );
    expect(pushed.filter((t) => t.includes("nobody fixing it"))).toHaveLength(1);
  });

  it("stops naming a task whose status moved on without a respawn", async () => {
    const { strandedReworkTasks } = await import("../src/daemon/review.js");
    const { updateTask } = await import("../src/db/tasks.js");
    const { task } = await requeued();
    expect(strandedReworkTasks()).toHaveLength(1);

    updateTask(task.id, { status: "cancelled" });

    expect(strandedReworkTasks()).toEqual([]);
    expect(await attentionItems(PAST_GRACE())).toEqual([]);
  });
});
