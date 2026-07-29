import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearComposer, draftComposer } from "./fixtures/pane.js";

/**
 * Durability of the deferred main-agent delivery queue.
 *
 * A "Notify Claude Main" click whose delivery was deferred behind a busy
 * composer used to leave no record at all, so a daemon restart erased it with
 * no error, no event and no retry. These tests pin the replacement: the ping is
 * written to SQLite, survives a restart, resumes, and is either delivered or
 * explicitly expired — never silently dropped.
 */

const panes = new Map<string, string>();
const sendText = vi.fn(
  async (
    _target: string,
    _text: string,
    opts?: { beforeSubmit?: () => boolean },
  ): Promise<boolean> => (opts?.beforeSubmit ? opts.beforeSubmit() : true),
);

vi.mock("../src/daemon/tmux.js", () => ({
  windowExists: () => true,
  listWindows: () => ({ live: [...panes.keys()], dead: [], server: "running" }),
  probeWindow: () => "absent" as const,
  sendText: (...args: unknown[]) =>
    (sendText as unknown as (...a: unknown[]) => Promise<boolean>)(...args),
  capturePane: (target: string) => panes.get(target) ?? "",
}));

const MAIN = "cc:@main";
const CLEAR_PROMPT = clearComposer();
const HUMAN_DRAFT = draftComposer("hey can you also check the");

let tmpDir: string;
let repo: string;

