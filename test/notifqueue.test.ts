import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sendText = vi.fn(async () => {});
/** Pane content keyed by tmux target — lets a worker's pane differ from the
 *  main agent's, which the shared single-string mock in hooks.test can't. */
const panes = new Map<string, string>();

vi.mock("../src/daemon/tmux.js", () => ({
  windowExists: () => true,
  listWindowIds: () => [...panes.keys()],
  sendText: (...args: unknown[]) => sendText(...args),
  capturePane: (target: string) => panes.get(target) ?? "",
}));

let tmpDir: string;

// An empty, idle composer — no unsubmitted draft, no menu.
const CLEAR_PROMPT = ["╭──────────╮", "│ ❯        │", "╰──────────╯"].join("\n");
// The human has started typing a message but not submitted it.
const HUMAN_DRAFT = [
  "╭──────────────────────────────╮",
  "│ ❯ hey can you also check the  │",
  "╰──────────────────────────────╯",
].join("\n");

const MAIN = "cc:@main";
const W1 = "cc:@w1";
const W2 = "cc:@w2";

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-notifq-"));
  process.env.CC_DATA_DIR = tmpDir;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  panes.clear();
  sendText.mockClear();
  sendText.mockImplementation(async () => {});
  const { __clearAutoNudgeCountsForTests } = await import("../src/daemon/hooks.js");
  __clearAutoNudgeCountsForTests();
  const { __clearFlushBackoffForTests } = await import("../src/daemon/notifqueue.js");
  __clearFlushBackoffForTests();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A main agent plus a live worker parked in an in_progress task. Worker pane
 *  defaults to empty (no transient-error signature → not auto-nudged, so a
 *  Notification cleanly reaches the delegate path). */
async function setup(mainState: "idle" | "working" | "waiting_input") {
  const { createTask, updateTask } = await import("../src/db/tasks.js");
  const { createAgent } = await import("../src/db/agents.js");
  const main = createAgent({ kind: "main", state: mainState, tmux_target: MAIN });
  const task = createTask({ title: "t", prompt: "x", repo: "/r" });
  const worker = createAgent({
    kind: "worker",
    state: "working",
    task_id: task.id,
    tmux_target: W1,
  });
  updateTask(task.id, { status: "in_progress", agent_id: worker.id, worktree: tmpDir });
  return { main, worker, task };
}

async function notifyWorker(workerId: number, message = "needs a decision") {
  const { handleHookEvent } = await import("../src/daemon/hooks.js");
  await handleHookEvent(workerId, { hook_event_name: "Notification", message });
}

describe("delegateToMain — deliver vs queue", () => {
  it("delivers immediately when the main is idle with a clear prompt", async () => {
    const { main, worker } = await setup("idle");
    panes.set(MAIN, CLEAR_PROMPT);

    await notifyWorker(worker.id, "which region?");

    expect(sendText).toHaveBeenCalledOnce();
    expect(sendText.mock.calls[0][0]).toBe(MAIN);
    expect(String(sendText.mock.calls[0][1])).toContain("which region?");
    const { listEvents } = await import("../src/db/events.js");
    const kinds = listEvents(20).map((e) => e.kind);
    expect(kinds).toContain("waiting.delegated");
    expect(kinds).not.toContain("notification.queued");
    const { countQueuedNotifications } = await import("../src/db/notifications.js");
    expect(countQueuedNotifications(main.id)).toBe(0);
  });

  it("queues instead of sending when the main is mid-turn (state working)", async () => {
    const { main, worker } = await setup("working");
    panes.set(MAIN, CLEAR_PROMPT); // prompt is clear, but the turn is live

    await notifyWorker(worker.id);

    expect(sendText).not.toHaveBeenCalled();
    const { countQueuedNotifications, listQueuedNotifications } = await import(
      "../src/db/notifications.js"
    );
    expect(countQueuedNotifications(main.id)).toBe(1);
    expect(listQueuedNotifications(main.id)[0].worker_id).toBe(worker.id);
    const { listEvents } = await import("../src/db/events.js");
    expect(listEvents(20).map((e) => e.kind)).toContain("notification.queued");
  });

  it("queues when the main is idle but the human is mid-typing a draft", async () => {
    const { main, worker } = await setup("idle");
    panes.set(MAIN, HUMAN_DRAFT);

    await notifyWorker(worker.id);

    expect(sendText).not.toHaveBeenCalled();
    const { countQueuedNotifications } = await import("../src/db/notifications.js");
    expect(countQueuedNotifications(main.id)).toBe(1);
    const { listEvents } = await import("../src/db/events.js");
    expect(listEvents(20).map((e) => e.kind)).toContain("notification.queued");
  });
});

