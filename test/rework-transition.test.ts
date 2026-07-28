import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The post-rejection rework round: a worker that already used one or more
 * review cycles finishes its fix, writes result_summary, and stops. It must
 * reach `review` and be reviewable again — and while the platform is still
 * deciding that, it must never look like a worker asking a question.
 */

const sendText = vi.fn(async () => {});
let paneContent = "";
vi.mock("../src/daemon/tmux.js", () => ({
  windowExists: () => true,
  sendText: (...a: unknown[]) => sendText(...a),
  sendEnter: () => {},
  capturePane: () => paneContent,
  killWindow: () => [],
  paneProcess: () => null,
}));

// Reviewer spawns are stubbed: the loop's decision to spawn is what matters
// here, not a real tmux window or review worktree.
const spawnReviewer = vi.fn((_taskId: number, _opts?: unknown) => ({
  agent: { id: 999 },
  task: {},
}));
vi.mock("../src/daemon/spawn.js", () => ({
  spawnReviewer: (id: number, opts?: unknown) => spawnReviewer(id, opts),
  killAgent: () => {},
}));

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-rework-"));
  process.env.CC_DATA_DIR = tmpDir;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  sendText.mockClear();
  spawnReviewer.mockClear();
  paneContent = "";
  const {
    __clearAutoNudgeCountsForTests,
    __clearIdleRedelegateForTests,
    __clearBackgroundParkForTests,
  } = await import("../src/daemon/hooks.js");
  __clearAutoNudgeCountsForTests();
  __clearIdleRedelegateForTests();
  __clearBackgroundParkForTests();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A scratch task in `review` with a live worker. Scratch so the review loop
 *  judges result_summary and needs no git repo or PR. */
async function reviewTask(fields: { review_cycles?: number; verify_cmd?: string } = {}) {
  const { createTask, updateTask } = await import("../src/db/tasks.js");
  const { createAgent } = await import("../src/db/agents.js");
  const task = createTask({
    title: "t",
    prompt: "x",
    repo: tmpDir,
    open_pr: false,
    workspace_kind: "scratch",
    verify_cmd: fields.verify_cmd,
  });
  const worker = createAgent({
    kind: "worker",
    state: "idle",
    task_id: task.id,
    tmux_target: "cc:@5",
  });
  updateTask(task.id, {
    status: "review",
    agent_id: worker.id,
    worktree: tmpDir,
    result_summary: "round 1 result",
    review_cycles: fields.review_cycles ?? 0,
    review_result_hash: null,
  });
  return { task, worker };
}

describe("rework round re-enters review", () => {
  // Each cycle count is its own case: the original failure only ever showed up
  // on rounds that already had a rejection behind them.
  for (const cycles of [1, 2]) {
    it(`a resumed worker's rework at review_cycles ${cycles} reaches review and is reviewable`, async () => {
      const { handleVerdict, maybeAutoReview } = await import(
        "../src/daemon/review.js"
      );
      const { handleHookEvent } = await import("../src/daemon/hooks.js");
      const { getTask, updateTask } = await import("../src/db/tasks.js");
      const { setSchedulerConfig } = await import("../src/db/settings.js");
      setSchedulerConfig({ review_max_cycles: 6 });
      const { task, worker } = await reviewTask({ review_cycles: cycles - 1 });

      await handleVerdict(task.id, 99, "reject", "round notes");
      expect(getTask(task.id)!.status).toBe("in_progress");
      expect(getTask(task.id)!.review_cycles).toBe(cycles);

      // The rework: a new result, then the worker ends its turn.
      updateTask(task.id, { result_summary: `round ${cycles + 1} result` });
      await handleHookEvent(worker.id, { hook_event_name: "Stop" });

      expect(getTask(task.id)!.status).toBe("review");
      await maybeAutoReview(task.id);
      expect(spawnReviewer).toHaveBeenCalledWith(task.id, undefined);
    });
  }

  it("a requeued-then-respawned worker's rework also reaches review", async () => {
    const { handleVerdict, maybeAutoReview } = await import(
      "../src/daemon/review.js"
    );
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { getTask, updateTask } = await import("../src/db/tasks.js");
    const { createAgent, updateAgent } = await import("../src/db/agents.js");
    const { logEvent } = await import("../src/db/events.js");
    const { task, worker } = await reviewTask({ review_cycles: 1 });

    // Feedback delivery fails -> requeue (the path both reported tasks took).
    sendText.mockRejectedValueOnce(new Error("no window"));
    await handleVerdict(task.id, 99, "reject", "round notes");
    expect(getTask(task.id)!.status).toBe("queued");
    updateAgent(worker.id, { state: "dead" });

    // What spawnWorker does on the respawn: fresh agent, task back in progress.
    const respawned = createAgent({
      kind: "worker",
      state: "working",
      task_id: task.id,
      tmux_target: "cc:@6",
    });
    updateTask(task.id, { status: "in_progress", agent_id: respawned.id });
    logEvent("agent.spawned", { agentId: respawned.id, taskId: task.id });

    updateTask(task.id, { result_summary: "round 3 result" });
    await handleHookEvent(respawned.id, { hook_event_name: "Stop" });

    expect(getTask(task.id)!.status).toBe("review");
    await maybeAutoReview(task.id);
    expect(spawnReviewer).toHaveBeenCalledWith(task.id, undefined);
  });

  it("an unchanged result still reaches review, but does not re-spawn a reviewer", async () => {
    const { handleVerdict, maybeAutoReview } = await import(
      "../src/daemon/review.js"
    );
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { hashResult } = await import("../src/daemon/reviewstate.js");
    const { updateTask } = await import("../src/db/tasks.js");
    const { task, worker } = await reviewTask({ review_cycles: 1 });
    // The last round judged exactly this result_summary.
    updateTask(task.id, { review_result_hash: hashResult("round 1 result") });

    await handleVerdict(task.id, 99, "reject", "round notes");
    // Worker re-submits without changing anything.
    await handleHookEvent(worker.id, { hook_event_name: "Stop" });

    // The dedupe belongs to the reviewer spawn, NOT to the status transition:
    // stranding it in in_progress is what left these tasks with nothing to
    // move them at all.
    expect(getTask(task.id)!.status).toBe("review");
    await maybeAutoReview(task.id);
    expect(spawnReviewer).not.toHaveBeenCalled();
  });
});