beforeEach(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-delivery-")));
  process.env.CC_DATA_DIR = path.join(tmpDir, "data");
  repo = path.join(tmpDir, "repos", "notetaker");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  process.env.CC_REPO_ROOTS = path.join(tmpDir, "repos");
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  panes.clear();
  sendText.mockClear();
  const { __clearFlushBackoffForTests, __clearUnreadableLogForTests } = await import(
    "../src/daemon/notifqueue.js"
  );
  __clearFlushBackoffForTests();
  __clearUnreadableLogForTests();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  delete process.env.CC_REPO_ROOTS;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A live main agent plus a queued, human-filed orchestrated task awaiting triage. */
async function setup(mainState: "idle" | "working" = "working") {
  const { createAgent } = await import("../src/db/agents.js");
  const { createTask } = await import("../src/db/tasks.js");
  const main = createAgent({ kind: "main", state: mainState, tmux_target: MAIN });
  const task = createTask({
    title: "ship it",
    prompt: "do the work",
    repo,
    dispatch_mode: "orchestrated",
  });
  return { main, task };
}

/** Simulate a daemon restart: drop every in-memory structure (the db file on
 *  disk is all that carries over) and re-adopt the queue the way boot does. */
async function restartDaemon(nowMs?: number): Promise<number> {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  const { __clearFlushBackoffForTests, __clearUnreadableLogForTests, resumePendingDeliveries } =
    await import("../src/daemon/notifqueue.js");
  __clearFlushBackoffForTests();
  __clearUnreadableLogForTests();
  return resumePendingDeliveries(nowMs);
}

describe("deferred triage delivery survives a daemon restart", () => {
  it("persists the ping, resumes it on boot, and delivers once the prompt clears", async () => {
    const { main, task } = await setup("working");
    panes.set(MAIN, HUMAN_DRAFT);

    const { delegateTaskToMainDetailed } = await import("../src/daemon/orchestration.js");
    expect(await delegateTaskToMainDetailed(task.id)).toBe("queued");
    expect(sendText).not.toHaveBeenCalled();

    const { countQueuedNotifications, listQueuedNotifications } = await import(
      "../src/db/notifications.js"
    );
    expect(countQueuedNotifications(main.id)).toBe(1);
    expect(listQueuedNotifications(main.id)[0].origin).toBe("task_triage");
    const { listEvents } = await import("../src/db/events.js");
    expect(listEvents(20).map((e) => e.kind)).toContain("delivery.persisted");

    // The daemon dies and comes back — the click must not die with it.
    expect(await restartDaemon()).toBe(1);
    const afterBoot = await import("../src/db/events.js");
    expect(afterBoot.listEvents(20).map((e) => e.kind)).toContain(
      "delivery.resumed_on_boot",
    );

    panes.set(MAIN, CLEAR_PROMPT);
    const { flushMainQueue } = await import("../src/daemon/notifqueue.js");
    expect(await flushMainQueue(main.id, { force: true })).toBe("flushed");

    expect(sendText).toHaveBeenCalledOnce();
    expect(String(sendText.mock.calls[0][1])).toContain(`get_task(${task.id}`);
    expect(countQueuedNotifications(main.id)).toBe(0);
    const kinds = afterBoot.listEvents(30).map((e) => e.kind);
    expect(kinds).toContain("delivery.delivered");
    // Recorded as a real delegation so the state-derived retry does not repeat it.
    expect(kinds).toContain("task.delegated_to_main");
  });

  it("restores the retry backoff rather than retry-storming a busy prompt on boot", async () => {
    const { main, task } = await setup("working");
    panes.set(MAIN, HUMAN_DRAFT);
    const { delegateTaskToMainDetailed } = await import("../src/daemon/orchestration.js");
    await delegateTaskToMainDetailed(task.id);

    // A flush attempt defers and stamps the backoff onto the pending row.
    const { flushMainQueue } = await import("../src/daemon/notifqueue.js");
    const t0 = Date.parse("2026-07-28T00:00:00.000Z");
    expect(await flushMainQueue(main.id, { nowMs: t0 })).toBe("deferred");
    const { listQueuedNotifications } = await import("../src/db/notifications.js");
    const row = listQueuedNotifications(main.id)[0];
    expect(row.attempts).toBe(1);
    expect(Date.parse(row.next_retry_at!)).toBeGreaterThan(t0);

    await restartDaemon(t0 + 500);
    // Still inside the backoff window: the un-forced watchdog path holds off...
    const { flushMainQueue: flushAfter } = await import("../src/daemon/notifqueue.js");
    panes.set(MAIN, CLEAR_PROMPT);
    expect(await flushAfter(main.id, { nowMs: t0 + 1_000 })).toBe("deferred");
    expect(sendText).not.toHaveBeenCalled();
    // ...and delivers once it expires.
    expect(await flushAfter(main.id, { nowMs: t0 + 3_600_000 })).toBe("flushed");
    expect(sendText).toHaveBeenCalledOnce();
  });

  it("does not stack duplicate rows when the human clicks Notify twice", async () => {
    const { main, task } = await setup("working");
    panes.set(MAIN, HUMAN_DRAFT);
    const { delegateTaskToMainDetailed } = await import("../src/daemon/orchestration.js");

    expect(await delegateTaskToMainDetailed(task.id)).toBe("queued");
    expect(await delegateTaskToMainDetailed(task.id)).toBe("already_queued");

    const { countQueuedNotifications } = await import("../src/db/notifications.js");
    expect(countQueuedNotifications(main.id)).toBe(1);
  });

  it("drops the queued copy when the ping reaches the main live instead", async () => {
    const { main, task } = await setup("working");
    panes.set(MAIN, HUMAN_DRAFT);
    const { delegateTaskToMainDetailed } = await import("../src/daemon/orchestration.js");
    await delegateTaskToMainDetailed(task.id);

    // Main goes idle with a clear prompt; the ping is delivered directly.
    const { updateAgent } = await import("../src/db/agents.js");
    updateAgent(main.id, { state: "idle" });
    panes.set(MAIN, CLEAR_PROMPT);
    expect(await delegateTaskToMainDetailed(task.id)).toBe("delivered");

    const { countQueuedNotifications } = await import("../src/db/notifications.js");
    expect(countQueuedNotifications(main.id)).toBe(0);
  });
});

describe("staleness — a queued delivery is re-validated before it is sent late", () => {
  it("expires a triage ping for a task that has since been dispatched", async () => {
    const { main, task } = await setup("working");
    panes.set(MAIN, HUMAN_DRAFT);
    const { delegateTaskToMainDetailed } = await import("../src/daemon/orchestration.js");
    await delegateTaskToMainDetailed(task.id);

    // Main dispatched the task from chat while the ping sat in the queue.
    const { updateTask } = await import("../src/db/tasks.js");
    updateTask(task.id, { status: "in_progress" });

    panes.set(MAIN, CLEAR_PROMPT);
    const { flushMainQueue } = await import("../src/daemon/notifqueue.js");
    expect(await flushMainQueue(main.id, { force: true })).toBe("empty");
    expect(sendText).not.toHaveBeenCalled();

    const { listEvents } = await import("../src/db/events.js");
    const expired = listEvents(30).filter((e) => e.kind === "delivery.expired");
    expect(expired.length).toBe(1);
    expect(JSON.parse(expired[0].payload!)).toMatchObject({
      origin: "task_triage",
      reason: "task_in_progress",
    });
    const { countQueuedNotifications } = await import("../src/db/notifications.js");
    expect(countQueuedNotifications(main.id)).toBe(0);
  });

  it("expires a worker-wait ping whose worker is no longer waiting", async () => {
    const { main } = await setup("working");
    const { createAgent, updateAgent } = await import("../src/db/agents.js");
    const worker = createAgent({
      kind: "worker",
      state: "waiting_input",
      tmux_target: "cc:@w1",
    });
    const { queueDelivery } = await import("../src/daemon/notifqueue.js");
    queueDelivery({
      mainId: main.id,
      workerId: worker.id,
      message: "which region?",
      origin: "worker_waiting",
      reason: "main_working",
    });

    updateAgent(worker.id, { state: "working" }); // rescued before the flush

    panes.set(MAIN, CLEAR_PROMPT);
    const { flushMainQueue } = await import("../src/daemon/notifqueue.js");
    expect(await flushMainQueue(main.id, { force: true })).toBe("empty");
    expect(sendText).not.toHaveBeenCalled();
    const { listEvents } = await import("../src/db/events.js");
    const expired = listEvents(30).filter((e) => e.kind === "delivery.expired");
    expect(expired.length).toBe(1);
    expect(JSON.parse(expired[0].payload!)).toMatchObject({
      origin: "worker_waiting",
      reason: "worker_working",
    });
  });

  /**
   * Layer separation. The queue owns DURABILITY of orchestrator-bound messages;
   * whether Caleb's phone buzzes is decided at the trigger layer (notifyEvent,
   * with its own toggles and once-per-situation latches). So the whole
   * queue→defer→expire lifecycle must be push-silent: a delivery that sat in
   * SQLite across a restart and then went stale is not news to a human, and the
   * watchdog page for a genuinely stuck worker is derived independently from the
   * worker's own waiting_input state, not from this queue.
   */
  it("never pushes: queueing, deferring, and expiring are delivery-layer only", async () => {
    const priorUrl = process.env.CC_NTFY_URL;
    process.env.CC_NTFY_URL = "https://ntfy.test/cc";
    const realFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => new Response("ok"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const { main } = await setup("working");
      const { createAgent, updateAgent } = await import("../src/db/agents.js");
      const worker = createAgent({
        kind: "worker",
        state: "waiting_input",
        tmux_target: "cc:@w1",
      });
      const { queueDelivery, flushMainQueue } = await import(
        "../src/daemon/notifqueue.js"
      );
      queueDelivery({
        mainId: main.id,
        workerId: worker.id,
        message: "which region?",
        origin: "worker_waiting",
        reason: "main_working",
      });

      // Deferred once (the human is mid-draft), then expired on the next flush.
      panes.set(MAIN, HUMAN_DRAFT);
      await flushMainQueue(main.id, { force: true });
      updateAgent(worker.id, { state: "working" });
      panes.set(MAIN, CLEAR_PROMPT);
      expect(await flushMainQueue(main.id, { force: true })).toBe("empty");

      const { listEvents } = await import("../src/db/events.js");
      const kinds = listEvents(40).map((e) => e.kind);
      expect(kinds).toContain("delivery.expired");
      // The lifecycle is fully recorded in the feed, and nothing was pushed.
      expect(kinds).not.toContain("notify.pushed");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
      if (priorUrl === undefined) delete process.env.CC_NTFY_URL;
      else process.env.CC_NTFY_URL = priorUrl;
    }
  });

  it("sends triage and worker-wait pings as one message when both are queued", async () => {
    const { main, task } = await setup("working");
    panes.set(MAIN, HUMAN_DRAFT);
    const { delegateTaskToMainDetailed } = await import("../src/daemon/orchestration.js");
    await delegateTaskToMainDetailed(task.id);

    const { createAgent } = await import("../src/db/agents.js");
    const worker = createAgent({
      kind: "worker",
      state: "waiting_input",
      tmux_target: "cc:@w1",
    });
    const { queueDelivery, flushMainQueue } = await import("../src/daemon/notifqueue.js");
    queueDelivery({
      mainId: main.id,
      workerId: worker.id,
      message: "which region?",
      origin: "worker_waiting",
      reason: "main_working",
    });

    panes.set(MAIN, CLEAR_PROMPT);
    expect(await flushMainQueue(main.id, { force: true })).toBe("flushed");

    expect(sendText).toHaveBeenCalledOnce();
    const msg = String(sendText.mock.calls[0][1]);
    expect(msg).toContain(`get_task(${task.id}`);
    expect(msg).toContain("which region?");
  });
});

/**
 * A worker's wait outliving its own task.
 *
 * A worker that idles while its inline verify is still running is correctly
 * `waiting_input` — nothing has gone wrong — so the hook that first sees the
 * wait cannot suppress it. If the verify then passes, the task moves to review
 * and a reviewer takes over, but the queued ping still describes a worker that
 * needs rescuing. Re-validating only the AGENT let that ping land minutes later
 * and send the orchestrator after a worker whose work was already under review.
 */
describe("staleness — a queued worker-wait ping outlives its task", () => {
  /** A queued worker-wait ping, enqueued while the task was still in_progress
   *  (the state the verify window really leaves behind), then moved on. */
  async function queuedWait(
    mainId: number,
    moveTo: "in_progress" | "blocked" | "review" | "done" | "cancelled",
    kind: "worker" | "reviewer" = "worker",
  ) {
    const { createAgent } = await import("../src/db/agents.js");
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const task = createTask({ title: "ship it", prompt: "do the work", repo });
    const agent = createAgent({
      kind,
      state: "waiting_input",
      task_id: task.id,
      tmux_target: "cc:@w1",
    });
    updateTask(task.id, { status: "in_progress", agent_id: agent.id });

    const { queueDelivery } = await import("../src/daemon/notifqueue.js");
    queueDelivery({
      mainId,
      workerId: agent.id,
      taskId: task.id,
      message: "which region?",
      origin: "worker_waiting",
      reason: "main_working",
    });

    updateTask(task.id, { status: moveTo });
    return { task, agent };
  }

  async function expiredReasons() {
    const { listEvents } = await import("../src/db/events.js");
    return listEvents(40)
      .filter((e) => e.kind === "delivery.expired")
      .map((e) => JSON.parse(e.payload!) as { origin: string; reason: string })
      .map(({ origin, reason }) => ({ origin, reason }));
  }

  for (const status of ["review", "done", "cancelled"] as const) {
    it(`expires the ping when the task moved to ${status} before the flush`, async () => {
      const { main } = await setup("working");
      const { agent } = await queuedWait(main.id, status);

      panes.set(MAIN, CLEAR_PROMPT);
      const { flushMainQueue } = await import("../src/daemon/notifqueue.js");
      expect(await flushMainQueue(main.id, { force: true })).toBe("empty");
      expect(sendText).not.toHaveBeenCalled();

      expect(await expiredReasons()).toEqual([
        { origin: "worker_waiting", reason: `task_${status}` },
      ]);

      // Dropped for the TASK, not by pretending the wait ended: the agent row
      // still says waiting_input, which is what the pane actually shows.
      const { getAgent } = await import("../src/db/agents.js");
      expect(getAgent(agent.id)?.state).toBe("waiting_input");
    });
  }

  for (const status of ["in_progress", "blocked"] as const) {
    it(`still delivers the ping while the task is ${status}`, async () => {
      const { main } = await setup("working");
      await queuedWait(main.id, status);

      panes.set(MAIN, CLEAR_PROMPT);
      const { flushMainQueue } = await import("../src/daemon/notifqueue.js");
      expect(await flushMainQueue(main.id, { force: true })).toBe("flushed");
      expect(sendText).toHaveBeenCalledOnce();
      expect(String(sendText.mock.calls[0][1])).toContain("which region?");
      expect(await expiredReasons()).toEqual([]);
    });
  }

  /**
   * The status test alone would be wrong. A reviewer's task is "review" by
   * definition, so keying on status without the agent's kind would silence every
   * reviewer that stops to ask something — and a reviewer nobody answers is a
   * task stuck in review with no verdict coming.
   */
  it("still delivers a REVIEWER's wait on a task that is in review", async () => {
    const { main } = await setup("working");
    await queuedWait(main.id, "review", "reviewer");

    panes.set(MAIN, CLEAR_PROMPT);
    const { flushMainQueue } = await import("../src/daemon/notifqueue.js");
    expect(await flushMainQueue(main.id, { force: true })).toBe("flushed");
    expect(sendText).toHaveBeenCalledOnce();
    expect(await expiredReasons()).toEqual([]);
  });

  /**
   * Expiring a ping must stay silent. Outside the daemon a push is recorded
   * rather than sent (see notify.ts), so `recordedPushes` — not a fetch spy — is
   * what proves it: a spy would pass even if the push had fired.
   */
  it("expiring for the task pushes nothing to the human", async () => {
    const { main } = await setup("working");
    const { setNotificationSettings } = await import("../src/db/settings.js");
    const { clearRecordedPushes, recordedPushes } = await import(
      "../src/daemon/notify.js"
    );
    // Channel configured and the relevant events explicitly ON, so "nothing
    // pushed" is a real result rather than an artifact of a disabled toggle.
    setNotificationSettings({
      ntfy_url: "https://ntfy.test/cc",
      events: { escalation: true, worker_stalled: true },
    });
    clearRecordedPushes();
    await queuedWait(main.id, "review");

    panes.set(MAIN, CLEAR_PROMPT);
    const { flushMainQueue } = await import("../src/daemon/notifqueue.js");
    expect(await flushMainQueue(main.id, { force: true })).toBe("empty");

    const { listEvents } = await import("../src/db/events.js");
    const kinds = listEvents(40).map((e) => e.kind);
    expect(kinds).toContain("delivery.expired");
    expect(kinds).not.toContain("notify.pushed");
    expect(recordedPushes()).toHaveLength(0);
  });
});

describe("POST /api/tasks/:id/delegate response shape", () => {
  it("202s a queued ping rather than implying instant delivery — or failure", async () => {
    const { task } = await setup("working");
    panes.set(MAIN, HUMAN_DRAFT);
    const { buildApp } = await import("../src/daemon/api.js");

    const res = await buildApp().request(`/api/tasks/${task.id}/delegate`, {
      method: "POST",
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string; detail: string };
    expect(body.status).toBe("queued");
    expect(body.detail).toContain("queued");
  });

  it("200s with delivered when the main's prompt was clear", async () => {
    const { task } = await setup("idle");
    panes.set(MAIN, CLEAR_PROMPT);
    const { buildApp } = await import("../src/daemon/api.js");

    const res = await buildApp().request(`/api/tasks/${task.id}/delegate`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "delivered" });
  });

  it("still 409s when there is no main agent to deliver to", async () => {
    const { createTask } = await import("../src/db/tasks.js");
    const task = createTask({
      title: "t",
      prompt: "x",
      repo,
      dispatch_mode: "orchestrated",
    });
    const { buildApp } = await import("../src/daemon/api.js");
    const res = await buildApp().request(`/api/tasks/${task.id}/delegate`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
    // The error must point at the fix (spawn a main), not just state a failure.
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("spawn a main agent"),
    });
  });

  // Main is never pinged about its own tasks — and every task main files
  // (portfolio children included) is orchestrated + queued, so this is the
  // common case, not an edge. Claiming "no live main, spawn one" here would
  // be false with a main running and would prescribe a duplicate.
  it("409s a task main filed itself without denying that a live main exists", async () => {
    const { main, task } = await setup("idle");
    panes.set(MAIN, CLEAR_PROMPT);
    const { logEvent } = await import("../src/db/events.js");
    logEvent("task.created", {
      taskId: task.id,
      agentId: main.id,
      payload: { creator_kind: "main" },
    });
    const { buildApp } = await import("../src/daemon/api.js");

    const res = await buildApp().request(`/api/tasks/${task.id}/delegate`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("already knows");
    expect(error).not.toContain("no live Claude main");
    expect(sendText).not.toHaveBeenCalled();
  });

});
