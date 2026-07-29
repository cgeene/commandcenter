import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearComposer,
  draftComposer,
  ghostComposer,
  permissionMenu,
} from "./fixtures/pane.js";

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

/** SGR sequences, built from char codes so this file holds no control bytes. */
const SGR_RE = new RegExp("[\\u001B\\u009B]\\[[0-?]*[ -/]*[@-~]", "g");

/** What `tmux capture-pane -p` (no -e) yields for a styled pane. */
const stripSgr = (pane: string) => pane.replace(SGR_RE, "");

/**
 * Modelled on the real thing: `tmux capture-pane -p` returns the pane's TEXT,
 * and only `-e` (opts.escapes) keeps the SGR codes. That distinction decides
 * whether parsePane can tell Claude's dim autosuggestion from a human's draft,
 * so a caller that forgets `escapes` must fail a test here rather than quietly
 * lose the ghost-text discrimination in production.
 */
vi.mock("../src/daemon/tmux.js", () => ({
  sendText: (...a: unknown[]) => sendText(...a),
  sendEnter: vi.fn(async () => {}),
  windowExists: () => true,
  capturePane: (_t: string, _n?: number, opts?: { escapes?: boolean }) =>
    opts?.escapes ? paneContent : stripSgr(paneContent),
  killWindow: () => [],
  paneProcess: () => null,
  listLiveWindowIds: () => [],
}));

/**
 * A box sitting ABOVE a live composer — deliberately composed from two
 * live-captured fixtures rather than transcribed from one capture, because
 * that is the shape the pane read exists to catch and no single capture of
 * today's TUI produces it: a menu that appeared AFTER the idle_prompt hook was
 * recorded. The permission fixture on its own renders no composer at all, so it
 * only ever exercises the "cannot locate the composer" arm.
 */
const menuOverComposer = () => permissionMenu() + clearComposer();

/** An unnumbered box (so it is a question, not a permission menu) above a live
 *  composer, with the agent's ask on the line before it. */
const questionOverComposer = () =>
  [
    "⏺ Should I delete the legacy table?",
    "",
    `╭${"─".repeat(50)}╮`,
    `│ waiting on your answer${" ".repeat(27)}│`,
    `╰${"─".repeat(50)}╯`,
    "",
  ].join("\n") + clearComposer();

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
let notifyModule: typeof import("../src/daemon/notify.js");
const realFetch = globalThis.fetch;

/** Every push this process produced, in order. Only the daemon dispatches for
 *  real (src/process-role.ts), so a test reads the recorded intents; fetchMock
 *  stays installed as the tripwire that proves nothing reached the wire. */
const pushes = () => notifyModule.recordedPushes();

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-rework-dispatch-"));
  process.env.CC_DATA_DIR = tmpDir;
  process.env.CC_NTFY_URL = "https://ntfy.test/cc";
  fetchMock = vi.fn(async () => new Response("ok"));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  notifyModule = await import("../src/daemon/notify.js");
  notifyModule.clearRecordedPushes();
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
  // The respawn sweep answers to the same master switch as every other
  // automatic spawn, and the default is off.
  const { setSchedulerConfig } = await import("../src/db/settings.js");
  setSchedulerConfig({ enabled: true });
  // watchdog() keeps module state (window-missing confirmations, tmux
  // observability) that outlives the per-test in-memory db.
  const { _resetSchedulerState } = await import("../src/daemon/scheduler.js");
  _resetSchedulerState();
});

