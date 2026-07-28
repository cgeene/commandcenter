import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearComposer, draftComposer } from "./fixtures/pane.js";

/**
 * Triage deliveries are acknowledged, and pending ones are batched.
 *
 * Before this, delivery was keyed purely on "a queued orchestrated task with no
 * worker": a task the orchestrator had read and deliberately left queued
 * (sequenced behind other work) was re-delivered on every idle tick and on any
 * PATCH, and a queue of N tasks arrived as N separate wake-ups — each one a full
 * orchestrator turn spent re-reading state it already had.
 *
 * The ack is the orchestrator's own triage read: get_task(id, verbose: true) is
 * the only way to see a task's prompt, so it doubles as "I have this one". These
 * tests pin the four properties that matter: the ack stops re-delivery, an edit
 * after the ack brings it back, pending tasks arrive as one message, and a task
 * that is NEVER acked still resurfaces.
 */

const MAIN = "cc:@main";
const CLEAR_PROMPT = clearComposer();
const HUMAN_DRAFT = draftComposer("hold on, still typing");

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
  listWindowIds: () => [...panes.keys()],
  listLiveWindowIds: () => [...panes.keys()],
  sendText: (...args: unknown[]) =>
    (sendText as unknown as (...a: unknown[]) => Promise<boolean>)(...args),
  sendEnter: vi.fn(),
  capturePane: (target: string) => panes.get(target) ?? "",
}));

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-triage-ack-")));
  process.env.CC_DATA_DIR = path.join(tmpDir, "data");
  delete process.env.CC_REPO_ROOTS;
  delete process.env.CC_REPO_ROOT;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  panes.clear();
  panes.set(MAIN, CLEAR_PROMPT);
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
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** An idle main with a clear composer, plus `count` human-filed orchestrated
 *  tasks queued for triage. */
async function setup(count = 1) {
  const { createAgent } = await import("../src/db/agents.js");
  const { createTask } = await import("../src/db/tasks.js");
  const main = createAgent({ kind: "main", state: "idle", tmux_target: MAIN });
  const tasks = Array.from({ length: count }, (_, i) =>
    createTask({
      title: `task ${i + 1}`,
      prompt: `do the work ${i + 1}`,
      repo: "/r",
      dispatch_mode: "orchestrated",
      open_pr: false,
    }),
  );
  return { main, tasks };
}

/** A delivery marks the main "working" (it now has a turn to run). Model that
 *  turn ending, so the next delivery is judged on its own merits. */
async function mainWentIdle(mainId: number): Promise<void> {
  const { updateAgent } = await import("../src/db/agents.js");
  updateAgent(mainId, { state: "idle" });
  panes.set(MAIN, CLEAR_PROMPT);
}

/** What the orchestrator's `get_task(id, verbose: true)` does over HTTP. */
async function readFullTask(id: number): Promise<Response> {
  const { buildApp } = await import("../src/daemon/api.js");
  const { taskReadPath } = await import("../src/mcp/triage.js");
  return buildApp().request(taskReadPath(id, { verbose: true }));
}

/** How many events of `kind` exist, across all tasks. */
async function countEvents(kind: string): Promise<number> {
  const { listEvents } = await import("../src/db/events.js");
  return listEvents(500).filter((e) => e.kind === kind).length;
}

const messages = () => sendText.mock.calls.map((call) => String(call[1]));

