import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sendText = vi.fn(async () => {});
const killWindow = vi.fn((_target: string) => [] as number[]);
const sweepVanishedPaneGroup = vi.fn(() => ({
  outcome: "clean" as const,
  killed: [] as number[],
}));

vi.mock("../src/daemon/proctree.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/daemon/proctree.js")>()),
  sweepVanishedPaneGroup: (...args: unknown[]) =>
    sweepVanishedPaneGroup(...(args as [])),
}));

vi.mock("../src/daemon/tmux.js", () => ({
  sendText: (...args: unknown[]) => sendText(...args),
  sendEnter: vi.fn(async () => {}),
  windowExists: () => true,
  capturePane: () => "",
  killWindow: (target: string) => killWindow(target),
  tmuxFailureCode: (error: unknown) =>
    (error as { code?: string })?.code ?? "failed",
}));

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-delivery-"));
  process.env.CC_DATA_DIR = tmpDir;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  sendText.mockReset();
  killWindow.mockReset();
  killWindow.mockReturnValue([]);
  sweepVanishedPaneGroup.mockReset();
  sweepVanishedPaneGroup.mockReturnValue({ outcome: "clean", killed: [] });
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("review rejection delivery failure", () => {
  it("requeues with the reviewer evidence and frees the worker slot", async () => {
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    const { createTask, getTask, updateTask } = await import("../src/db/tasks.js");
    const { handleVerdict } = await import("../src/daemon/review.js");
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    const worker = createAgent({
      kind: "worker",
      state: "idle",
      task_id: task.id,
      tmux_target: "cc:@7",
    });
    updateTask(task.id, {
      status: "review",
      agent_id: worker.id,
      branch: `agent/task-${task.id}`,
      result_summary: "claimed complete",
    });
    sendText.mockRejectedValueOnce(
      Object.assign(new Error("must not escape"), { code: "timeout" }),
    );

    await handleVerdict(task.id, 99, "reject", "the timeout path loses state");

    expect(getTask(task.id)).toMatchObject({
      status: "queued",
      agent_id: null,
      review_verdict: null,
      review_notes: "the timeout path loses state",
      review_cycles: 1,
    });
    expect(getAgent(worker.id)?.state).toBe("dead");
    expect(listEvents(20).map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        "review.feedback_delivery_failed",
        "task.requeued",
      ]),
    );
  });

  it("still requeues with the notes when the worker cannot be torn down either", async () => {
    // This path is reached BECAUSE tmux would not take the notes, so the same
    // tmux is what fails the teardown a line later. If that could throw, the
    // rejection would already be logged while the task stayed in review with
    // no verdict, no notes and no cycle recorded — stranded, and nothing scans
    // for it.
    const { createAgent, getAgent, updateAgent } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    const { createTask, getTask, updateTask } = await import("../src/db/tasks.js");
    const { handleVerdict } = await import("../src/daemon/review.js");
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    const worker = createAgent({
      kind: "worker",
      state: "idle",
      task_id: task.id,
      tmux_target: "cc:@7",
    });
    updateTask(task.id, {
      status: "review",
      agent_id: worker.id,
      branch: `agent/task-${task.id}`,
      result_summary: "claimed complete",
    });
    sendText.mockRejectedValueOnce(
      Object.assign(new Error("must not escape"), { code: "timeout" }),
    );
    killWindow.mockImplementation(() => {
      throw Object.assign(new Error("must not escape"), { code: "timeout" });
    });
    // The full shape: a recorded pane pid whose shell is alive and still leads
    // its group, so the sweep declines and the provider really is still up.
    updateAgent(worker.id, { pane_pid: 4242 });
    sweepVanishedPaneGroup.mockReturnValue({ outcome: "declined", killed: [] });

    await handleVerdict(task.id, 99, "reject", "tmux is down for both steps");

    expect(getTask(task.id)).toMatchObject({
      status: "queued",
      agent_id: null,
      review_notes: "tmux is down for both steps",
      review_cycles: 1,
    });
    expect(getAgent(worker.id)?.state).toBe("dead");
    // The handle has to survive — it is what the watchdog's retry chases, and
    // what the Needs-You item is derived from.
    expect(getAgent(worker.id)?.pane_pid).toBe(4242);
    // Not silent: the teardown it could not confirm is on the record.
    expect(listEvents(20).map((event) => event.kind)).toEqual(
      expect.arrayContaining(["agent.kill_unconfirmed", "task.requeued"]),
    );
  });
});
