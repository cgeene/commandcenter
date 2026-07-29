import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Verify runs are serialized daemon-wide (src/daemon/verifyenv.ts). A verify_cmd
 * is usually the repo's whole test suite, so N workers finishing at once used to
 * mean N suites competing for one box — and a suite that fails on contention
 * spends the task's retry budget as if it had found a defect.
 *
 * Every timing assertion here is either an ORDERING assertion or a polled
 * precondition. Nothing asserts an elapsed-ms bound on a real subprocess: this
 * suite runs on a loaded box by definition.
 */

const sendText = vi.fn(async () => {});
vi.mock("../src/daemon/tmux.js", () => ({
  windowExists: () => true,
  sendText: (...a: unknown[]) => sendText(...a),
  sendEnter: () => {},
  capturePane: () => "",
  killWindow: () => [],
  paneProcess: () => null,
}));

let tmpDir: string;
/** Every verify command in a test appends its markers here. */
let markers: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-verifyq-"));
  process.env.CC_DATA_DIR = tmpDir;
  markers = path.join(tmpDir, "markers");
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  sendText.mockClear();
});

afterEach(async () => {
  const { __setVerifyQueueWaitForTests, __setExternalSuiteObserverForTests } =
    await import("../src/daemon/verifyenv.js");
  __setVerifyQueueWaitForTests(null);
  __setExternalSuiteObserverForTests(null);
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A command that brackets a sleep with markers, so the file records whether
 *  two runs overlapped. */
function bracketed(tag: string, seconds: string): string {
  return `printf '${tag}-in\\n' >> ${markers}; sleep ${seconds}; printf '${tag}-out\\n' >> ${markers}`;
}

/** A command that blocks until `gate` exists, so a test can hold the single
 *  verify slot for exactly as long as it needs to and never longer. The bounded
 *  loop is a safety net: a broken test must fail, not hang for VERIFY_TIMEOUT_MS. */
function gatedBy(gate: string, tag: string): string {
  return `printf '${tag}-in\\n' >> ${markers}; for _ in $(seq 1 1000); do [ -f ${gate} ] && break; sleep 0.02; done; printf '${tag}-out\\n' >> ${markers}`;
}

function markerLines(): string[] {
  if (!fs.existsSync(markers)) return [];
  return fs.readFileSync(markers, "utf8").trim().split("\n").filter(Boolean);
}

/** Poll until `probe` returns something truthy, then return it. Polled rather
 *  than slept so the budget tracks machine load instead of being spent on every
 *  run, and a failure names what never happened. */
async function waitFor<T>(
  probe: () => T | undefined | false,
  what: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("the verify semaphore", () => {
  const cwd = os.tmpdir();

  it("runs one verify at a time, and the second waits its turn", async () => {
    const { runVerifyCommand } = await import("../src/daemon/verifyenv.js");

    // The first call takes the only slot synchronously, so the order is fixed.
    const [first, second] = await Promise.all([
      runVerifyCommand(bracketed("a", "0.3"), cwd),
      runVerifyCommand(bracketed("b", "0.3"), cwd),
    ]);

    expect(first.ok && second.ok).toBe(true);
    // Interleaved markers (a-in, b-in, …) would mean both suites ran at once.
    expect(markerLines()).toEqual(["a-in", "a-out", "b-in", "b-out"]);
    expect(first.load.concurrent).toBe(1);
    expect(second.load.concurrent).toBe(1);
    expect(first.load.queued_ms).toBe(0);
    expect(second.load.queued_ms).toBeGreaterThan(0);
  });

  it("lets verify_concurrency raise the ceiling", async () => {
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    const { runVerifyCommand, verifyConcurrencyLimit } = await import(
      "../src/daemon/verifyenv.js"
    );
    setSchedulerConfig({ verify_concurrency: 2 });
    expect(verifyConcurrencyLimit()).toBe(2);

    const [first, second] = await Promise.all([
      runVerifyCommand(bracketed("a", "0.2"), cwd),
      runVerifyCommand(bracketed("b", "0.2"), cwd),
    ]);

    // Both were admitted at once, so each observed the other. Asserted on the
    // in-process peak rather than on marker interleaving, which depends on how
    // fast the box can fork.
    expect(first.load.concurrent).toBe(2);
    expect(second.load.concurrent).toBe(2);
    expect(second.load.queued_ms).toBe(0);
  });

  it("charges the timeout for execution only, not for queue time", async () => {
    const { runVerifyCommand } = await import("../src/daemon/verifyenv.js");

    // Relative, not absolute: the queued run cannot have waited less than the
    // run ahead of it took, and its own command does nothing.
    const [, second] = await Promise.all([
      runVerifyCommand("sleep 0.6", cwd),
      runVerifyCommand("true", cwd),
    ]);

    expect(second.load.queued_ms).toBeGreaterThan(second.load.run_ms);
  });

  it("admits waiters in arrival order, so none is starved", async () => {
    const { runVerifyCommand } = await import("../src/daemon/verifyenv.js");
    await Promise.all(
      ["a", "b", "c"].map((tag) => runVerifyCommand(bracketed(tag, "0.1"), cwd)),
    );
    expect(markerLines()).toEqual([
      "a-in",
      "a-out",
      "b-in",
      "b-out",
      "c-in",
      "c-out",
    ]);
  });

  it("runs anyway once the wait bound expires, and says so", async () => {
    const { runVerifyCommand, verifyWasContended, __setVerifyQueueWaitForTests } =
      await import("../src/daemon/verifyenv.js");
    // A verify that never runs strands its task, so the queue fails open.
    __setVerifyQueueWaitForTests(0);

    const [first, second] = await Promise.all([
      runVerifyCommand(bracketed("a", "0.3"), cwd),
      runVerifyCommand(bracketed("b", "0.3"), cwd),
    ]);

    expect(second.load.bypassed_queue).toBe(true);
    expect(first.load.bypassed_queue).toBe(false);
    // Both ran together, and both know it — which is what excuses a failure.
    expect(second.load.concurrent).toBe(2);
    expect(verifyWasContended(first.load)).toBe(true);
    expect(verifyWasContended(second.load)).toBe(true);
  });

  // logEvent writes to SQLite and does not swallow its own errors, so both
  // callbacks can throw. A throw that skipped the queue cleanup would leave a
  // waiter nobody can wake: the fast path below is then unreachable forever, so
  // every later verify waits out the whole 30-minute bound and then runs
  // unserialized — the queue silently reverting itself.
  it("keeps admitting runs after onQueued throws", async () => {
    const { runVerifyCommand } = await import("../src/daemon/verifyenv.js");
    const holder = runVerifyCommand(bracketed("hold", "0.3"), cwd);
    const victim = runVerifyCommand("true", cwd, {
      onQueued: () => {
        throw new Error("logEvent blew up");
      },
    });

    await expect(victim).rejects.toThrow("logEvent blew up");
    await holder;

    const after = await runVerifyCommand("true", cwd);
    expect(after.load.queued_ms).toBe(0);
    expect(after.load.bypassed_queue).toBe(false);
    expect(after.load.concurrent).toBe(1);
  });

  it("keeps admitting runs after onStart throws", async () => {
    const { runVerifyCommand } = await import("../src/daemon/verifyenv.js");
    const victim = runVerifyCommand("true", cwd, {
      onStart: () => {
        throw new Error("logEvent blew up");
      },
    });
    await expect(victim).rejects.toThrow("logEvent blew up");

    // The slot it never used has to be back: a leaked one would make the next
    // run queue behind a command that is not running.
    const after = await runVerifyCommand("true", cwd);
    expect(after.load.queued_ms).toBe(0);
    expect(after.load.concurrent).toBe(1);
  });

  it("calls onStart when the run really starts, never while it is queued", async () => {
    const { runVerifyCommand } = await import("../src/daemon/verifyenv.js");
    const phases: string[] = [];
    await Promise.all([
      runVerifyCommand(bracketed("a", "0.3"), cwd, {
        onStart: () => phases.push("a-start"),
      }),
      runVerifyCommand(bracketed("b", "0.1"), cwd, {
        onQueued: () => phases.push("b-queued"),
        onStart: () => phases.push("b-start"),
      }),
    ]);
    // b-start lands after a's command exited, not when b was submitted.
    expect(phases).toEqual(["b-queued", "a-start", "b-start"]);
  });
});

describe("two workers finishing at once", () => {
  /** A worker with a finished in_progress task whose verify_cmd is `cmd`. */
  async function worker(cmd: string) {
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const { createAgent } = await import("../src/db/agents.js");
    const task = createTask({
      title: "t",
      prompt: "x",
      repo: "/r",
      verify_cmd: cmd,
    });
    const agent = createAgent({
      kind: "worker",
      state: "working",
      task_id: task.id,
      tmux_target: `cc:@${task.id}`,
    });
    updateTask(task.id, {
      status: "in_progress",
      agent_id: agent.id,
      worktree: tmpDir,
      result_summary: `result for ${task.id}`,
    });
    return { task, agent };
  }

  async function taskEventKinds(taskId: number): Promise<string[]> {
    const { listEvents } = await import("../src/db/events.js");
    return listEvents(300)
      .filter((e) => e.task_id === taskId)
      .map((e) => e.kind)
      .reverse();
  }

  /**
   * The real path, made deterministic: worker 1's verify holds the only slot
   * until the test opens a gate, so worker 2's Stop is provably queued rather
   * than merely likely to be.
   */
  async function twoStops() {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { listEvents } = await import("../src/db/events.js");
    const gate = path.join(tmpDir, "gate");
    const one = await worker(gatedBy(gate, "a"));
    const two = await worker(bracketed("b", "0"));

    const firstStop = handleHookEvent(one.agent.id, { hook_event_name: "Stop" });
    await waitFor(
      () =>
        listEvents(50).some(
          (e) => e.kind === "verify.started" && e.task_id === one.task.id,
        ),
      "worker 1's verify to start",
    );
    const secondStop = handleHookEvent(two.agent.id, { hook_event_name: "Stop" });
    await waitFor(
      () =>
        listEvents(50).some(
          (e) => e.kind === "verify.queued" && e.task_id === two.task.id,
        ),
      "worker 2's verify to be queued",
    );

    return {
      one,
      two,
      release: async () => {
        fs.writeFileSync(gate, "");
        await Promise.all([firstStop, secondStop]);
      },
    };
  }

  it("never runs their verify commands concurrently, and both still reach review", async () => {
    const { getTask } = await import("../src/db/tasks.js");
    const { one, two, release } = await twoStops();

    // Queued, and NOT started: the event the stall predicate reads means
    // "executing", so it must not exist yet.
    expect(await taskEventKinds(two.task.id)).not.toContain("verify.started");

    await release();

    expect(markerLines()).toEqual(["a-in", "a-out", "b-in", "b-out"]);
    expect(getTask(one.task.id)!.status).toBe("review");
    expect(getTask(two.task.id)!.status).toBe("review");
    // The queued run's own sequence, in order.
    const kinds = (await taskEventKinds(two.task.id)).filter((k) =>
      k.startsWith("verify."),
    );
    expect(kinds).toEqual(["verify.queued", "verify.started", "verify.passed"]);
    // The run that had the box to itself reports no contention at all.
    expect(
      (await taskEventKinds(one.task.id)).filter((k) => k.startsWith("verify.")),
    ).toEqual(["verify.started", "verify.passed"]);
  });

  it("does not let a queued verify look like a stalled worker or an unanswered wait", async () => {
    const { handleHookEvent, stalledFinishedWorkers, verifyInFlight } =
      await import("../src/daemon/hooks.js");
    const { getAgent } = await import("../src/db/agents.js");
    const { two, release } = await twoStops();

    // Well past the sweep's grace period, so only verifyInFlight can be what
    // holds the sweep off.
    const later = Date.now() + 5 * 60_000;
    expect(verifyInFlight(two.task.id, later)).toBe(true);
    expect(stalledFinishedWorkers(later).map((s) => s.task.id)).not.toContain(
      two.task.id,
    );

    // Claude re-emits its idle prompt ~60s after a turn ends; a worker whose own
    // verify is still queued is not waiting on a human.
    await handleHookEvent(two.agent.id, {
      hook_event_name: "Notification",
      notification_type: "idle_prompt",
      message: "Claude is waiting for your input",
    });
    expect(getAgent(two.agent.id)?.state).toBe("idle");
    expect(await taskEventKinds(two.task.id)).toContain(
      "waiting.suppressed_verifying",
    );

    await release();
  });

  it("stops trusting a verify.queued a dead daemon left behind", async () => {
    const { verifyInFlight, stalledFinishedWorkers } = await import(
      "../src/daemon/hooks.js"
    );
    const { logEvent } = await import("../src/db/events.js");
    const { task, agent } = await worker("true");
    const { updateAgent } = await import("../src/db/agents.js");
    updateAgent(agent.id, { state: "idle" });
    logEvent("hook.stop", { agentId: agent.id, taskId: task.id });
    logEvent("verify.queued", { agentId: agent.id, taskId: task.id });

    // The in-memory queue dies with the daemon, so a queued run that outlives
    // the wait bound is residue — and hiding it forever would hide the stall.
    const long = Date.now() + 24 * 3600_000;
    expect(verifyInFlight(task.id, long)).toBe(false);
    expect(stalledFinishedWorkers(long).map((s) => s.task.id)).toEqual([task.id]);
  });
});

describe("a contended verify failure", () => {
  async function failingWorker() {
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const { createAgent } = await import("../src/db/agents.js");
    const task = createTask({
      title: "t",
      prompt: "x",
      repo: "/r",
      verify_cmd: "echo boom >&2; false",
    });
    const agent = createAgent({
      kind: "worker",
      state: "working",
      task_id: task.id,
      tmux_target: "cc:@9",
    });
    updateTask(task.id, {
      status: "in_progress",
      agent_id: agent.id,
      worktree: tmpDir,
      result_summary: "done",
    });
    return { task, agent };
  }

  async function verifyFailures(taskId: number) {
    const { listEvents } = await import("../src/db/events.js");
    return listEvents(300)
      .filter((e) => e.task_id === taskId && e.kind === "verify.failed")
      .map((e) => JSON.parse(e.payload!) as Record<string, unknown>)
      .reverse();
  }

  async function nudgeMarkers(taskId: number) {
    const { listEvents } = await import("../src/db/events.js");
    return listEvents(300)
      .filter((e) => e.task_id === taskId && e.kind === "task.verify_nudged")
      .map((e) => JSON.parse(e.payload!) as Record<string, unknown>)
      .reverse();
  }

  it("records the load context on every failure", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { __setExternalSuiteObserverForTests } = await import(
      "../src/daemon/verifyenv.js"
    );
    // Whether another agent is running its own suite right now is a property of
    // the box; pin it so this asserts an uncontended run rather than the luck
    // of the moment.
    __setExternalSuiteObserverForTests(() => 0);
    const { task, agent } = await failingWorker();

    await handleHookEvent(agent.id, { hook_event_name: "Stop" });

    const [failure] = await verifyFailures(task.id);
    expect(failure.contended).toBe(false);
    const load = failure.load as Record<string, number>;
    expect(load.concurrent).toBe(1);
    expect(load.external_suites).toBe(0);
    expect(load.limit).toBe(1);
    expect(load.cores).toBeGreaterThan(0);
    expect(typeof load.load1).toBe("number");
    expect(typeof load.run_ms).toBe("number");
  });

  it("gets one retry that does not come out of the round's budget", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { __setVerifyQueueWaitForTests } = await import(
      "../src/daemon/verifyenv.js"
    );
    const { task, agent } = await failingWorker();

    // Every run bypasses the queue, so every failure is a contended one.
    __setVerifyQueueWaitForTests(0);
    const gate = path.join(tmpDir, "gate");
    const holder = (async () => {
      const { runVerifyCommand } = await import("../src/daemon/verifyenv.js");
      await runVerifyCommand(gatedBy(gate, "hold"), os.tmpdir());
    })();
    await waitFor(() => markerLines().includes("hold-in"), "the slot to be held");

    // Four failures: without the excuse the third would have blocked the task.
    for (let i = 0; i < 4; i++) {
      await handleHookEvent(agent.id, { hook_event_name: "Stop" });
    }
    fs.writeFileSync(gate, "");
    await holder;

    expect((await verifyFailures(task.id)).map((f) => f.contended)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    // attempt counts failures; spent counts the ones that cost budget. One
    // failure per round is excused, so the budget still runs out.
    expect(await nudgeMarkers(task.id)).toEqual([
      { attempt: 1, spent: 0, forgiven: 1, max: 2, contended: true },
      { attempt: 2, spent: 1, forgiven: 1, max: 2, contended: true },
      { attempt: 3, spent: 2, forgiven: 1, max: 2, contended: true },
    ]);
    expect(getTask(task.id)!.status).toBe("blocked");
  });

  it("tells the worker its failure may be contention rather than its diff", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { __setVerifyQueueWaitForTests } = await import(
      "../src/daemon/verifyenv.js"
    );
    const { agent } = await failingWorker();
    __setVerifyQueueWaitForTests(0);
    const gate = path.join(tmpDir, "gate");
    const holder = (async () => {
      const { runVerifyCommand } = await import("../src/daemon/verifyenv.js");
      await runVerifyCommand(gatedBy(gate, "hold"), os.tmpdir());
    })();
    await waitFor(() => markerLines().includes("hold-in"), "the slot to be held");

    await handleHookEvent(agent.id, { hook_event_name: "Stop" });
    fs.writeFileSync(gate, "");
    await holder;

    const sent = sendText.mock.calls.map((c) => String(c[1])).join("\n");
    expect(sent).toContain("Verification failed");
    expect(sent).toContain("another test suite at the same time");
  });

  it("counts an agent-run suite the queue never saw as contention", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const {
      __setExternalSuiteObserverForTests,
      verifyWasContended,
    } = await import("../src/daemon/verifyenv.js");
    const { task, agent } = await failingWorker();

    // Nothing is queued and nothing bypasses: the only evidence of contention
    // is a suite running in some agent's own pane, which is the case the
    // semaphore is structurally blind to.
    __setExternalSuiteObserverForTests(() => 3);
    await handleHookEvent(agent.id, { hook_event_name: "Stop" });

    const [failure] = await verifyFailures(task.id);
    const load = failure.load as Record<string, number>;
    expect(load.concurrent).toBe(1);
    expect(load.bypassed_queue).toBeFalsy();
    expect(load.external_suites).toBe(3);
    expect(failure.contended).toBe(true);
    expect(failure.budget_excused).toBe(true);
    expect(
      verifyWasContended({
        concurrent: 1,
        limit: 1,
        queued_ms: 0,
        run_ms: 1,
        load1: 0,
        cores: 1,
        bypassed_queue: false,
        external_suites: 1,
      }),
    ).toBe(true);

    const sent = sendText.mock.calls.map((c) => String(c[1])).join("\n");
    expect(sent).toContain("3 agent-run test suites outside the queue");
  });
});
