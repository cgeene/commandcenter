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
  it("offers direct spawning on a queued orchestrated task", () => {
    expect(canSpawnWorker(task())).toBe(true);
  });

  it("still offers it on queued and claimed direct tasks", () => {
    expect(canSpawnWorker(task({ dispatch_mode: "direct" }))).toBe(true);
    expect(canSpawnWorker(task({ dispatch_mode: "direct", status: "claimed" }))).toBe(true);
  });

  it("never offers it on a portfolio parent", () => {
    expect(canSpawnWorker(task({ workspace_kind: "portfolio" }))).toBe(false);
    expect(
      canSpawnWorker(task({ workspace_kind: "portfolio", dispatch_mode: "direct" })),
    ).toBe(false);
  });

  it("offers it on scratch tasks, which do get spawned directly", () => {
    expect(canSpawnWorker(task({ workspace_kind: "scratch" }))).toBe(true);
  });

  it("does not offer it once an orchestrated task has left the queue", () => {
    for (const status of ["claimed", "in_progress", "review", "done", "cancelled"]) {
      expect(canSpawnWorker(task({ status }))).toBe(false);
    }
  });

  it("does not offer it on finished direct tasks", () => {
    expect(canSpawnWorker(task({ dispatch_mode: "direct", status: "review" }))).toBe(false);
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