describe("triage ack — reading a task stops it being re-delivered", () => {
  it("only a full read acks; a compact read or projection is just a lookup", async () => {
    const { taskReadPath } = await import("../src/mcp/triage.js");
    expect(taskReadPath(7, { verbose: true })).toBe("/api/tasks/7?triage_ack=1");
    expect(taskReadPath(7)).toBe("/api/tasks/7");
    expect(taskReadPath(7, { verbose: false })).toBe("/api/tasks/7");
    // `fields` wins over verbose and cannot return the prompt, so it never acks.
    expect(taskReadPath(7, { verbose: true, fields: ["status"] })).toBe("/api/tasks/7");
  });

  it("stamps the ack on a verbose get and stops every re-delivery route", async () => {
    const { main, tasks } = await setup();
    const [task] = tasks;
    const { delegateTaskToMainDetailed, delegatePendingTaskToMain, TRIAGE_REDELIVER_AFTER_MS } =
      await import("../src/daemon/orchestration.js");

    expect(await delegateTaskToMainDetailed(task.id)).toBe("delivered");
    expect(sendText).toHaveBeenCalledOnce();

    // The orchestrator reads the full record — its triage action, and the ack.
    const res = await readFullTask(task.id);
    expect(res.status).toBe(200);
    const acked = (await res.json()) as { id: number; triaged_at: string | null };
    expect(acked.triaged_at).not.toBeNull();
    const { listEvents } = await import("../src/db/events.js");
    expect(listEvents(20).map((e) => e.kind)).toContain("task.triage_acked");

    // It leaves the task queued on purpose (sequenced behind other work).
    // Nothing may ping it again: not the immediate route, not the idle catch-up,
    // and not the unacked-task cooldown that the ack overrides.
    sendText.mockClear();
    expect(await delegateTaskToMainDetailed(task.id)).toBe("already_triaged");
    expect(await delegatePendingTaskToMain(main)).toBe(false);
    expect(
      await delegatePendingTaskToMain(main, {
        nowMs: Date.now() + TRIAGE_REDELIVER_AFTER_MS * 2,
      }),
    ).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("does NOT ack a compact read, a worker's task, or a task already dispatched", async () => {
    const { tasks } = await setup(2);
    const { buildApp } = await import("../src/daemon/api.js");
    const app = buildApp();
    const { getTask, updateTask } = await import("../src/db/tasks.js");

    // Compact read (no ack param): the queue still owes this task a delivery.
    expect((await app.request(`/api/tasks/${tasks[0].id}`)).status).toBe(200);
    expect(getTask(tasks[0].id)!.triaged_at).toBeNull();

    // Dispatched already — there is no triage to acknowledge.
    updateTask(tasks[1].id, { status: "in_progress" });
    await readFullTask(tasks[1].id);
    expect(getTask(tasks[1].id)!.triaged_at).toBeNull();

    // A direct-dispatch task never goes through main triage at all.
    const { createTask } = await import("../src/db/tasks.js");
    const direct = createTask({ title: "direct", prompt: "x", repo: "/r" });
    await readFullTask(direct.id);
    expect(getTask(direct.id)!.triaged_at).toBeNull();
  });

  it("drops a queued ping for a task acked while the ping waited", async () => {
    const { main, tasks } = await setup();
    const [task] = tasks;
    // Main's composer holds a human draft, so the ping is persisted, not sent.
    panes.set(MAIN, HUMAN_DRAFT);
    const { delegateTaskToMainDetailed } = await import("../src/daemon/orchestration.js");
    expect(await delegateTaskToMainDetailed(task.id)).toBe("queued");

    // Main reads the task from chat while the ping sits in the queue: the ack
    // takes the pending row with it, so the flush has nothing left to send.
    await readFullTask(task.id);
    const { countQueuedNotifications } = await import("../src/db/notifications.js");
    expect(countQueuedNotifications(main.id)).toBe(0);

    panes.set(MAIN, CLEAR_PROMPT);
    const { flushMainQueue } = await import("../src/daemon/notifqueue.js");
    expect(await flushMainQueue(main.id, { force: true })).toBe("empty");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("expires — never delivers late — a queued ping whose task got acked", async () => {
    const { main, tasks } = await setup();
    const [task] = tasks;
    panes.set(MAIN, HUMAN_DRAFT);
    const { delegateTaskToMainDetailed } = await import("../src/daemon/orchestration.js");
    expect(await delegateTaskToMainDetailed(task.id)).toBe("queued");

    // Ack straight at the db, leaving the queued row in place: the flush's own
    // re-validation is the backstop for any route that acks without clearing.
    const { markTaskTriaged } = await import("../src/db/tasks.js");
    expect(markTaskTriaged(task.id)).toBeDefined();

    panes.set(MAIN, CLEAR_PROMPT);
    const { flushMainQueue } = await import("../src/daemon/notifqueue.js");
    expect(await flushMainQueue(main.id, { force: true })).toBe("empty");
    expect(sendText).not.toHaveBeenCalled();
    const { listEvents } = await import("../src/db/events.js");
    const expired = listEvents(30).find((e) => e.kind === "delivery.expired");
    expect(String(expired?.payload)).toContain("task_triaged");
  });
});

describe("triage ack — what brings a task back", () => {
  it("re-delivers after its prompt is edited, but not after a cosmetic PATCH", async () => {
    const { main, tasks } = await setup();
    const [task] = tasks;
    const { buildApp } = await import("../src/daemon/api.js");
    const app = buildApp();
    const { delegateTaskToMainDetailed } = await import("../src/daemon/orchestration.js");
    await delegateTaskToMainDetailed(task.id);
    await readFullTask(task.id);
    await mainWentIdle(main.id);
    sendText.mockClear();

    // Sequencing a triaged task (priority/blocker) is not new information —
    // this PATCH used to re-deliver it as if it had just been filed.
    const cosmetic = await app.request(`/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ priority: 0 }),
    });
    expect(cosmetic.status).toBe(200);
    expect(((await cosmetic.json()) as { triaged_at: string | null }).triaged_at).not.toBeNull();
    expect(sendText).not.toHaveBeenCalled();

    // Editing the prompt changes what triage judged: ack dropped, ping resent.
    const edited = await app.request(`/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "actually, do something else entirely" }),
    });
    expect(edited.status).toBe(200);
    expect(((await edited.json()) as { triaged_at: string | null }).triaged_at).toBeNull();
    expect(sendText).toHaveBeenCalledOnce();
    expect(messages()[0]).toContain(`get_task(${task.id}`);
  });

  it("re-delivers a task that goes back into the queue after being acked", async () => {
    const { main, tasks } = await setup();
    const [task] = tasks;
    const { delegateTaskToMainDetailed, delegatePendingTaskToMain } = await import(
      "../src/daemon/orchestration.js"
    );
    await delegateTaskToMainDetailed(task.id);
    await readFullTask(task.id);

    // Dispatched, then requeued (review rejection / PR feedback / stale worker
    // sweep all land on this same write) — it needs triage again.
    const { updateTask, getTask } = await import("../src/db/tasks.js");
    updateTask(task.id, { status: "in_progress" });
    updateTask(task.id, { status: "queued", agent_id: null });
    expect(getTask(task.id)!.triaged_at).toBeNull();

    await mainWentIdle(main.id);
    sendText.mockClear();
    expect(await delegatePendingTaskToMain(main)).toBe(true);
    expect(sendText).toHaveBeenCalledOnce();
  });

  it("re-flags on an explicit manual delegate, ack or no ack", async () => {
    const { main, tasks } = await setup();
    const [task] = tasks;
    const { delegateTaskToMainDetailed } = await import("../src/daemon/orchestration.js");
    await delegateTaskToMainDetailed(task.id);
    await readFullTask(task.id);
    await mainWentIdle(main.id);
    sendText.mockClear();

    const { buildApp } = await import("../src/daemon/api.js");
    const res = await buildApp().request(`/api/tasks/${task.id}/delegate`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { status: string }).toMatchObject({ status: "delivered" });
    expect(sendText).toHaveBeenCalledOnce();
    const { listEvents } = await import("../src/db/events.js");
    expect(listEvents(30).map((e) => e.kind)).toContain("task.triage_reflagged");
  });
});

describe("triage delivery batching", () => {
  it("pings the main ONCE for a queue of pending tasks, not once per task", async () => {
    const { main, tasks } = await setup(3);
    const { delegatePendingTaskToMain } = await import("../src/daemon/orchestration.js");

    expect(await delegatePendingTaskToMain(main)).toBe(true);
    expect(sendText).toHaveBeenCalledOnce();
    const message = messages()[0];
    for (const task of tasks) expect(message).toContain(`#${task.id}`);
    expect(message).toContain("3 tasks are awaiting your triage");

    // Every task in the batch is recorded as delegated, so the state-derived
    // retry does not repeat any of them.
    const { latestTaskEvent } = await import("../src/db/events.js");
    for (const task of tasks) {
      expect(latestTaskEvent(task.id, ["task.delegated_to_main"])?.agent_id).toBe(main.id);
    }
  });

  it("shrinks the batch to the tasks still unacked", async () => {
    const { main, tasks } = await setup(3);
    const { delegatePendingTaskToMain } = await import("../src/daemon/orchestration.js");
    // Main triaged two of the three and dispatched neither.
    await readFullTask(tasks[0].id);
    await readFullTask(tasks[1].id);

    expect(await delegatePendingTaskToMain(main)).toBe(true);
    expect(sendText).toHaveBeenCalledOnce();
    const message = messages()[0];
    expect(message).toContain(`get_task(${tasks[2].id}`);
    expect(message).not.toContain(`#${tasks[0].id}`);
    expect(message).not.toContain(`#${tasks[1].id}`);
  });

  it("records a deferred batch ONCE, however many times the watchdog retries", async () => {
    // The watchdog calls this every ~10s. While main is mid-turn or mid-draft
    // every one of those calls used to re-log task.awaiting_main AND
    // delivery.persisted for EVERY task in the batch — the same event storm this
    // whole change exists to stop, multiplied by the queue depth, flooding the
    // 30-event feed the human and the orchestrator audit from.
    const { main, tasks } = await setup(3);
    panes.set(MAIN, HUMAN_DRAFT);
    const { delegatePendingTaskToMain } = await import("../src/daemon/orchestration.js");

    expect(await delegatePendingTaskToMain(main)).toBe(false);
    expect(await countEvents("task.awaiting_main")).toBe(tasks.length);
    expect(await countEvents("delivery.persisted")).toBe(tasks.length);

    // Four more ticks over an unchanged pending set: nothing new to record.
    for (let tick = 0; tick < 4; tick++) {
      expect(await delegatePendingTaskToMain(main)).toBe(false);
    }
    expect(await countEvents("task.awaiting_main")).toBe(tasks.length);
    expect(await countEvents("delivery.persisted")).toBe(tasks.length);
    const { countQueuedNotifications } = await import("../src/db/notifications.js");
    expect(countQueuedNotifications(main.id)).toBe(tasks.length);
    expect(sendText).not.toHaveBeenCalled();

    // A genuinely new task still gets recorded — the quiet is about repetition,
    // not about dropping work.
    const { createTask } = await import("../src/db/tasks.js");
    const late = createTask({
      title: "arrived later",
      prompt: "x",
      repo: "/r",
      dispatch_mode: "orchestrated",
      open_pr: false,
    });
    expect(await delegatePendingTaskToMain(main)).toBe(false);
    expect(await countEvents("task.awaiting_main")).toBe(tasks.length + 1);
    expect(countQueuedNotifications(main.id)).toBe(tasks.length + 1);
    const { latestTaskEvent } = await import("../src/db/events.js");
    expect(latestTaskEvent(late.id, ["task.awaiting_main"])).toBeDefined();
  });

  it("keeps a reopened task's do-not-duplicate directive inside a batch", async () => {
    const { main, tasks } = await setup(2);
    // tasks[0] is a reopened archived task: its ping carries instructions no
    // generic "N tasks awaiting triage" line can express, and losing them is how
    // the orchestrator ends up filing a duplicate task.
    const { logEvent } = await import("../src/db/events.js");
    logEvent("task.archived_resumed", { taskId: tasks[0].id });
    const { delegatePendingTaskToMain } = await import("../src/daemon/orchestration.js");

    expect(await delegatePendingTaskToMain(main)).toBe(true);
    expect(sendText).toHaveBeenCalledOnce();
    const message = messages()[0];
    expect(message).toContain(`Archived task #${tasks[0].id} was reopened`);
    expect(message).toContain("Do not create a duplicate task");
    expect(message).toContain("continue the SAME task");
    // ...and the ordinary task still rides along in the same single message.
    expect(message).toContain(`#${tasks[1].id}`);
  });

  it("keeps the directive when the batch arrives via the deferred-queue flush", async () => {
    const { main, tasks } = await setup(2);
    const { logEvent } = await import("../src/db/events.js");
    logEvent("task.worker_resume_requested", { taskId: tasks[0].id });
    panes.set(MAIN, HUMAN_DRAFT);
    const { delegatePendingTaskToMain } = await import("../src/daemon/orchestration.js");
    expect(await delegatePendingTaskToMain(main)).toBe(false);

    panes.set(MAIN, CLEAR_PROMPT);
    const { flushMainQueue } = await import("../src/daemon/notifqueue.js");
    expect(await flushMainQueue(main.id, { force: true })).toBe("flushed");
    expect(sendText).toHaveBeenCalledOnce();
    const message = messages()[0];
    expect(message).toContain("managed worker launch failed");
    expect(message).toContain(`spawn_worker(${tasks[0].id})`);
    expect(message).toContain("Do not create a duplicate task");
    expect(message).toContain(`#${tasks[1].id}`);
  });

  it("queues each batched task separately when the composer is busy", async () => {
    const { main, tasks } = await setup(2);
    panes.set(MAIN, HUMAN_DRAFT);
    const { delegatePendingTaskToMain } = await import("../src/daemon/orchestration.js");
    expect(await delegatePendingTaskToMain(main)).toBe(false);
    expect(sendText).not.toHaveBeenCalled();

    // Two rows, so the flush can re-validate each task independently — one of
    // them getting dispatched must not take the other's ping down with it.
    const { listQueuedNotifications } = await import("../src/db/notifications.js");
    const queued = listQueuedNotifications(main.id);
    expect(queued.map((q) => q.task_id).sort()).toEqual(tasks.map((t) => t.id).sort());

    const { updateTask } = await import("../src/db/tasks.js");
    updateTask(tasks[0].id, { status: "in_progress" });
    panes.set(MAIN, CLEAR_PROMPT);
    const { flushMainQueue } = await import("../src/daemon/notifqueue.js");
    expect(await flushMainQueue(main.id, { force: true })).toBe("flushed");
    expect(sendText).toHaveBeenCalledOnce();
    expect(messages()[0]).toContain(`get_task(${tasks[1].id}`);
    expect(messages()[0]).not.toContain(`#${tasks[0].id}`);
  });
});

describe("triage ack — safety net for a task that is never acked", () => {
  it("re-delivers an unacked task once the cooldown lapses, and not before", async () => {
    const { main, tasks } = await setup();
    const [task] = tasks;
    const { delegatePendingTaskToMain, TRIAGE_REDELIVER_AFTER_MS } = await import(
      "../src/daemon/orchestration.js"
    );

    // Delivered, but the orchestrator never read it — it died mid-turn, or its
    // context was compacted away.
    expect(await delegatePendingTaskToMain(main)).toBe(true);
    expect(sendText).toHaveBeenCalledOnce();

    // No re-ping storm on the ticks right after.
    sendText.mockClear();
    expect(await delegatePendingTaskToMain(main)).toBe(false);
    expect(
      await delegatePendingTaskToMain(main, {
        nowMs: Date.now() + TRIAGE_REDELIVER_AFTER_MS - 60_000,
      }),
    ).toBe(false);
    expect(sendText).not.toHaveBeenCalled();

    // ...but it is never stranded: once the cooldown lapses it surfaces again.
    expect(
      await delegatePendingTaskToMain(main, {
        nowMs: Date.now() + TRIAGE_REDELIVER_AFTER_MS + 1_000,
      }),
    ).toBe(true);
    expect(sendText).toHaveBeenCalledOnce();
    expect(messages()[0]).toContain(`get_task(${task.id}`);
  });

  it("keeps a triaged task quiet for a replacement main, and discoverable", async () => {
    // The ack is a property of the TASK, not of one orchestrator session: a
    // triaged task stays quiet even after the main that read it dies, rather
    // than resurfacing on a timer forever. What replaces the ping is visibility
    // — list_tasks(ready=true) still returns the task, carrying triaged_at, so a
    // fresh orchestrator can see both that it is queued and that it was already
    // triaged, and pick it up deliberately.
    const { main, tasks } = await setup();
    const [task] = tasks;
    const { delegatePendingTaskToMain, pendingTriageTasks, TRIAGE_REDELIVER_AFTER_MS } =
      await import("../src/daemon/orchestration.js");
    expect(await delegatePendingTaskToMain(main)).toBe(true);
    await readFullTask(task.id);

    const { createAgent, updateAgent } = await import("../src/db/agents.js");
    updateAgent(main.id, { state: "dead" });
    const replacement = createAgent({ kind: "main", state: "idle", tmux_target: MAIN });
    sendText.mockClear();

    // Quiet for both mains, and quiet for good — well past the unacked cooldown,
    // which is what would otherwise turn "no ack from this main" into a 10-minute
    // re-ping loop that no amount of reading could stop.
    for (const agent of [main, replacement]) {
      expect(pendingTriageTasks(agent).map((t) => t.id)).toEqual([]);
      expect(await delegatePendingTaskToMain(agent)).toBe(false);
      expect(
        await delegatePendingTaskToMain(agent, {
          nowMs: Date.now() + TRIAGE_REDELIVER_AFTER_MS * 2,
        }),
      ).toBe(false);
    }
    expect(sendText).not.toHaveBeenCalled();

    // Still on the ready queue the replacement is told to check, with the triage
    // state visible on the row it gets back.
    const { readyTasks } = await import("../src/db/tasks.js");
    const ready = readyTasks("orchestrated");
    expect(ready.map((t) => t.id)).toContain(task.id);
    expect(ready.find((t) => t.id === task.id)!.triaged_at).not.toBeNull();
    const { TASK_ROW_FIELDS } = await import("../src/mcp/compact.js");
    expect(TASK_ROW_FIELDS).toContain("triaged_at");
  });

  it("does not churn the delivery queue for a triaged task after its main dies", async () => {
    // The failure this pins: if the delivery path and the queue's staleness
    // check disagree about whether a task is acked, every tick persists a ping
    // that the next flush expires — a permanent ~10s storm of
    // task.awaiting_main / delivery.persisted / delivery.expired, and a ping the
    // main never actually receives. Both sides read the same flag, so a triaged
    // task produces no rows and no events at all.
    const { main, tasks } = await setup();
    const [task] = tasks;
    const { delegatePendingTaskToMain } = await import("../src/daemon/orchestration.js");
    expect(await delegatePendingTaskToMain(main)).toBe(true);
    await readFullTask(task.id);

    const { createAgent, updateAgent } = await import("../src/db/agents.js");
    updateAgent(main.id, { state: "dead" });
    // The replacement is mid-turn with the human typing — the state that makes
    // the live send defer and the ping get persisted instead.
    const replacement = createAgent({ kind: "main", state: "working", tmux_target: MAIN });
    panes.set(MAIN, HUMAN_DRAFT);
    sendText.mockClear();

    const before = {
      awaiting: await countEvents("task.awaiting_main"),
      persisted: await countEvents("delivery.persisted"),
      expired: await countEvents("delivery.expired"),
    };
    const { flushMainQueue } = await import("../src/daemon/notifqueue.js");
    const { countQueuedNotifications } = await import("../src/db/notifications.js");
    for (let tick = 0; tick < 5; tick++) {
      expect(await delegatePendingTaskToMain(replacement)).toBe(false);
      expect(await flushMainQueue(replacement.id, { force: true })).toBe("empty");
      expect(countQueuedNotifications(replacement.id)).toBe(0);
    }
    expect(await countEvents("task.awaiting_main")).toBe(before.awaiting);
    expect(await countEvents("delivery.persisted")).toBe(before.persisted);
    expect(await countEvents("delivery.expired")).toBe(before.expired);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("cannot be scoped to one agent — an attributed ack still silences every main", async () => {
    // Regression repro for the agent-scoped ack this replaced. The request is
    // sent exactly as that version's MCP layer sent it, with the reading agent
    // attached; nothing reads that now, and that is the point. When suppression
    // was per agent, a second main could never ack (the stamp was taken once and
    // never re-attributed), so it was re-pinged every cooldown forever — and on
    // the deferred path the delivery side and the queue's staleness check
    // disagreed, persisting a ping that the next flush immediately expired, over
    // and over.
    const { main, tasks } = await setup();
    const [task] = tasks;
    const { buildApp } = await import("../src/daemon/api.js");
    const { delegatePendingTaskToMain, TRIAGE_REDELIVER_AFTER_MS } = await import(
      "../src/daemon/orchestration.js"
    );
    expect(await delegatePendingTaskToMain(main)).toBe(true);
    const acked = await buildApp().request(
      `/api/tasks/${task.id}?triage_ack=1&agent_id=${main.id}`,
    );
    expect(acked.status).toBe(200);

    const { createAgent, updateAgent } = await import("../src/db/agents.js");
    updateAgent(main.id, { state: "dead" });
    const replacement = createAgent({ kind: "main", state: "working", tmux_target: MAIN });
    panes.set(MAIN, HUMAN_DRAFT);
    sendText.mockClear();
    const before = {
      awaiting: await countEvents("task.awaiting_main"),
      expired: await countEvents("delivery.expired"),
    };

    const { flushMainQueue } = await import("../src/daemon/notifqueue.js");
    const { countQueuedNotifications } = await import("../src/db/notifications.js");
    for (let tick = 0; tick < 4; tick++) {
      expect(
        await delegatePendingTaskToMain(replacement, {
          nowMs: Date.now() + TRIAGE_REDELIVER_AFTER_MS * 2,
        }),
      ).toBe(false);
      expect(await flushMainQueue(replacement.id, { force: true })).toBe("empty");
    }
    expect(countQueuedNotifications(replacement.id)).toBe(0);
    expect(await countEvents("task.awaiting_main")).toBe(before.awaiting);
    expect(await countEvents("delivery.expired")).toBe(before.expired);
    expect(sendText).not.toHaveBeenCalled();
    // Nothing about who read it is recorded, so nothing can branch on it.
    const { latestTaskEvent } = await import("../src/db/events.js");
    expect(latestTaskEvent(task.id, ["task.triage_acked"])?.agent_id).toBeNull();
  });

  it("still surfaces an unacked task to a NEW main after the old one died", async () => {
    const { main, tasks } = await setup();
    const [task] = tasks;
    const { delegatePendingTaskToMain } = await import("../src/daemon/orchestration.js");
    expect(await delegatePendingTaskToMain(main)).toBe(true);

    const { createAgent, updateAgent } = await import("../src/db/agents.js");
    updateAgent(main.id, { state: "dead" });
    const replacement = createAgent({ kind: "main", state: "idle", tmux_target: MAIN });
    sendText.mockClear();

    expect(await delegatePendingTaskToMain(replacement)).toBe(true);
    expect(messages()[0]).toContain(`get_task(${task.id}`);
  });
});
