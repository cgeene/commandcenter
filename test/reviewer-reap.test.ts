import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// These tests run the real spawnReviewer, so the only things stubbed are the
// ones that would reach outside the process: tmux, the provider config files,
// and transcript discovery. The tasks are SCRATCH tasks on purpose — a reviewer
// for one needs no git repo and no review worktree, which keeps this suite off
// the git-subprocess budget the rest of the suite is already competing for.
vi.mock("../src/daemon/tmux.js", () => ({
  newWindow: () => "cc:@review",
  windowExists: () => true,
  killWindow: () => [],
  paneProcess: () => null,
  capturePane: () => "",
  sendText: async () => {},
  sendEnter: async () => {},
  clearInputLine: async () => {},
  ensureSession: () => {},
  listWindowIds: () => [],
  listLiveWindowIds: () => [],
}));

vi.mock("../src/daemon/genconfig.js", () => ({
  writeCodexConfig: () => ({
    profileFile: "/tmp/commandcenter.config.toml",
    inheritedMcpEnvVars: [],
  }),
  writeMcpConfigFile: () => "/tmp/commandcenter.mcp.json",
  writeSettingsFile: () => "/tmp/commandcenter.settings.json",
}));

vi.mock("../src/daemon/transcript.js", () => ({
  findProviderTranscript: () => undefined,
}));

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-reviewer-reap-"));
  process.env.CC_DATA_DIR = path.join(tmpDir, "data");
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  const { _resetSchedulerState } = await import("../src/daemon/scheduler.js");
  _resetSchedulerState();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A scratch task sitting in review with a reviewable deliverable. */
async function reviewTask(n: number, fields: Record<string, unknown> = {}) {
  const { createTask, updateTask } = await import("../src/db/tasks.js");
  const { allocateScratchWorkspace } = await import(
    "../src/daemon/workspaces.js"
  );
  const task = createTask({
    title: `t${n}`,
    prompt: "x",
    repo: allocateScratchWorkspace(),
    workspace_kind: "scratch",
    open_pr: false,
  });
  updateTask(task.id, {
    status: "review",
    result_summary: "claims done",
    ...fields,
  });
  return { taskId: task.id };
}

async function makeReviewer(
  taskId: number,
  fields: { state?: string; tmux_target?: string | null } = {},
) {
  const { createAgent } = await import("../src/db/agents.js");
  return createAgent({
    kind: "reviewer",
    state: (fields.state ?? "working") as "working",
    task_id: taskId,
    ...(fields.tmux_target === null
      ? {}
      : { tmux_target: fields.tmux_target ?? "cc:@review" }),
  });
}

/** Mark a reviewer as having ended its turn without submitting, exactly as
 *  hooks.reviewerStopped does once auto-nudge recovery is exhausted. */
async function stoppedIncomplete(agentId: number, taskId: number) {
  const { logEvent } = await import("../src/db/events.js");
  const { updateAgent } = await import("../src/db/agents.js");
  logEvent("reviewer.stopped_incomplete", { agentId, taskId });
  updateAgent(agentId, { state: "idle" });
}

function watchdogDeps(overrides: Record<string, unknown> = {}) {
  const killed: number[] = [];
  const revived: number[] = [];
  const recovered: number[] = [];
  return {
    killed,
    revived,
    recovered,
    deps: {
      spawn: () => {},
      kill: (id: number) => killed.push(id),
      revive: (a: { id: number }) => revived.push(a.id),
      recoverReview: (a: { id: number }) => recovered.push(a.id),
      pendingPermission: () => null,
      windowIds: () => ["cc:@review"],
      now: () => new Date(),
      ...overrides,
    },
  };
}