describe("the verify window is not a wait", () => {
  it("an idle ping while verify_cmd is running is suppressed, not delegated", async () => {
    const { handleHookEvent, verifyInFlight } = await import(
      "../src/daemon/hooks.js"
    );
    const { getAgent } = await import("../src/db/agents.js");
    const { logEvent, listEvents } = await import("../src/db/events.js");
    const { task, worker } = await reviewTask({ review_cycles: 1 });
    const { updateTask } = await import("../src/db/tasks.js");
    updateTask(task.id, { status: "in_progress" });

    // Mid-runVerify: the Stop hook is still blocked on the command.
    logEvent("hook.stop", { agentId: worker.id, taskId: task.id });
    logEvent("verify.started", { agentId: worker.id, taskId: task.id });
    expect(verifyInFlight(task.id)).toBe(true);

    await handleHookEvent(worker.id, {
      hook_event_name: "Notification",
      notification_type: "idle_prompt",
      message: "Claude is waiting for your input",
    });

    // idle, not waiting_input: neither the escalation watchdog nor Needs You
    // treats a worker whose own verify is still running as blocked on a human.
    expect(getAgent(worker.id)?.state).toBe("idle");
    const kinds = listEvents(20).map((e) => e.kind);
    expect(kinds).toContain("waiting.suppressed_verifying");
    expect(kinds).not.toContain("waiting.delegated");
  });

  it("a finished verify stops suppressing — a real wait still escalates", async () => {
    const { handleHookEvent, verifyInFlight } = await import(
      "../src/daemon/hooks.js"
    );
    const { getAgent } = await import("../src/db/agents.js");
    const { logEvent } = await import("../src/db/events.js");
    const { updateTask } = await import("../src/db/tasks.js");
    const { task, worker } = await reviewTask({ review_cycles: 1 });
    updateTask(task.id, { status: "in_progress" });

    logEvent("hook.stop", { agentId: worker.id, taskId: task.id });
    logEvent("verify.started", { agentId: worker.id, taskId: task.id });
    logEvent("verify.failed", { agentId: worker.id, taskId: task.id });
    expect(verifyInFlight(task.id)).toBe(false);

    await handleHookEvent(worker.id, {
      hook_event_name: "Notification",
      notification_type: "idle_prompt",
      message: "Claude is waiting for your input",
    });
    expect(getAgent(worker.id)?.state).toBe("waiting_input");
  });

  it("a verify.started left behind by a dead daemon stops counting as in flight", async () => {
    const { verifyInFlight } = await import("../src/daemon/hooks.js");
    const { logEvent } = await import("../src/db/events.js");
    const { task, worker } = await reviewTask();
    logEvent("verify.started", { agentId: worker.id, taskId: task.id });
    expect(verifyInFlight(task.id, Date.now() + 60 * 60_000)).toBe(false);
  });
});