describe("flushMainQueue — batching and re-check", () => {
  it("batches multiple queued notifications into one message on the main's Stop", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const { createAgent } = await import("../src/db/agents.js");
    const main = createAgent({ kind: "main", state: "working", tmux_target: MAIN });
    const mk = async (target: string) => {
      const task = createTask({ title: "t", prompt: "x", repo: "/r" });
      const w = createAgent({ kind: "worker", state: "working", task_id: task.id, tmux_target: target });
      updateTask(task.id, { status: "in_progress", agent_id: w.id, worktree: tmpDir });
      return w;
    };
    const w1 = await mk(W1);
    const w2 = await mk(W2);

    await notifyWorker(w1.id, "approve the push?");
    await notifyWorker(w2.id, "which env?");
    const { countQueuedNotifications } = await import("../src/db/notifications.js");
    expect(countQueuedNotifications(main.id)).toBe(2);
    expect(sendText).not.toHaveBeenCalled();

    // Main's turn ends with a clear prompt → single batched flush.
    panes.set(MAIN, CLEAR_PROMPT);
    await handleHookEvent(main.id, { hook_event_name: "Stop" });

    expect(sendText).toHaveBeenCalledOnce();
    const msg = String(sendText.mock.calls[0][1]);
    expect(msg).toContain("2 workers");
    expect(msg).toContain(`a${w1.id}`);
    expect(msg).toContain(`a${w2.id}`);
    expect(countQueuedNotifications(main.id)).toBe(0);
    const { listEvents } = await import("../src/db/events.js");
    const flushed = listEvents(30).filter((e) => e.kind === "notification.flushed");
    expect(flushed.length).toBe(1);
    expect(JSON.parse(flushed[0].payload!).count).toBe(2);
  });

  it("re-checks the prompt before flushing and defers if the human is typing again", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { main, worker } = await setup("working");
    await notifyWorker(worker.id);
    const { countQueuedNotifications } = await import("../src/db/notifications.js");
    expect(countQueuedNotifications(main.id)).toBe(1);

    // Turn ends, but the human resumed typing before the flush — do NOT inject.
    panes.set(MAIN, HUMAN_DRAFT);
    await handleHookEvent(main.id, { hook_event_name: "Stop" });

    expect(sendText).not.toHaveBeenCalled();
    expect(countQueuedNotifications(main.id)).toBe(1); // still queued
    const { listEvents } = await import("../src/db/events.js");
    expect(listEvents(20).map((e) => e.kind)).not.toContain("notification.flushed");

    // Prompt clears — a forced flush now delivers it.
    const { flushMainQueue } = await import("../src/daemon/notifqueue.js");
    panes.set(MAIN, CLEAR_PROMPT);
    const result = await flushMainQueue(main.id, { force: true });
    expect(result).toBe("flushed");
    expect(sendText).toHaveBeenCalledOnce();
    expect(countQueuedNotifications(main.id)).toBe(0);
  });

  it("drops queued entries whose worker is no longer waiting", async () => {
    const { main, worker } = await setup("working");
    await notifyWorker(worker.id);

    // Worker got rescued (back to working) before the main could be flushed.
    const { updateAgent } = await import("../src/db/agents.js");
    updateAgent(worker.id, { state: "working" });

    const { flushMainQueue } = await import("../src/daemon/notifqueue.js");
    panes.set(MAIN, CLEAR_PROMPT);
    const result = await flushMainQueue(main.id, { force: true });

    expect(result).toBe("empty");
    expect(sendText).not.toHaveBeenCalled();
    const { countQueuedNotifications } = await import("../src/db/notifications.js");
    expect(countQueuedNotifications(main.id)).toBe(0);
  });
});

describe("safety valve — the escalate-to-human page is unaffected by queuing", () => {
  it("queuing leaves the worker's waiting_input state and notification timestamp intact, so the watchdog still pages", async () => {
    const { main, worker } = await setup("working");
    const { getAgent } = await import("../src/db/agents.js");
    const { latestAgentEventTs, listEvents } = await import("../src/db/events.js");

    await notifyWorker(worker.id);

    // The notification was queued, not delivered...
    const { countQueuedNotifications } = await import("../src/db/notifications.js");
    expect(countQueuedNotifications(main.id)).toBe(1);
    // ...but the worker is still marked waiting and its wait clock is running.
    expect(getAgent(worker.id)?.state).toBe("waiting_input");
    const waitStart = latestAgentEventTs(worker.id, ["hook.notification"]);
    expect(waitStart).toBeTruthy();

    // Backdate the wait past escalate_minutes (default 5) and run the watchdog.
    const { getDb } = await import("../src/db/db.js");
    getDb()
      .prepare(
        "UPDATE events SET ts = ? WHERE id = (SELECT MAX(id) FROM events WHERE kind = 'hook.notification')",
      )
      .run(new Date(Date.now() - 10 * 60_000).toISOString());

    const { watchdog } = await import("../src/daemon/scheduler.js");
    watchdog({
      spawn: () => {},
      windowIds: () => [MAIN, W1],
      now: () => new Date(),
    });

    const escalations = listEvents(30).filter((e) => e.kind === "waiting.escalated");
    expect(escalations.length).toBe(1);
    expect(escalations[0].agent_id).toBe(worker.id);
  });
});
