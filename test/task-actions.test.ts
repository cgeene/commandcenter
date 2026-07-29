import { describe, expect, it } from "vitest";
import {
  canNotifyMain,
  canSpawnWorker,
  delegateOutcomeNote,
  type ActionTask,
} from "../src/lib/taskactions.js";

/** Task-drawer button gating: which actions a task offers, and what the
 *  "Notify Claude Main" outcome reads as. */

function task(overrides: Partial<ActionTask> = {}): ActionTask {
  return {
    status: "queued",
    dispatch_mode: "orchestrated",
    workspace_kind: "repo",
    ...overrides,
  };
}

describe("canSpawnWorker", () => {
  // Pure gating over (dispatch_mode, workspace_kind, status): one row per rule.
  it("offers direct spawning only where a worker can actually be spawned", () => {
    for (const { why, over, offered } of [
      { why: "a queued orchestrated task", over: {}, offered: true },
      { why: "a queued direct task", over: { dispatch_mode: "direct" }, offered: true },
      { why: "a claimed direct task", over: { dispatch_mode: "direct", status: "claimed" }, offered: true },
      // A portfolio parent is decomposed, never worked directly.
      { why: "a portfolio parent", over: { workspace_kind: "portfolio" }, offered: false },
      { why: "a direct portfolio parent", over: { workspace_kind: "portfolio", dispatch_mode: "direct" }, offered: false },
      { why: "a scratch task, which does get spawned directly", over: { workspace_kind: "scratch" }, offered: true },
      { why: "a finished direct task", over: { dispatch_mode: "direct", status: "review" }, offered: false },
    ] as const) {
      expect(canSpawnWorker(task(over as Partial<ActionTask>)), why).toBe(offered);
    }
    // An orchestrated task that has left the queue is main's to re-dispatch.
    for (const status of ["claimed", "in_progress", "review", "done", "cancelled"] as const) {
      expect(canSpawnWorker(task({ status })), status).toBe(false);
    }
  });
});

describe("canNotifyMain", () => {
  it("offers triage notification only on queued orchestrated tasks", () => {
    expect(canNotifyMain(task())).toBe(true);
    expect(canNotifyMain(task({ status: "claimed" }))).toBe(false);
    expect(canNotifyMain(task({ dispatch_mode: "direct" }))).toBe(false);
  });

  it("pairs with the spawn button on a queued orchestrated task", () => {
    const t = task();
    expect([canNotifyMain(t), canSpawnWorker(t)]).toEqual([true, true]);
  });
});

describe("delegateOutcomeNote", () => {
  it("confirms a live delivery as a success", () => {
    expect(delegateOutcomeNote("delivered")).toEqual({
      tone: "ok",
      message: "Sent to Claude Main.",
    });
  });

  it("reports a deferred ping as information, not confirmation", () => {
    const note = delegateOutcomeNote("queued");
    expect(note.tone).toBe("info");
    expect(note.message).toContain("queued");
  });

  it("distinguishes a ping that was already queued", () => {
    const note = delegateOutcomeNote("already_queued");
    expect(note.tone).toBe("info");
    expect(note.message).toContain("already queued");
  });
});
