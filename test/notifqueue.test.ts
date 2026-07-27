import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearComposer,
  draftComposer,
  noComposer,
  permissionMenu,
  wrappedComposer,
} from "./fixtures/pane.js";

/** Pane content keyed by tmux target — lets a worker's pane differ from the
 *  main agent's, which the shared single-string mock in hooks.test can't. */
const panes = new Map<string, string>();

/**
 * Stands in for tmux send-keys, faithfully enough to exercise the guard: the
 * text lands in the pane, `beforeSubmit` runs, and Enter only follows if it
 * agrees. `onType` lets a test simulate a keystroke arriving in exactly the
 * window between the composer check and the send.
 */
let onType: ((target: string, text: string) => void) | null = null;
const sendText = vi.fn(
  async (
    target: string,
    text: string,
    opts?: { beforeSubmit?: () => boolean },
  ): Promise<boolean> => {
    onType?.(target, text);
    if (opts?.beforeSubmit && !opts.beforeSubmit()) return false;
    return true;
  },
);

vi.mock("../src/daemon/tmux.js", () => ({
  windowExists: () => true,
  listWindowIds: () => [...panes.keys()],
  listLiveWindowIds: () => [...panes.keys()],
  sendText: (...args: unknown[]) =>
    (sendText as unknown as (...a: unknown[]) => Promise<boolean>)(...args),
  capturePane: (target: string) => panes.get(target) ?? "",
}));

let tmpDir: string;

// An empty, idle composer — no unsubmitted draft, no menu.
const CLEAR_PROMPT = clearComposer();
// The human has started typing a message but not submitted it.
const HUMAN_DRAFT = draftComposer("hey can you also check the");

const MAIN = "cc:@main";
const W1 = "cc:@w1";
const W2 = "cc:@w2";

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-notifq-"));
  process.env.CC_DATA_DIR = tmpDir;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  panes.clear();
  onType = null;
  sendText.mockClear();
  const { __clearAutoNudgeCountsForTests } = await import("../src/daemon/hooks.js");
  __clearAutoNudgeCountsForTests();
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

/**
 * The recurrence these cover: delivery merged into a human's half-typed
 * multi-line message and submitted the wreckage as their turn. Three ways that
 * can happen, all of which must end with the draft intact and the notification
 * still queued for later.
 */