describe("spawn_reviewer refusal", () => {
  it("names the reviewer that owns the task instead of failing opaquely", async () => {
    const { spawnReviewer, ReviewerSpawnError } = await import(
      "../src/daemon/spawn.js"
    );
    const { taskId } = await reviewTask(1);
    const reviewer = await makeReviewer(taskId, { state: "working" });

    let thrown: unknown;
    try {
      spawnReviewer(taskId);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ReviewerSpawnError);
    const err = thrown as InstanceType<typeof ReviewerSpawnError>;
    expect(err.message).toContain(`a${reviewer.id}`);
    expect(err.message).toContain("already has a live reviewer");
    expect(err.httpStatus).toBe(409);
    expect(err.reviewerAgentId).toBe(reviewer.id);
  });

  it("still refuses a task that is not in review, with the reason", async () => {
    const { spawnReviewer, ReviewerSpawnError } = await import(
      "../src/daemon/spawn.js"
    );
    const { updateTask } = await import("../src/db/tasks.js");
    const { taskId } = await reviewTask(2);
    updateTask(taskId, { status: "in_progress" });

    expect(() => spawnReviewer(taskId)).toThrow(ReviewerSpawnError);
    expect(() => spawnReviewer(taskId)).toThrow(/only tasks in review/);
  });

  it("does not count a reviewer that stopped without a verdict", async () => {
    const { spawnReviewer } = await import("../src/daemon/spawn.js");
    const { taskId } = await reviewTask(3);
    const zombie = await makeReviewer(taskId);
    await stoppedIncomplete(zombie.id, taskId);

    const { agent } = spawnReviewer(taskId);
    expect(agent.id).not.toBe(zombie.id);
    expect(agent.kind).toBe("reviewer");
  });

  it("does not count a reviewer whose spawn never reached a pane", async () => {
    const { spawnReviewer } = await import("../src/daemon/spawn.js");
    const { taskId } = await reviewTask(4);
    const paneless = await makeReviewer(taskId, {
      state: "spawning",
      tmux_target: null,
    });

    const { agent } = spawnReviewer(taskId);
    expect(agent.id).not.toBe(paneless.id);
  });
});

describe("a reviewer ending its turn without a verdict", () => {
  it("is recorded and left alive for the human, not killed on the spot", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { getAgent } = await import("../src/db/agents.js");
    const { taskId } = await reviewTask(13);
    const reviewer = await makeReviewer(taskId, { state: "working" });

    await handleHookEvent(reviewer.id, { hook_event_name: "Stop" });

    const stopped = listEvents(50).filter(
      (e) => e.kind === "reviewer.stopped_incomplete",
    );
    expect(stopped.length).toBe(1);
    expect(stopped[0].agent_id).toBe(reviewer.id);
    // The reap is the watchdog's job, after the grace period — the hook itself
    // leaves the session up so the human can look at it.
    expect(getAgent(reviewer.id)?.state).toBe("idle");
  });
});

describe("watchdog reviewer reap", () => {
  it("reaps a reviewer that stopped without a verdict, once the grace is up", async () => {
    const { watchdog } = await import("../src/daemon/scheduler.js");
    const { listEvents } = await import("../src/db/events.js");
    const { taskId } = await reviewTask(5);
    const zombie = await makeReviewer(taskId);
    await stoppedIncomplete(zombie.id, taskId);

    const early = watchdogDeps();
    watchdog(early.deps);
    expect(early.killed).toEqual([]);
    expect(early.recovered).toEqual([]);

    const late = watchdogDeps({
      now: () => new Date(Date.now() + 11 * 60_000),
    });
    watchdog(late.deps);
    expect(late.killed).toEqual([zombie.id]);
    expect(late.recovered).toEqual([zombie.id]);
    const reaped = listEvents(50).find((e) => e.kind === "reviewer.reaped");
    expect(reaped?.agent_id).toBe(zombie.id);
    expect(reaped?.task_id).toBe(taskId);
  });

  it("nudges a silent reviewer before reaping it", async () => {
    const { watchdog } = await import("../src/daemon/scheduler.js");
    const { logEvent } = await import("../src/db/events.js");
    const { taskId } = await reviewTask(6);
    const stalled = await makeReviewer(taskId, { state: "stalled" });
    logEvent("agent.stalled", { agentId: stalled.id, taskId });

    const early = watchdogDeps();
    watchdog(early.deps);
    expect(early.revived).toEqual([stalled.id]);
    expect(early.killed).toEqual([]);
  });

  it("leaves a reviewer that is still working alone", async () => {
    const { watchdog } = await import("../src/daemon/scheduler.js");
    const { taskId } = await reviewTask(7);
    await makeReviewer(taskId, { state: "working" });

    const late = watchdogDeps({
      now: () => new Date(Date.now() + 11 * 60_000),
    });
    watchdog(late.deps);
    expect(late.killed).toEqual([]);
    expect(late.recovered).toEqual([]);
  });

  it("leaves a reviewer that was typed back to life alone", async () => {
    const { watchdog } = await import("../src/daemon/scheduler.js");
    const { updateAgent } = await import("../src/db/agents.js");
    const { taskId } = await reviewTask(14);
    const rescued = await makeReviewer(taskId);
    await stoppedIncomplete(rescued.id, taskId);
    // What a send_to_worker nudge leaves behind: the give-up is still in the
    // event log, but the session is running again.
    updateAgent(rescued.id, { state: "working" });

    const late = watchdogDeps({
      now: () => new Date(Date.now() + 11 * 60_000),
    });
    watchdog(late.deps);
    expect(late.killed).toEqual([]);
    expect(late.recovered).toEqual([]);
  });

  it("reaps a reviewer whose spawn never reached a pane", async () => {
    const { watchdog } = await import("../src/daemon/scheduler.js");
    const { getAgent } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    const { taskId } = await reviewTask(8);
    const paneless = await makeReviewer(taskId, {
      state: "spawning",
      tmux_target: null,
    });

    // Still inside the SessionStart window: the spawn may yet finish.
    watchdog(watchdogDeps().deps);
    expect(getAgent(paneless.id)?.state).toBe("spawning");

    // Past it, the watchdog flags it as never-initialized...
    watchdog(watchdogDeps({ now: () => new Date(Date.now() + 2 * 60_000) }).deps);
    expect(getAgent(paneless.id)?.state).toBe("stalled");
    expect(listEvents(50).map((e) => e.kind)).toContain(
      "agent.session_start_missing",
    );

    // ...and past the reap grace it stops holding the task's review hostage.
    const late = watchdogDeps({
      now: () => new Date(Date.now() + 12 * 60_000),
    });
    watchdog(late.deps);
    expect(late.killed).toEqual([paneless.id]);
    expect(late.recovered).toEqual([paneless.id]);
  });
});

