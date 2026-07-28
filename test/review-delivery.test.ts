import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sendText = vi.fn(async () => {});

vi.mock("../src/daemon/tmux.js", () => ({
  sendText: (...args: unknown[]) => sendText(...args),
  sendEnter: vi.fn(async () => {}),
  windowExists: () => true,
  capturePane: () => "",
  killWindow: vi.fn(() => []),
}));

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-delivery-"));
  process.env.CC_DATA_DIR = tmpDir;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  sendText.mockReset();
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
});
