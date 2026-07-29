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
    __clearStallSweepLatchForTests,
  } = await import("../src/daemon/hooks.js");
  __clearAutoNudgeCountsForTests();
  __clearIdleRedelegateForTests();
  __clearBackgroundParkForTests();
  __clearStallSweepLatchForTests();
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

/**
 * The retry budget for a failing verify_cmd belongs to the round of work being
 * done now, not to the task's whole history. Counted per lifetime, a task that
 * had used the budget up months of rounds ago blocked on the FIRST failure of a
 * rework round — the worker was never told what failed and never got to fix it.
 */
describe("the verify-retry budget is per work round", () => {
  /** Task in `in_progress` with a worker, a failing verify_cmd, and a result. */
  async function workingTask() {
    const { updateTask } = await import("../src/db/tasks.js");
    const { task, worker } = await reviewTask({ verify_cmd: "false" });
    updateTask(task.id, {
      status: "in_progress",
      result_summary: "round result",
    });
    return { task, worker };
  }

  async function eventKinds(limit = 120) {
    const { listEvents } = await import("../src/db/events.js");
    return listEvents(limit).map((e) => e.kind);
  }

  async function nudgeAttempts(taskId: number) {
    const { listEvents } = await import("../src/db/events.js");
    return listEvents(200)
      .filter((e) => e.task_id === taskId && e.kind === "task.verify_nudged")
      .map((e) => (JSON.parse(e.payload!) as { attempt: number }).attempt)
      .reverse();
  }

  it("nudges the worker on the first failure of a round after a rejection", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { handleVerdict } = await import("../src/daemon/review.js");
    const { getTask, updateTask } = await import("../src/db/tasks.js");
    const { logEvent } = await import("../src/db/events.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    setSchedulerConfig({ review_max_cycles: 6 });
    const { task, worker } = await reviewTask({
      verify_cmd: "false",
      review_cycles: 1,
    });

    // Earlier rounds already burned the whole budget.
    for (const attempt of [1, 2]) {
      logEvent("verify.failed", { taskId: task.id, agentId: worker.id });
      logEvent("task.verify_nudged", {
        taskId: task.id,
        agentId: worker.id,
        payload: { attempt, max: 2 },
      });
    }

    // A reviewer rejects: task.reopened, worker back to work — a new round.
    await handleVerdict(task.id, 99, "reject", "round notes");
    expect(getTask(task.id)!.status).toBe("in_progress");
    updateTask(task.id, { result_summary: "rework result" });
    sendText.mockClear();

    await handleHookEvent(worker.id, { hook_event_name: "Stop" });

    // The failure output went back into the worker's session, and the task is
    // still being worked rather than blocked with nobody told why.
    expect(await nudgeAttempts(task.id)).toEqual([1, 2, 1]);
    expect(sendText).toHaveBeenCalled();
    expect(getTask(task.id)!.status).toBe("in_progress");
    expect(await eventKinds()).not.toContain("task.blocked");
  });

  it("gives a requeued task a fresh budget after it blocked in an earlier round", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { getTask, updateTask } = await import("../src/db/tasks.js");
    const { logEvent } = await import("../src/db/events.js");
    const { task, worker } = await workingTask();

    // Three failures in one round: two nudges, then the block.
    for (let i = 0; i < 3; i++) {
      await handleHookEvent(worker.id, { hook_event_name: "Stop" });
    }
    expect(getTask(task.id)!.status).toBe("blocked");
    expect(await nudgeAttempts(task.id)).toEqual([1, 2]);

    // A human requeues it and a worker picks it up again.
    updateTask(task.id, { status: "in_progress" });
    logEvent("task.requeued", { taskId: task.id });

    await handleHookEvent(worker.id, { hook_event_name: "Stop" });

    expect(await nudgeAttempts(task.id)).toEqual([1, 2, 1]);
    expect(getTask(task.id)!.status).toBe("in_progress");
  });

  it("still blocks a task that fails three times inside one round", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { task, worker } = await workingTask();

    for (const expected of ["in_progress", "in_progress", "blocked"]) {
      await handleHookEvent(worker.id, { hook_event_name: "Stop" });
      expect(getTask(task.id)!.status).toBe(expected);
    }

    expect(await nudgeAttempts(task.id)).toEqual([1, 2]);
    const blocked = listEvents(200).find((e) => e.kind === "task.blocked");
    expect(blocked?.task_id).toBe(task.id);
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

  const attentionAt = async (nowMs: number) => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    return deriveAttention({
      now: new Date(nowMs),
      isPrOpen: () => false,
    }).filter((i) => i.kind === "stalled_transition");
  };

  /** deriveAttention past the sweep's grace period. */
  const attentionLater = async () => attentionAt(LATER());

  // The Needs You item is derived from the same live state the sweep runs on —
  // no event marker — so nothing the sweep logs can bury it. These cases set up
  // only the stranded situation itself and let the real code produce (or clear)
  // the item.
  for (const verify_cmd of [undefined, "true"]) {
    const shape = verify_cmd ? `verify_cmd ${verify_cmd}` : "no verify_cmd";

    it(`raises a Needs You item for a stranded worker (${shape}), before any sweep`, async () => {
      const { task } = await strandedTask({ verify_cmd });
      const items = await attentionLater();
      expect(items.length).toBe(1);
      expect(items[0].task_id).toBe(task.id);
      expect(items[0].title).toContain(`#${task.id}`);
    });

    it(`clears the item once the sweep actually moves the task (${shape})`, async () => {
      const { stalledTransitionSweep } = await import("../src/daemon/hooks.js");
      const { getTask } = await import("../src/db/tasks.js");
      const { task } = await strandedTask({ verify_cmd });
      expect((await attentionLater()).length).toBe(1);

      await stalledTransitionSweep({ nowMs: LATER() });

      // Gone because the task genuinely left in_progress, not because an event
      // masked it — assert the new status so this cannot pass for that reason.
      expect(getTask(task.id)!.status).toBe("review");
      expect(await attentionLater()).toEqual([]);
    });
  }

  it("keeps the item up when a rescue ran and the task is still stranded", async () => {
    // The rescue's own markers, and nothing else. Reached in production when
    // the re-drive throws (see task.transition_retry_failed) — constructed here
    // because a re-drive that completes always moves the task. This is the
    // exact shape that a marker-anchored item got wrong: the sweep buried its
    // own finding.
    const { stalledFinishedWorkers } = await import("../src/daemon/hooks.js");
    const { logEvent } = await import("../src/db/events.js");
    const { task } = await strandedTask();
    logEvent("task.transition_stalled", { taskId: task.id });
    logEvent("task.transition_retry_failed", { taskId: task.id });

    expect(stalledFinishedWorkers(LATER()).map((s) => s.task.id)).toEqual([task.id]);
    expect((await attentionLater()).length).toBe(1);
  });

  // The whole path for real: the worker stops, its verify_cmd fails, the Stop
  // hook nudges it back to work, and the sweep runs afterwards. Nothing is
  // hand-logged — a worker mid-fix must not be called stalled, and must not
  // have verify re-run underneath it.
  it("never touches a worker the failing-verify nudge just put back to work", async () => {
    const { handleHookEvent, stalledTransitionSweep, stalledFinishedWorkers } =
      await import("../src/daemon/hooks.js");
    const { getTask, updateTask } = await import("../src/db/tasks.js");
    const { getAgent } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    const { task, worker } = await reviewTask({ verify_cmd: "false" });
    updateTask(task.id, {
      status: "in_progress",
      result_summary: "round 2 result",
    });

    await handleHookEvent(worker.id, { hook_event_name: "Stop" });

    // The Stop hook ran verify, it failed, and the worker was nudged.
    const afterStop = listEvents(50).map((e) => e.kind);
    expect(afterStop).toContain("verify.failed");
    expect(afterStop).toContain("task.verify_nudged");
    expect(getTask(task.id)!.status).toBe("in_progress");
    expect(getAgent(worker.id)?.state).toBe("working");
    expect(sendText).toHaveBeenCalled(); // the fix list went into its session

    expect(stalledFinishedWorkers(LATER())).toEqual([]);
    expect(await attentionLater()).toEqual([]);

    await stalledTransitionSweep({ nowMs: LATER() });

    const kinds = listEvents(80).map((e) => e.kind);
    expect(kinds).not.toContain("task.transition_stalled");
    // No second verify run racing the worker's edits, and no promotion of the
    // result_summary it is still rewriting.
    expect(kinds.filter((k) => k === "verify.started").length).toBe(1);
    expect(getTask(task.id)!.status).toBe("in_progress");
    expect(spawnReviewer).not.toHaveBeenCalled();
  });

  // A daemon killed inside runVerify — the likeliest way to strand a task,
  // since the Stop handler blocks there for minutes. It leaves a verify.started
  // that never resolves, and treating that as "a verify is running" forever
  // would hide the exact stall this sweep exists for.
  it("rescues a task whose verify.started never got an outcome", async () => {
    const { stalledFinishedWorkers, stalledTransitionSweep, verifyInFlight } =
      await import("../src/daemon/hooks.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { logEvent, listEvents } = await import("../src/db/events.js");
    const { task, worker } = await strandedTask({ verify_cmd: "true" });
    logEvent("verify.started", { agentId: worker.id, taskId: task.id });

    // Past VERIFY_STALE_MS (runVerify's timeout + 2m), so no run can still be up.
    const long = Date.now() + 24 * 3600_000;
    expect(verifyInFlight(task.id, long)).toBe(false);
    expect(stalledFinishedWorkers(long).map((s) => s.task.id)).toEqual([task.id]);
    expect(await attentionAt(long)).toHaveLength(1);

    await stalledTransitionSweep({ nowMs: long });

    expect(getTask(task.id)!.status).toBe("review");
    expect(listEvents(60).map((e) => e.kind)).toContain("task.transition_stalled");
    expect(await attentionAt(long)).toEqual([]);
  });

  it("does not flag a worker that is mid-turn", async () => {
    const { stalledFinishedWorkers } = await import("../src/daemon/hooks.js");
    const { updateAgent } = await import("../src/db/agents.js");
    const { worker } = await strandedTask();
    expect(stalledFinishedWorkers(LATER()).length).toBe(1);
    updateAgent(worker.id, { state: "working" });
    expect(stalledFinishedWorkers(LATER())).toEqual([]);
  });

  // A late verdict has somewhere to go only while the task is non-terminal.
  // `queued` is what a rejection's requeue leaves behind, so it is the status a
  // late verdict is most likely to land on; on `done`/`cancelled` a verdict has
  // nothing left to change, so raising an item would be noise.
  it("raises a verdict-refused item only while the task can still act on it", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const { logEvent } = await import("../src/db/events.js");
    const { updateTask } = await import("../src/db/tasks.js");
    const { getDb } = await import("../src/db/db.js");

    for (const { status, raised } of [
      { status: "blocked", raised: true },
      { status: "queued", raised: true },
      { status: "in_progress", raised: true },
      { status: "done", raised: false },
      { status: "cancelled", raised: false },
    ] as const) {
      // Per-row isolation: the item is derived from live task state, so a task
      // left by the previous status would raise its own item and be found first.
      getDb().prepare("DELETE FROM events").run();
      getDb().prepare("UPDATE tasks SET agent_id = NULL").run();
      getDb().prepare("DELETE FROM agents").run();
      getDb().prepare("DELETE FROM tasks").run();
      const { task } = await reviewTask();
      updateTask(task.id, { status });
      logEvent("review.verdict_unsubmittable", {
        taskId: task.id,
        payload: { task_status: status },
      });

      const item = deriveAttention({ isPrOpen: () => false }).find(
        (i) => i.kind === "stalled_transition",
      );
      if (!raised) {
        expect(item, status).toBeUndefined();
        continue;
      }
      expect(item?.task_id, status).toBe(task.id);
      expect(item?.title, status).toContain("Reviewer verdict blocked");
      expect(item?.context, status).toContain(status);
    }
  });
});