describe("review recovery after a reviewer gives up", () => {
  it("starts a replacement round for the same candidate", async () => {
    const { recoverAbandonedReview } = await import("../src/daemon/review.js");
    const { logEvent, listEvents } = await import("../src/db/events.js");
    const { updateTask } = await import("../src/db/tasks.js");
    const { hashResult } = await import("../src/daemon/reviewstate.js");
    const { taskId } = await reviewTask(9);
    // Exactly the fingerprint the dead round left behind. Nothing about the
    // submission changed, so the loop-safety guard would suppress a re-review
    // unless the recovery clears it.
    updateTask(taskId, { review_result_hash: hashResult("claims done") });
    const zombie = await makeReviewer(taskId, { state: "idle" });
    logEvent("reviewer.reaped", { agentId: zombie.id, taskId });

    await recoverAbandonedReview(zombie);

    const kinds = listEvents(80).map((e) => e.kind);
    expect(kinds).toContain("review.reviewer_replacing");
    expect(kinds).toContain("reviewer.spawned");
    expect(kinds).toContain("review.round_started");
  });

  it("does nothing once a verdict landed after all", async () => {
    const { recoverAbandonedReview } = await import("../src/daemon/review.js");
    const { logEvent, listEvents } = await import("../src/db/events.js");
    const { updateTask } = await import("../src/db/tasks.js");
    const { taskId } = await reviewTask(10);
    updateTask(taskId, { review_verdict: "approve" });
    const zombie = await makeReviewer(taskId, { state: "idle" });
    logEvent("reviewer.reaped", { agentId: zombie.id, taskId });

    await recoverAbandonedReview(zombie);

    const kinds = listEvents(80).map((e) => e.kind);
    expect(kinds).not.toContain("review.reviewer_replacing");
    expect(kinds).not.toContain("reviewer.spawned");
  });

  it("stops replacing after too many reviewers give up, and blocks the task", async () => {
    const { recoverAbandonedReview } = await import("../src/daemon/review.js");
    const { logEvent, listEvents } = await import("../src/db/events.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { taskId } = await reviewTask(11);
    const zombie = await makeReviewer(taskId, { state: "idle" });
    // Three reviewers have now given up on this task: two replacements were
    // already spent, so this one must not spawn a third.
    for (let i = 0; i < 3; i++) {
      logEvent("reviewer.reaped", { agentId: zombie.id, taskId });
    }

    await recoverAbandonedReview(zombie);

    expect(getTask(taskId)?.status).toBe("blocked");
    const kinds = listEvents(80).map((e) => e.kind);
    expect(kinds).toContain("review.reviewer_unrecoverable");
    expect(kinds).not.toContain("reviewer.spawned");
  });

  it("surfaces the give-up in the attention feed", async () => {
    const { recoverAbandonedReview } = await import("../src/daemon/review.js");
    const { logEvent } = await import("../src/db/events.js");
    const { computeAttention } = await import("../src/daemon/attention.js");
    const { taskId } = await reviewTask(12);
    const zombie = await makeReviewer(taskId, { state: "idle" });
    for (let i = 0; i < 3; i++) {
      logEvent("reviewer.reaped", { agentId: zombie.id, taskId });
    }

    await recoverAbandonedReview(zombie);

    const item = (await computeAttention()).find((i) =>
      i.id.startsWith(`decision:reviewer_gave_up:${taskId}:`),
    );
    expect(item?.title).toContain("Review stuck");
    expect(item?.task_id).toBe(taskId);
  });
});