describe("stalledTransitionSweep", () => {
  /** A finished worker whose Stop never produced a transition: result written,
   *  task still in_progress, nothing running. `stopAgeMs` ages the Stop past
   *  the sweep's grace period. */
  async function strandedTask(opts: { verify_cmd?: string } = {}) {
    const { updateTask } = await import("../src/db/tasks.js");
    const { logEvent } = await import("../src/db/events.js");
    const { task, worker } = await reviewTask({ verify_cmd: opts.verify_cmd });
    updateTask(task.id, {
      status: "in_progress",
      result_summary: "rework done, PR pushed",
    });
    logEvent("hook.stop", { agentId: worker.id, taskId: task.id });
    return { task, worker };
  }

  const LATER = () => Date.now() + 5 * 60_000;

  it("promotes a stranded finished worker to review and says so loudly", async () => {
    const { stalledTransitionSweep } = await import("../src/daemon/hooks.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { task } = await strandedTask();

    await stalledTransitionSweep({ nowMs: LATER() });

    expect(getTask(task.id)!.status).toBe("review");
    const kinds = listEvents(30).map((e) => e.kind);
    expect(kinds).toContain("task.transition_stalled");
  });

  it("re-runs verify_cmd rather than promoting unverified work", async () => {
    const { stalledTransitionSweep } = await import("../src/daemon/hooks.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { task } = await strandedTask({ verify_cmd: "true" });

    await stalledTransitionSweep({ nowMs: LATER() });

    const kinds = listEvents(30).map((e) => e.kind);
    expect(kinds).toContain("verify.started");
    expect(kinds).toContain("verify.passed");
    expect(getTask(task.id)!.status).toBe("review");
  });

  it("leaves a verify that is genuinely still running alone", async () => {
    const { stalledTransitionSweep } = await import("../src/daemon/hooks.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { logEvent } = await import("../src/db/events.js");
    const { task, worker } = await strandedTask({ verify_cmd: "true" });
    logEvent("verify.started", { agentId: worker.id, taskId: task.id });

    await stalledTransitionSweep({ nowMs: Date.now() + 60_000 });

    expect(getTask(task.id)!.status).toBe("in_progress");
    expect(listEvents(30).map((e) => e.kind)).not.toContain(
      "task.transition_stalled",
    );
  });

  it("ignores a Stop still inside the grace period", async () => {
    const { stalledTransitionSweep } = await import("../src/daemon/hooks.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { task } = await strandedTask();
    await stalledTransitionSweep(); // Stop is seconds old
    expect(getTask(task.id)!.status).toBe("in_progress");
  });

  it("ignores a worker with no result and one that was already steered", async () => {
    const { stalledTransitionSweep } = await import("../src/daemon/hooks.js");
    const { getTask, updateTask } = await import("../src/db/tasks.js");
    const { logEvent, listEvents } = await import("../src/db/events.js");
    const { task: noResult } = await strandedTask();
    updateTask(noResult.id, { result_summary: null });
    const { task: steered, worker } = await strandedTask();
    logEvent("agent.sent", { agentId: worker.id, taskId: steered.id });

    await stalledTransitionSweep({ nowMs: LATER() });

    expect(getTask(noResult.id)!.status).toBe("in_progress");
    expect(getTask(steered.id)!.status).toBe("in_progress");
    expect(listEvents(40).map((e) => e.kind)).not.toContain(
      "task.transition_stalled",
    );
  });

  it("fires at most once per Stop", async () => {
    const { stalledTransitionSweep } = await import("../src/daemon/hooks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { updateTask } = await import("../src/db/tasks.js");
    const { task } = await strandedTask();

    await stalledTransitionSweep({ nowMs: LATER() });
    updateTask(task.id, { status: "in_progress" }); // pretend it slid back
    await stalledTransitionSweep({ nowMs: LATER() });

    const stalls = listEvents(50).filter((e) => e.kind === "task.transition_stalled");
    expect(stalls.length).toBe(1);
  });

  it("raises a Needs You item while the task is stuck", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const { logEvent } = await import("../src/db/events.js");
    const { task } = await strandedTask();
    logEvent("task.transition_stalled", { taskId: task.id });

    const items = deriveAttention({ isPrOpen: () => false });
    const item = items.find((i) => i.kind === "stalled_transition");
    expect(item).toBeDefined();
    expect(item!.task_id).toBe(task.id);
    expect(item!.title).toContain(`#${task.id}`);
  });

  it("the Needs You item clears once something moves the task", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const { logEvent } = await import("../src/db/events.js");
    const { task } = await strandedTask();
    logEvent("task.transition_stalled", { taskId: task.id });
    logEvent("verify.started", { taskId: task.id });

    expect(
      deriveAttention({ isPrOpen: () => false }).some(
        (i) => i.kind === "stalled_transition",
      ),
    ).toBe(false);
  });

  it("raises a Needs You item for a verdict the task's status refused", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const { logEvent } = await import("../src/db/events.js");
    const { updateTask } = await import("../src/db/tasks.js");
    const { task } = await reviewTask();
    updateTask(task.id, { status: "blocked" });
    logEvent("review.verdict_unsubmittable", {
      taskId: task.id,
      payload: { task_status: "blocked" },
    });

    const item = deriveAttention({ isPrOpen: () => false }).find(
      (i) => i.kind === "stalled_transition",
    );
    expect(item?.task_id).toBe(task.id);
    expect(item?.title).toContain("Reviewer verdict blocked");
  });
});