describe("delegateToMain — a human draft is never destroyed", () => {
  it("preserves a multi-line draft verbatim and queues the notification", async () => {
    const { main, worker } = await setup("idle");
    const draft = draftComposer(
      "custom-hostnames will be team-platform.",
      "nylas-data-lake will also be team platform.",
      "unicorn-",
    );
    panes.set(MAIN, draft);

    await notifyWorker(worker.id, "which region?");

    // Nothing was typed into the pane at all, so the draft is byte-identical.
    expect(sendText).not.toHaveBeenCalled();
    expect(panes.get(MAIN)).toBe(draft);
    const { countQueuedNotifications } = await import("../src/db/notifications.js");
    expect(countQueuedNotifications(main.id)).toBe(1);

    // And it is delivered once the human submits and the composer clears.
    panes.set(MAIN, CLEAR_PROMPT);
    const { flushMainQueue } = await import("../src/daemon/notifqueue.js");
    expect(await flushMainQueue(main.id, { force: true })).toBe("flushed");
    expect(String(sendText.mock.calls[0][1])).toContain("which region?");
    expect(countQueuedNotifications(main.id)).toBe(0);
  });

  it("does not submit when a keystroke lands between the check and the send", async () => {
    const { main, worker } = await setup("idle");
    panes.set(MAIN, CLEAR_PROMPT);
    // The composer is clear when checked, then the human's first keystrokes land
    // in the window before Enter — with the notification already in the pane, so
    // both texts coexist exactly as they would on screen.
    onType = (target, text) => {
      panes.set(target, draftComposer(`${text}wait, hold on`));
    };

    await notifyWorker(worker.id, "which region?");

    // Typed, but Enter withheld: nothing was submitted on the human's behalf.
    expect(sendText).toHaveBeenCalledOnce();
    expect(await sendText.mock.results[0].value).toBe(false);
    const { listEvents } = await import("../src/db/events.js");
    const kinds = listEvents(20).map((e) => e.kind);
    expect(kinds).not.toContain("waiting.delegated");
    // Withholding is a distinct, diagnosable outcome, not a silent no-op.
    expect(kinds).toContain("notification.submit_withheld");
    const { countQueuedNotifications } = await import("../src/db/notifications.js");
    expect(countQueuedNotifications(main.id)).toBe(1);
    // The human's characters are still on screen for them to finish or fix.
    expect(panes.get(MAIN)).toContain("wait, hold on");
    // The main was not marked as working off a turn that never started.
    const { getAgent } = await import("../src/db/agents.js");
    expect(getAgent(main.id)?.state).toBe("idle");
  });

  it("refuses to submit into a permission menu that popped in the send window", async () => {
    const { main, worker } = await setup("idle");
    panes.set(MAIN, CLEAR_PROMPT);
    // A menu renders no composer at all, so a composer_found check alone would
    // fall through and press Enter — which confirms the highlighted option.
    onType = (target) => {
      panes.set(target, permissionMenu());
    };

    await notifyWorker(worker.id, "which region?");

    expect(await sendText.mock.results[0].value).toBe(false);
    const { listEvents } = await import("../src/db/events.js");
    const withheld = listEvents(20).filter(
      (e) => e.kind === "notification.submit_withheld",
    );
    expect(withheld.length).toBe(1);
    expect(JSON.parse(withheld[0].payload!).reason).toBe("permission");
    const { countQueuedNotifications } = await import("../src/db/notifications.js");
    expect(countQueuedNotifications(main.id)).toBe(1);
  });

  // The check that runs on EVERY real delivery: at beforeSubmit the composer
  // holds the ~600-char notification, read back as trimmed physical rows joined
  // with " ". Comparing collapsed whitespace makes a hard wrap mid-word look
  // like foreign content, which would withhold Enter on every delivery and
  // strand the message in the prompt.
  for (const wrap of ["word", "hard"] as const) {
    it(`submits normally when the typed message ${wrap}-wraps in the composer`, async () => {
      const { main, worker } = await setup("idle");
      panes.set(MAIN, CLEAR_PROMPT);
      onType = (target, text) => {
        panes.set(target, wrappedComposer(text, { width: 127, wrap }));
      };

      await notifyWorker(worker.id, "which region?");

      expect(sendText).toHaveBeenCalledOnce();
      expect(await sendText.mock.results[0].value).toBe(true);
      const { listEvents } = await import("../src/db/events.js");
      const kinds = listEvents(20).map((e) => e.kind);
      expect(kinds).toContain("waiting.delegated");
      expect(kinds).not.toContain("notification.submit_withheld");
      const { countQueuedNotifications } = await import("../src/db/notifications.js");
      expect(countQueuedNotifications(main.id)).toBe(0);
    });
  }

  it("escalates to the human once a draft has blocked delivery for too long", async () => {
    const { main, worker } = await setup("idle");
    panes.set(MAIN, HUMAN_DRAFT);
    await notifyWorker(worker.id);

    const { DRAFT_BLOCKED_ESCALATE_AFTER, flushMainQueue } = await import(
      "../src/daemon/notifqueue.js"
    );
    const { listEvents } = await import("../src/db/events.js");
    const blocked = () =>
      listEvents(60).filter((e) => e.kind === "main.draft_blocking_delivery");

    // The delegate attempt above was the first; retry up to the threshold.
    for (let i = 1; i < DRAFT_BLOCKED_ESCALATE_AFTER - 1; i++) {
      await flushMainQueue(main.id, { force: true });
    }
    expect(blocked().length).toBe(0);

    expect(await flushMainQueue(main.id, { force: true })).toBe("deferred");
    expect(blocked().length).toBe(1);
    expect(JSON.parse(blocked()[0].payload!).attempts).toBe(
      DRAFT_BLOCKED_ESCALATE_AFTER,
    );

    // Escalates once per streak, not on every subsequent retry.
    await flushMainQueue(main.id, { force: true });
    expect(blocked().length).toBe(1);

    // A delivery getting through resets the streak.
    panes.set(MAIN, CLEAR_PROMPT);
    expect(await flushMainQueue(main.id, { force: true })).toBe("flushed");
    panes.set(MAIN, HUMAN_DRAFT);
    await flushMainQueue(main.id, { force: true });
    expect(blocked().length).toBe(1);
  });

  it("queues rather than guessing when the composer cannot be read at all", async () => {
    const { main, worker } = await setup("idle");
    // A pane with no recognizable input line — a mid-turn capture, or a TUI
    // whose chrome the parser no longer knows. "I can't see a draft" must not
    // be read as "there is no draft".
    panes.set(MAIN, noComposer());

    await notifyWorker(worker.id, "which region?");

    expect(sendText).not.toHaveBeenCalled();
    const { countQueuedNotifications } = await import("../src/db/notifications.js");
    expect(countQueuedNotifications(main.id)).toBe(1);
    // Blocking indefinitely on an unreadable pane must not be silent.
    const { listEvents } = await import("../src/db/events.js");
    expect(listEvents(20).map((e) => e.kind)).toContain("main.composer_unreadable");

    // Recognizable again → delivered, nothing lost.
    panes.set(MAIN, CLEAR_PROMPT);
    const { flushMainQueue } = await import("../src/daemon/notifqueue.js");
    expect(await flushMainQueue(main.id, { force: true })).toBe("flushed");
    expect(countQueuedNotifications(main.id)).toBe(0);
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
