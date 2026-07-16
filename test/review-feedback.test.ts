import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A live worker has a real tmux window: windowExists=true and sendText a
// no-op, so resumeAgent delivers ("sent"). This exercises the reviewer-
// rejection → live-worker-feedback path that the reaped-worker tests can't.
const sendText = vi.fn(async () => {});
vi.mock("../src/daemon/tmux.js", () => ({
  windowExists: () => true,
  sendText: (...a: unknown[]) => sendText(...a),
  sendEnter: () => {},
  capturePane: () => "",
  killWindow: () => {},
}));

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-revfb-"));
  process.env.CC_DATA_DIR = tmpDir;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  sendText.mockClear();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("reject → worker feedback", () => {
  it("a LIVE worker is resumed in-session with the reviewer notes", async () => {
    const { handleVerdict } = await import("../src/daemon/review.js");
    const { createTask, updateTask, getTask } = await import("../src/db/tasks.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    const task = createTask({ title: "t", prompt: "x", repo: "/r", open_pr: false });
    // live worker: has a tmux window (mock makes windowExists true)
    const worker = createAgent({
      kind: "worker",
      state: "idle",
      task_id: task.id,
      tmux_target: "cc:@5",
    });
    updateTask(task.id, {
      status: "review",
      agent_id: worker.id,
      branch: `agent/task-${task.id}`,
      result_summary: "done",
    });

    await handleVerdict(task.id, 99, "reject", "fix the empty-input case");

    const t = getTask(task.id)!;
    expect(t.status).toBe("in_progress"); // resumed in place, NOT requeued
    expect(t.agent_id).toBe(worker.id); // same worker keeps the task
    expect(t.review_verdict).toBeNull(); // cleared for a fresh next round
    expect(t.review_cycles).toBe(1);
    // the notes were delivered into the worker's session
    expect(sendText).toHaveBeenCalledOnce();
    expect(sendText.mock.calls[0][1]).toContain("fix the empty-input case");
    expect(listEvents(10).map((e) => e.kind)).toContain("task.reopened");
  });

  it("a REAPED worker is requeued with the notes baked into the respawn prompt", async () => {
    const { handleVerdict } = await import("../src/daemon/review.js");
    const { createTask, updateTask, getTask } = await import("../src/db/tasks.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { _buildWorkerPromptForTest } = await import("../src/daemon/spawn.js");
    const task = createTask({ title: "t", prompt: "x", repo: "/r", open_pr: false });
    // reaped worker: dead, so resumeAgent -> not_live -> requeue path
    const worker = createAgent({ kind: "worker", state: "dead", task_id: task.id });
    updateTask(task.id, {
      status: "review",
      agent_id: worker.id,
      branch: `agent/task-${task.id}`,
      result_summary: "done",
    });

    await handleVerdict(task.id, 99, "reject", "restore the deleted retry test");

    const t = getTask(task.id)!;
    expect(t.status).toBe("queued");
    expect(t.agent_id).toBeNull();
    expect(t.review_cycles).toBe(1);
    expect(sendText).not.toHaveBeenCalled(); // nothing live to resume
    // the respawn prompt carries the reviewer's notes as the fix list
    const prompt = _buildWorkerPromptForTest(t, t.branch);
    expect(prompt).toContain("REJECTED");
    expect(prompt).toContain("restore the deleted retry test");
  });
});