afterEach(async () => {
  // No test here may put a request on the wire. If this fires, the daemon-only
  // dispatch guard has been lost and a test run can page a phone.
  expect(fetchMock).not.toHaveBeenCalled();
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
async function parkedWorker(
  notificationType: string | null,
  opts: { workspaceKind?: "scratch" | "repo" } = {},
) {
  const { createTask, updateTask } = await import("../src/db/tasks.js");
  const { createAgent } = await import("../src/db/agents.js");
  const { logEvent } = await import("../src/db/events.js");
  const task = createTask({
    title: "t",
    prompt: "x",
    repo: tmpDir,
    open_pr: false,
    workspace_kind: opts.workspaceKind ?? "scratch",
    // The strand only exists for orchestrated tasks: a direct-dispatch task is
    // picked up by the scheduler's own auto-spawn pass. Every case here uses the
    // shape the incident had.
    dispatch_mode: "orchestrated",
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
  // Three panes that all mean "finished its turn, nothing being asked". The
  // ghost-text one is the case a plain (un-`-e`) capture gets wrong: Claude's dim
  // autosuggestion is indistinguishable from a human's draft once the SGR codes
  // are gone, so it would read as a pending draft and cost the worker its
  // session. The escape-free clear composer is the other direction — a pane with
  // no styling at all must still classify as idle.
  const delivered: [string, () => string][] = [
    ["the composer is empty", clearComposer],
    ["the composer shows a dim ghost suggestion", ghostComposer],
    ["the pane carries no styling at all", () => stripSgr(clearComposer())],
  ];
  for (const [why, pane] of delivered) {
    it(`delivers the notes into the live session when ${why}`, async () => {
      const { handleVerdict } = await import("../src/daemon/review.js");
      const { getTask } = await import("../src/db/tasks.js");
      const { getAgent } = await import("../src/db/agents.js");
      const { listEvents } = await import("../src/db/events.js");
      paneContent = pane();
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
  }

  // Everything the platform cannot positively read as "only idle" keeps the old
  // behavior: unsolicited text must never be typed into a pending menu. One case
  // per condition, each isolating a single one — parsePane suppresses
  // pending_question and unsubmitted_input whenever a permission is up, so these
  // cannot mask each other, and removing any one guard fails exactly one case.
  const refused: [string, string | null, () => string][] = [
    ["the provider reported a permission prompt", "permission_prompt", clearComposer],
    ["a permission menu is up over a live composer", "idle_prompt", menuOverComposer],
    ["a question box is up over a live composer", "idle_prompt", questionOverComposer],
    [
      "text is already sitting in the composer",
      "idle_prompt",
      () => draftComposer("half a sentence a human was typ"),
    ],
    ["the composer cannot be located at all", "idle_prompt", permissionMenu],
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
  /** A rejection's own requeue: menu-parked worker, killed, task back in the
   *  queue with nobody on it — the state the sweep owns. */
  async function requeued(opts: { workspaceKind?: "scratch" | "repo" } = {}) {
    const { handleVerdict } = await import("../src/daemon/review.js");
    const { getTask } = await import("../src/db/tasks.js");
    paneContent = permissionMenu();
    const { task, worker } = await parkedWorker("permission_prompt", opts);
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

  // The whole incident, driven through the production entry point: nothing calls
  // reworkDispatchSweep in the daemon except watchdog(), so a test that only ever
  // calls the sweep directly would keep passing if that call were dropped.
  it("watchdog() restarts the worker on an orchestrated task, with no main agent involved", async () => {
    const { watchdog } = await import("../src/daemon/scheduler.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { listAgents } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    const { task } = await requeued();
    expect(getTask(task.id)!.dispatch_mode).toBe("orchestrated");
    // No main agent exists, which is what made the real incident silent: an
    // orchestrated task is main's to dispatch and main is never pinged about one
    // it filed itself.
    expect(listAgents({ live: true }).some((a) => a.kind === "main")).toBe(false);
    await realisticSpawn();

    watchdog(deps(Date.now()));

    expect(spawnWorker).toHaveBeenCalledWith(task.id);
    const t = getTask(task.id)!;
    expect(t.status).toBe("in_progress");
    expect(t.agent_id).not.toBeNull();
    expect(listEvents(60).map((e) => e.kind)).toContain("review.rework_respawned");
  });

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
    expect(
      pushes().filter((p) => p.title.includes("nobody fixing it")),
    ).toHaveLength(1);
  });

  // Post-#86 the ordinary rejection resolves IN PLACE, so a task can carry a
  // rejection in its history and be requeued LATER by a route that owns its own
  // handling. Those requeues are not this sweep's to restart, and the Needs-You
  // item must not describe them as a rejection's.
  describe("other requeue routes are left alone", () => {
    /** An in-place rejection: the worker was only idle, took the notes, and the
     *  task went back to in_progress (task.reopened). */
    async function reworkedInPlace() {
      const { handleVerdict } = await import("../src/daemon/review.js");
      const { getTask } = await import("../src/db/tasks.js");
      paneContent = clearComposer();
      const { task, worker } = await parkedWorker("idle_prompt");
      await handleVerdict(task.id, 99, "reject", "fix the empty-input case");
      expect(getTask(task.id)!.status).toBe("in_progress");
      return { task, worker };
    }

    it("a PR-feedback requeue is not treated as the rejection's", async () => {
      const { strandedReworkTasks } = await import("../src/daemon/review.js");
      const { reworkDispatchSweep } = await import("../src/daemon/scheduler.js");
      const { updateTask } = await import("../src/db/tasks.js");
      const { logEvent } = await import("../src/db/events.js");
      const { updateAgent } = await import("../src/db/agents.js");
      const { task, worker } = await reworkedInPlace();

      // Exactly what prsync writes when it cannot deliver PR feedback in
      // session (src/daemon/prsync.ts).
      updateAgent(worker.id, { state: "dead" });
      updateTask(task.id, { status: "queued", agent_id: null });
      logEvent("task.requeued", { taskId: task.id, payload: { reason: "pr feedback" } });

      expect(strandedReworkTasks()).toEqual([]);
      reworkDispatchSweep(deps(Date.now()));
      expect(spawnWorker).not.toHaveBeenCalled();
      expect(await attentionItems(PAST_GRACE())).toEqual([]);
    });

    it("a vanished-worker requeue is left to the watchdog's own retry", async () => {
      const { strandedReworkTasks } = await import("../src/daemon/review.js");
      const { reworkDispatchSweep } = await import("../src/daemon/scheduler.js");
      const { updateTask } = await import("../src/db/tasks.js");
      const { logEvent } = await import("../src/db/events.js");
      const { updateAgent } = await import("../src/db/agents.js");
      const { task, worker } = await reworkedInPlace();

      // What the watchdog writes for a vanished worker: no payload at all, and
      // it promises the human exactly one retry of its own.
      updateAgent(worker.id, { state: "dead" });
      updateTask(task.id, { status: "queued", agent_id: null });
      logEvent("task.requeued", { taskId: task.id });

      expect(strandedReworkTasks()).toEqual([]);
      reworkDispatchSweep(deps(Date.now()));
      expect(spawnWorker).not.toHaveBeenCalled();
      expect(await attentionItems(PAST_GRACE())).toEqual([]);
    });

    it("a rejection requeue followed by a respawn and a vanish is left alone too", async () => {
      const { strandedReworkTasks } = await import("../src/daemon/review.js");
      const { updateTask } = await import("../src/db/tasks.js");
      const { logEvent } = await import("../src/db/events.js");
      const { updateAgent } = await import("../src/db/agents.js");
      const { reworkDispatchSweep } = await import("../src/daemon/scheduler.js");
      const { task } = await requeued();
      await realisticSpawn();
      reworkDispatchSweep(deps(Date.now()));
      const { getTask } = await import("../src/db/tasks.js");
      const respawnedId = getTask(task.id)!.agent_id!;

      updateAgent(respawnedId, { state: "dead" });
      updateTask(task.id, { status: "queued", agent_id: null });
      logEvent("task.requeued", { taskId: task.id });

      expect(strandedReworkTasks()).toEqual([]);
      expect(await attentionItems(PAST_GRACE())).toEqual([]);
    });
  });

  // A gate is not a failure. blocked_by is enforced ONLY by the ready queue
  // (spawnWorker checks status and strict-serial, never the blocker), so this
  // sweep is the one path that could start a task whose blocker is not done.
  describe("gates hold the respawn without spending its budget", () => {
    it("waits for an unfinished blocker, then starts once it is done", async () => {
      const { reworkDispatchSweep } = await import("../src/daemon/scheduler.js");
      const { createTask, getTask, updateTask } = await import("../src/db/tasks.js");
      const { listEvents } = await import("../src/db/events.js");
      const { task } = await requeued();
      const blocker = createTask({ title: "blocker", prompt: "y", repo: tmpDir });
      updateTask(task.id, { blocked_by: blocker.id });
      await realisticSpawn();

      let now = Date.now();
      for (let i = 0; i < 4; i++) reworkDispatchSweep(deps((now += 61_000)));

      expect(spawnWorker).not.toHaveBeenCalled();
      expect(getTask(task.id)!.status).toBe("queued");
      // No attempt consumed, so the budget is intact for when the gate clears.
      expect(
        listEvents(80).some((e) => e.kind === "review.rework_dispatch_failed"),
      ).toBe(false);

      updateTask(blocker.id, { status: "done" });
      reworkDispatchSweep(deps((now += 61_000)));

      expect(spawnWorker).toHaveBeenCalledWith(task.id);
      expect(getTask(task.id)!.status).toBe("in_progress");
    });

    it("waits for a strict-serial repo to free up, then starts", async () => {
      const { reworkDispatchSweep } = await import("../src/daemon/scheduler.js");
      const { createTask, getTask, updateTask } = await import("../src/db/tasks.js");
      const { setIntegrationSettings } = await import("../src/db/settings.js");
      const { listEvents } = await import("../src/db/events.js");
      const { task } = await requeued({ workspaceKind: "repo" });
      const holder = createTask({ title: "holder", prompt: "y", repo: tmpDir });
      updateTask(holder.id, { status: "in_progress" });
      setIntegrationSettings({ strict_serial_repos: [tmpDir] });
      await realisticSpawn();

      let now = Date.now();
      for (let i = 0; i < 4; i++) reworkDispatchSweep(deps((now += 61_000)));

      expect(spawnWorker).not.toHaveBeenCalled();
      expect(
        listEvents(80).some((e) => e.kind === "review.rework_dispatch_failed"),
      ).toBe(false);

      // The holder finishes: the gate clears and the full budget is still there.
      updateTask(holder.id, { status: "done" });
      reworkDispatchSweep(deps((now += 61_000)));

      expect(spawnWorker).toHaveBeenCalledWith(task.id);
      expect(getTask(task.id)!.status).toBe("in_progress");
    });
  });

  // It starts a real session, so it obeys the same policy as every other
  // automatic spawn. The strand stays named the whole time it is held.
  describe("autonomous-spawn policy", () => {
    it("does not spawn while autonomous dispatch is off, but still names it", async () => {
      const { reworkDispatchSweep } = await import("../src/daemon/scheduler.js");
      const { setSchedulerConfig } = await import("../src/db/settings.js");
      const { getTask } = await import("../src/db/tasks.js");
      const { task } = await requeued();
      setSchedulerConfig({ enabled: false });
      await realisticSpawn();

      reworkDispatchSweep(deps(Date.now()));

      expect(spawnWorker).not.toHaveBeenCalled();
      expect(getTask(task.id)!.status).toBe("queued");
      expect((await attentionItems(PAST_GRACE())).map((i) => i.task_id)).toEqual([
        task.id,
      ]);
    });

    it("does not spawn outside the active window", async () => {
      const { reworkDispatchSweep } = await import("../src/daemon/scheduler.js");
      const { setSchedulerConfig } = await import("../src/db/settings.js");
      await requeued();
      await realisticSpawn();
      // A one-hour window that cannot contain `at`, whatever the local hour is.
      const at = new Date();
      const start = (at.getHours() + 2) % 24;
      setSchedulerConfig({ active_hours: { start, end: (start + 1) % 24 } });

      reworkDispatchSweep(deps(at.getTime()));
      expect(spawnWorker).not.toHaveBeenCalled();

      setSchedulerConfig({ active_hours: null });
      reworkDispatchSweep(deps(at.getTime()));
      expect(spawnWorker).toHaveBeenCalledTimes(1);
    });

    it("holds off once the daily spawn budget is spent, and says so once", async () => {
      const { reworkDispatchSweep } = await import("../src/daemon/scheduler.js");
      const { setSchedulerConfig } = await import("../src/db/settings.js");
      const { logEvent, listEvents } = await import("../src/db/events.js");
      const { task } = await requeued();
      setSchedulerConfig({ daily_spawn_limit: 2 });
      logEvent("scheduler.spawned", {});
      logEvent("reviewer.auto_spawned", {});
      await realisticSpawn();

      let now = Date.now();
      reworkDispatchSweep(deps(now));
      reworkDispatchSweep(deps((now += 61_000)));

      expect(spawnWorker).not.toHaveBeenCalled();
      const skips = listEvents(80).filter(
        (e) => e.kind === "review.rework_budget_skipped",
      );
      expect(skips).toHaveLength(1); // standing condition, not once per tick
      // No attempt was consumed, so raising the limit starts it immediately.
      expect(
        listEvents(80).some((e) => e.kind === "review.rework_dispatch_failed"),
      ).toBe(false);
      setSchedulerConfig({ daily_spawn_limit: 20 });
      reworkDispatchSweep(deps((now += 61_000)));
      expect(spawnWorker).toHaveBeenCalledWith(task.id);
    });

    it("charges its own respawn to the shared daily budget", async () => {
      const { autonomousSpawnsToday } = await import("../src/daemon/capacity.js");
      const { reworkDispatchSweep } = await import("../src/daemon/scheduler.js");
      await requeued();
      await realisticSpawn();
      expect(autonomousSpawnsToday()).toBe(0);

      reworkDispatchSweep(deps(Date.now()));

      expect(autonomousSpawnsToday()).toBe(1);
    });
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
