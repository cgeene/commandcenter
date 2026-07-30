import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-sched-"));
  process.env.CC_DATA_DIR = tmpDir;
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

/** A successful tmux snapshot listing exactly these windows as live. */
function seen(live: string[], dead: string[] = []) {
  return { live, dead, server: "running" as const };
}

/** What tmux reports when it proves there is no server at all. */
function noServer() {
  return { live: [], dead: [], server: "absent" as const };
}

function deps(
  overrides: Partial<{
    spawned: number[];
    windows: string[] | null;
    now: Date;
  }> = {},
) {
  const spawned: number[] = overrides.spawned ?? [];
  return {
    spawned,
    deps: {
      spawn: (id: number) => spawned.push(id),
      windows: () =>
        Object.prototype.hasOwnProperty.call(overrides, "windows")
          ? overrides.windows
            ? seen(overrides.windows)
            : null
          : seen([]),
      now: () => overrides.now ?? new Date("2026-07-03T12:00:00"),
    },
  };
}

describe("inActiveWindow", () => {
  it("handles normal and overnight ranges", async () => {
    const { inActiveWindow } = await import("../src/daemon/scheduler.js");
    const at = (h: number) => new Date(2026, 6, 3, h, 30);
    expect(inActiveWindow({ start: 9, end: 17 }, at(12))).toBe(true);
    expect(inActiveWindow({ start: 9, end: 17 }, at(8))).toBe(false);
    expect(inActiveWindow({ start: 22, end: 6 }, at(23))).toBe(true);
    expect(inActiveWindow({ start: 22, end: 6 }, at(3))).toBe(true);
    expect(inActiveWindow({ start: 22, end: 6 }, at(12))).toBe(false);
  });
});

describe("scheduler tick", () => {
  it("does nothing when disabled", async () => {
    const { createTask } = await import("../src/db/tasks.js");
    const { tick } = await import("../src/daemon/scheduler.js");
    createTask({ title: "t", prompt: "x", repo: "/r" });
    const { spawned, deps: d } = deps();
    tick(d);
    expect(spawned).toEqual([]);
  });

  it("spawns ready tasks up to max_concurrent, counting live workers", async () => {
    const { createTask } = await import("../src/db/tasks.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    const { tick } = await import("../src/daemon/scheduler.js");
    setSchedulerConfig({ enabled: true, max_concurrent: 3 });
    createAgent({ kind: "worker", state: "working" }); // occupies one slot
    const t1 = createTask({ title: "a", prompt: "x", repo: "/r" });
    const t2 = createTask({ title: "b", prompt: "x", repo: "/r" });
    createTask({ title: "c", prompt: "x", repo: "/r" }); // over capacity
    const { spawned, deps: d } = deps();
    tick(d);
    expect(spawned).toEqual([t1.id, t2.id]);
  });

  it("never bypasses Claude main for orchestrated tasks", async () => {
    const { createTask } = await import("../src/db/tasks.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    const { tick } = await import("../src/daemon/scheduler.js");
    setSchedulerConfig({ enabled: true, max_concurrent: 3 });
    createTask({
      title: "human task",
      prompt: "x",
      repo: "/r",
      dispatch_mode: "orchestrated",
    });
    const { spawned, deps: d } = deps();
    tick(d);
    expect(spawned).toEqual([]);
  });

  it("stops at the daily spawn budget", async () => {
    const { createTask } = await import("../src/db/tasks.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    const { logEvent } = await import("../src/db/events.js");
    const { tick } = await import("../src/daemon/scheduler.js");
    setSchedulerConfig({ enabled: true, max_concurrent: 5, daily_spawn_limit: 2 });
    logEvent("scheduler.spawned"); // 1 already used today
    const t1 = createTask({ title: "a", prompt: "x", repo: "/r" });
    createTask({ title: "b", prompt: "x", repo: "/r" });
    const { spawned, deps: d } = deps();
    tick(d);
    expect(spawned).toEqual([t1.id]); // only 1 more allowed
  });

  it("respects the active window", async () => {
    const { createTask } = await import("../src/db/tasks.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    const { tick } = await import("../src/daemon/scheduler.js");
    setSchedulerConfig({
      enabled: true,
      active_hours: { start: 22, end: 6 },
    });
    createTask({ title: "a", prompt: "x", repo: "/r" });
    const noon = deps({ now: new Date(2026, 6, 3, 12, 0) });
    tick(noon.deps);
    expect(noon.spawned).toEqual([]);
    const night = deps({ now: new Date(2026, 6, 3, 23, 0) });
    tick(night.deps);
    expect(night.spawned.length).toBe(1);
  });

  it("blocks a task whose spawn fails instead of hot-looping", async () => {
    const { createTask, getTask } = await import("../src/db/tasks.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    const { tick } = await import("../src/daemon/scheduler.js");
    setSchedulerConfig({ enabled: true });
    const t = createTask({ title: "a", prompt: "x", repo: "/r" });
    tick({
      spawn: () => {
        throw new Error("worktree exploded");
      },
      windows: () => seen([]),
      now: () => new Date(),
    });
    const after = getTask(t.id)!;
    expect(after.status).toBe("blocked");
    expect(after.result_summary).toContain("worktree exploded");
  });
});

describe("watchdog", () => {
  it("surfaces a worker whose SessionStart hook never arrives", async () => {
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const { getDb } = await import("../src/db/db.js");
    const { listEvents } = await import("../src/db/events.js");
    const { watchdog } = await import("../src/daemon/scheduler.js");
    const agent = createAgent({
      kind: "worker",
      provider: "codex",
      state: "spawning",
    });
    getDb()
      .prepare("UPDATE agents SET spawned_at = ? WHERE id = ?")
      .run("2026-07-03T10:00:00.000Z", agent.id);

    watchdog({
      spawn: () => {},
      windows: () => seen([]),
      now: () => new Date("2026-07-03T10:02:00.000Z"),
    });
    expect(getAgent(agent.id)?.state).toBe("stalled");
    expect(listEvents(10).map((event) => event.kind)).toContain(
      "agent.session_start_missing",
    );
  });

  it("confirms a missing window before requeueing, then fails on a second confirmed vanish", async () => {
    const { createTask, getTask, updateTask } = await import("../src/db/tasks.js");
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const { watchdog } = await import("../src/daemon/scheduler.js");

    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    const a1 = createAgent({ kind: "worker", state: "working", task_id: task.id, tmux_target: "cc:@9" });
    updateTask(task.id, { status: "in_progress", agent_id: a1.id });

    const missing = { spawn: () => {}, windows: () => seen([]), now: () => new Date() };
    watchdog(missing);
    expect(getAgent(a1.id)?.state).toBe("working");
    expect(getTask(task.id)?.status).toBe("in_progress");
    watchdog(missing);
    expect(getAgent(a1.id)?.state).toBe("dead");
    expect(getTask(task.id)?.status).toBe("queued"); // first vanish -> retry

    const a2 = createAgent({ kind: "worker", state: "working", task_id: task.id, tmux_target: "cc:@10" });
    updateTask(task.id, { status: "in_progress", agent_id: a2.id });
    watchdog(missing);
    expect(getAgent(a2.id)?.state).toBe("working");
    watchdog(missing);
    expect(getTask(task.id)?.status).toBe("failed"); // second vanish -> give up
  });

  it("sweeps the pane's process group when it confirms a vanished window", async () => {
    // This branch never calls killAgent — the task is requeued, not cancelled —
    // so if it does not sweep here, the agent's orphaned background processes
    // are unreachable forever: the row goes state=dead, drops out of
    // listAgents({live:true}), and a later kill hits killAgent's early return.
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const { createAgent, getAgent, updateAgent } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    const { watchdog } = await import("../src/daemon/scheduler.js");

    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    const agent = createAgent({
      kind: "worker",
      state: "working",
      task_id: task.id,
      tmux_target: "cc:@9",
    });
    updateAgent(agent.id, { pane_pid: 4242 });
    updateTask(task.id, { status: "in_progress", agent_id: agent.id });

    const swept: Array<[number, number]> = [];
    const missing = {
      spawn: () => {},
      windows: () => seen([]),
      now: () => new Date(),
      sweepPaneGroup: (panePid: number, ageSec: number) => {
        swept.push([panePid, ageSec]);
        return { outcome: "swept" as const, killed: [7001, 7002] };
      },
    };
    watchdog(missing); // first pass only records the missing window
    expect(swept).toEqual([]);
    watchdog(missing); // second pass confirms the vanish

    expect(swept.length).toBe(1);
    expect(swept[0][0]).toBe(4242);
    expect(swept[0][1]).toBeGreaterThanOrEqual(0);
    const vanished = listEvents(20).find((e) => e.kind === "agent.vanished");
    expect(JSON.parse(vanished!.payload!).swept_pids).toEqual([7001, 7002]);
    expect(JSON.parse(vanished!.payload!).pane_sweep).toBe("swept");
    // Marked swept, so a later kill does not sweep the same group twice.
    expect(getAgent(agent.id)?.pane_pid).toBeNull();
  });

  it("records an unreachable sweep on agent.vanished so a blind reap is not silent", async () => {
    // This is the path a CRASHED pane takes — the branch never calls killAgent,
    // so agent.kill_unconfirmed cannot reach it and this payload is the only
    // place the verdict can be written. An unreachable sweep proved nothing
    // about what the pane left running, and the row gives up its pane pid all
    // the same; without the verdict that is indistinguishable from a real reap.
    const { createAgent, getAgent, updateAgent } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    const { watchdog } = await import("../src/daemon/scheduler.js");
    const agent = createAgent({
      kind: "worker",
      state: "working",
      tmux_target: "cc:@9",
    });
    updateAgent(agent.id, { pane_pid: 4242 });

    const missing = {
      spawn: () => {},
      windows: () => seen([]),
      now: () => new Date(),
      sweepPaneGroup: () => ({ outcome: "unreachable" as const, killed: [] }),
    };
    watchdog(missing); // first pass only records the missing window
    watchdog(missing); // second pass confirms the vanish

    const vanished = listEvents(20).find((e) => e.kind === "agent.vanished");
    const payload = JSON.parse(vanished!.payload!);
    expect(payload.pane_sweep).toBe("unreachable");
    expect(payload.swept_pids).toBeUndefined();
    expect(getAgent(agent.id)?.pane_pid).toBeNull();
  });

  it("does not sweep a vanished agent that never recorded a pane pid", async () => {
    const { createAgent } = await import("../src/db/agents.js");
    const { watchdog } = await import("../src/daemon/scheduler.js");
    createAgent({ kind: "worker", state: "working", tmux_target: "cc:@9" });

    const swept: number[] = [];
    const missing = {
      spawn: () => {},
      windows: () => seen([]),
      now: () => new Date(),
      sweepPaneGroup: (panePid: number) => {
        swept.push(panePid);
        return { outcome: "unreachable" as const, killed: [] };
      },
    };
    watchdog(missing);
    watchdog(missing);
    expect(swept).toEqual([]);
  });

  it("keeps the pane pid through a false vanish so a later genuine one still sweeps", async () => {
    // vanish -> recover -> vanish is an anticipated sequence (the retry counter
    // subtracts task.recovered from agent.vanished for exactly this). A false
    // vanish sweeps nothing — the pane is alive, so the sweep declines — and
    // recoverFalseVanishes restores only `state`. If the vanish branch dropped
    // pane_pid anyway, the agent would run on with no handle and the real
    // vanish later would sweep nothing at all.
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const { createAgent, getAgent, updateAgent } = await import("../src/db/agents.js");
    const { watchdog } = await import("../src/daemon/scheduler.js");

    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    const agent = createAgent({
      kind: "worker",
      state: "working",
      task_id: task.id,
      tmux_target: "cc:@9",
    });
    updateAgent(agent.id, { pane_pid: 4242, session_id: "s1" });
    updateTask(task.id, { status: "in_progress", agent_id: agent.id });

    const calls: Array<[number, string]> = [];
    const base = {
      spawn: () => {},
      now: () => new Date(),
      // "declined": the pane shell is alive and still leads its group.
      sweepPaneGroup: (panePid: number) => {
        calls.push([panePid, "declined"]);
        return { outcome: "declined" as const, killed: [] };
      },
    };

    // Two passes with tmux not reporting the window -> a (false) confirmed vanish.
    const missing = { ...base, windows: () => seen([]) };
    watchdog(missing);
    watchdog(missing);
    expect(calls).toEqual([[4242, "declined"]]);
    // The handle must survive: nothing was actually swept.
    expect(getAgent(agent.id)?.pane_pid).toBe(4242);

    // tmux comes back; recoverFalseVanishes revives the agent.
    watchdog({ ...base, windows: () => seen(["cc:@9"]) });
    expect(getAgent(agent.id)?.state).toBe("working");
    expect(getAgent(agent.id)?.pane_pid).toBe(4242);

    // Now a genuine vanish: the sweep must still run, with the original pgid.
    const swept: Array<[number, string]> = [];
    const genuine = {
      ...base,
      windows: () => seen([]),
      sweepPaneGroup: (panePid: number) => {
        swept.push([panePid, "swept"]);
        return { outcome: "swept" as const, killed: [8001] };
      },
    };
    watchdog(genuine);
    watchdog(genuine);
    expect(swept).toEqual([[4242, "swept"]]);
    expect(getAgent(agent.id)?.pane_pid).toBeNull();
  });

  it("never mutates agents when tmux cannot be observed reliably", async () => {
    const { createTask, getTask, updateTask } = await import("../src/db/tasks.js");
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    const { watchdog } = await import("../src/daemon/scheduler.js");
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    const agent = createAgent({
      kind: "worker",
      state: "working",
      task_id: task.id,
      tmux_target: "cc:@9",
    });
    updateTask(task.id, { status: "in_progress", agent_id: agent.id });

    const swept: number[] = [];
    const blind = {
      spawn: () => {},
      windows: () => null,
      now: () => new Date(),
      sweepPaneGroup: (panePid: number) => {
        swept.push(panePid);
        return { outcome: "swept" as const, killed: [panePid] };
      },
    };
    watchdog(blind);
    watchdog(blind);

    expect(getAgent(agent.id)?.state).toBe("working");
    expect(getTask(task.id)?.status).toBe("in_progress");
    expect(swept).toEqual([]);
    const kinds = listEvents(20).map((event) => event.kind);
    expect(kinds).not.toContain("agent.window_missing");
    expect(kinds).not.toContain("agent.vanished");
    expect(
      listEvents(20).filter((event) => event.kind === "watchdog.tmux_unavailable"),
    ).toHaveLength(1);
  });

  it("distrusts a successful listing that shows none of several agents' windows", async () => {
    // The overnight false vanish: tmux answered, so the snapshot looked
    // authoritative, and every live agent was flagged in the same pass.
    const { createTask, getTask, updateTask } = await import("../src/db/tasks.js");
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    const { watchdog } = await import("../src/daemon/scheduler.js");

    const agents = ["cc:@1004", "cc:@1015"].map((target, i) => {
      const task = createTask({ title: `t${i}`, prompt: "x", repo: "/r" });
      const agent = createAgent({
        kind: i === 0 ? "worker" : "reviewer",
        state: "working",
        task_id: task.id,
        tmux_target: target,
      });
      updateTask(task.id, { status: "in_progress", agent_id: agent.id });
      return { agent, task };
    });

    const swept: number[] = [];
    const empty = {
      spawn: () => {},
      windows: () => seen([]),
      now: () => new Date(),
      // Asked one at a time, tmux says the windows are right there — the bulk
      // listing was wrong, and no number of repeats makes it right.
      probeWindow: () => "present" as const,
      sweepPaneGroup: (panePid: number) => {
        swept.push(panePid);
        return { outcome: "swept" as const, killed: [panePid] };
      },
    };
    for (let pass = 0; pass < 5; pass++) watchdog(empty);

    for (const { agent, task } of agents) {
      expect(getAgent(agent.id)?.state).toBe("working");
      expect(getTask(task.id)?.status).toBe("in_progress");
    }
    expect(swept).toEqual([]);
    const kinds = listEvents(20).map((event) => event.kind);
    expect(kinds).not.toContain("agent.window_missing");
    expect(kinds).not.toContain("agent.vanished");
    expect(
      listEvents(20).filter(
        (event) => event.kind === "watchdog.tmux_snapshot_implausible",
      ),
    ).toHaveLength(1);
  });

  it("stops disbelieving a listing once every window checks out gone", async () => {
    // `tmux kill-session -t cc` while other sessions keep the server up: the
    // listing is non-empty and holds no agent window, so it looks broken every
    // pass, and the only thing that would shrink the claimed set is the vanish
    // branch the disbelief skips. Left unbounded the queue sits dead until a
    // human intervenes — the outcome this whole task exists to prevent.
    const { createTask, getTask, updateTask } = await import("../src/db/tasks.js");
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    const { watchdog } = await import("../src/daemon/scheduler.js");

    const made = ["cc:@1004", "cc:@1015"].map((target, i) => {
      const task = createTask({ title: `t${i}`, prompt: "x", repo: "/r" });
      const agent = createAgent({
        kind: "worker",
        state: "working",
        task_id: task.id,
        tmux_target: target,
      });
      updateTask(task.id, { status: "in_progress", agent_id: agent.id });
      return { agent, task };
    });

    const probed: string[] = [];
    const elsewhere = {
      spawn: () => {},
      windows: () => seen(["viewer:@0", "viewer:@1"]),
      now: () => new Date(),
      probeWindow: (target: string) => {
        probed.push(target);
        return "absent" as const;
      },
    };
    // Three passes of disbelief, then the probe settles it and the ordinary
    // two-observation confirmation runs.
    for (let pass = 0; pass < 4; pass++) watchdog(elsewhere);

    expect(probed).toEqual(["cc:@1004", "cc:@1015"]);
    for (const { agent, task } of made) {
      expect(getAgent(agent.id)?.state).toBe("dead");
      expect(getTask(task.id)?.status).toBe("queued");
    }
    expect(listEvents(30).map((event) => event.kind)).toContain(
      "watchdog.tmux_snapshot_probed",
    );
  });

  it("requeues both agents when the tmux server is provably gone", async () => {
    // The other side of the guard: a server tmux says is not running really
    // has taken every window with it, so the work must be requeued rather than
    // parked behind a blind watchdog forever.
    const { createTask, getTask, updateTask } = await import("../src/db/tasks.js");
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const { watchdog } = await import("../src/daemon/scheduler.js");

    const made = ["cc:@1004", "cc:@1015"].map((target, i) => {
      const task = createTask({ title: `t${i}`, prompt: "x", repo: "/r" });
      const agent = createAgent({
        kind: "worker",
        state: "working",
        task_id: task.id,
        tmux_target: target,
      });
      updateTask(task.id, { status: "in_progress", agent_id: agent.id });
      return { agent, task };
    });

    const gone = {
      spawn: () => {},
      windows: () => noServer(),
      now: () => new Date(),
    };
    watchdog(gone);
    watchdog(gone);

    for (const { agent, task } of made) {
      expect(getAgent(agent.id)?.state).toBe("dead");
      expect(getTask(task.id)?.status).toBe("queued");
    }
  });

  it("restarts the confirmation streak after a pass it could not trust", async () => {
    // Two misses either side of a blind pass are not two consecutive
    // observations, and must not add up to a confirmed vanish.
    const { createTask, getTask, updateTask } = await import("../src/db/tasks.js");
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const { watchdog } = await import("../src/daemon/scheduler.js");

    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    const agent = createAgent({
      kind: "worker",
      state: "working",
      task_id: task.id,
      tmux_target: "cc:@9",
    });
    updateTask(task.id, { status: "in_progress", agent_id: agent.id });

    const base = { spawn: () => {}, now: () => new Date() };
    watchdog({ ...base, windows: () => seen([]) }); // miss 1
    watchdog({ ...base, windows: () => null }); // blind: streak discarded
    watchdog({ ...base, windows: () => seen([]) }); // miss 1 again, not 2

    expect(getAgent(agent.id)?.state).toBe("working");
    expect(getTask(task.id)?.status).toBe("in_progress");

    watchdog({ ...base, windows: () => seen([]) }); // now confirmed
    expect(getAgent(agent.id)?.state).toBe("dead");
  });

  it("still confirms a genuine vanish when tmux is answering properly", async () => {
    // The guard above must not extend to a lone agent, nor to a listing that
    // plainly shows other windows.
    const { createTask, getTask, updateTask } = await import("../src/db/tasks.js");
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const { watchdog } = await import("../src/daemon/scheduler.js");

    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    const gone = createAgent({
      kind: "worker",
      state: "working",
      task_id: task.id,
      tmux_target: "cc:@9",
    });
    updateTask(task.id, { status: "in_progress", agent_id: gone.id });
    const alive = createAgent({
      kind: "main",
      state: "working",
      tmux_target: "cc:@1",
    });

    const present = {
      spawn: () => {},
      windows: () => seen(["cc:@1"]),
      now: () => new Date(),
    };
    watchdog(present);
    watchdog(present);

    expect(getAgent(gone.id)?.state).toBe("dead");
    expect(getAgent(alive.id)?.state).toBe("working");
    expect(getTask(task.id)?.status).toBe("queued");
  });

  it("logs one event per blind spell even when the cause flaps", async () => {
    // A loaded box alternates between a query that times out and a listing
    // that comes back short. Re-logging on each flip would emit every 10s and
    // keep resetting the age the Needs You escalation is measured from.
    const { createAgent } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    const { watchdog } = await import("../src/daemon/scheduler.js");
    createAgent({ kind: "worker", state: "working", tmux_target: "cc:@1" });
    createAgent({ kind: "reviewer", state: "working", tmux_target: "cc:@2" });

    const base = { spawn: () => {}, now: () => new Date() };
    watchdog({ ...base, windows: () => null });
    watchdog({ ...base, windows: () => seen([]) });
    watchdog({ ...base, windows: () => null });
    watchdog({ ...base, windows: () => seen([]) });

    const blind = listEvents(20).filter((event) =>
      event.kind.startsWith("watchdog.tmux_"),
    );
    expect(blind.map((event) => event.kind)).toEqual([
      "watchdog.tmux_unavailable",
    ]);
  });

  it("closes out a blind spell inherited from a previous process", async () => {
    // Restarting the daemon is the obvious human response to a blind watchdog,
    // and the fresh process has no memory of the spell. If recovery were only
    // derived from module state, the Needs You item would stand forever while
    // the watchdog was healthy.
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const { logEvent, listEvents } = await import("../src/db/events.js");
    const { getDb } = await import("../src/db/db.js");
    const { watchdog, _resetSchedulerState } = await import(
      "../src/daemon/scheduler.js"
    );

    logEvent("watchdog.tmux_unavailable");
    getDb()
      .prepare("UPDATE events SET ts = ? WHERE kind = 'watchdog.tmux_unavailable'")
      .run(new Date(Date.now() - 30 * 60_000).toISOString());
    expect(
      deriveAttention({ isPrOpen: () => true }).map((item) => item.title),
    ).toContain("Watchdog blind — tmux cannot be observed");

    _resetSchedulerState(); // the daemon restarts here
    watchdog({ spawn: () => {}, windows: () => seen([]), now: () => new Date() });

    expect(listEvents(20).map((event) => event.kind)).toContain(
      "watchdog.tmux_recovered",
    );
    expect(deriveAttention({ isPrOpen: () => true })).toHaveLength(0);
  });

  it("finishes a teardown that tmux would not confirm, before anything respawns", async () => {
    // killAgent could not reach tmux, so it marked the row dead and kept the
    // pane handle. The process is still running behind a live window, and the
    // rejection path has already requeued the task for a respawn that resumes
    // the same session in the same worktree — this is the only thing that
    // reconciles it.
    const { createAgent, updateAgent, getAgent } = await import("../src/db/agents.js");
    const { logEvent, listEvents } = await import("../src/db/events.js");
    const { watchdog } = await import("../src/daemon/scheduler.js");

    const agent = createAgent({
      kind: "worker",
      state: "working",
      tmux_target: "cc:@7",
    });
    updateAgent(agent.id, { pane_pid: 4242 });
    logEvent("agent.kill_unconfirmed", { agentId: agent.id });
    updateAgent(agent.id, { state: "dead" });

    const killed: number[] = [];
    watchdog({
      spawn: () => {},
      windows: () => seen(["cc:@7"]),
      now: () => new Date(),
      kill: (id: number) => {
        killed.push(id);
        updateAgent(id, { pane_pid: null }); // this retry got through
      },
    });

    expect(killed).toEqual([agent.id]);
    expect(getAgent(agent.id)?.pane_pid).toBeNull();
    expect(listEvents(20).map((event) => event.kind)).toContain(
      "agent.kill_retried",
    );
  });

  it("gives up retrying a teardown rather than looping on it forever", async () => {
    const { createAgent, updateAgent } = await import("../src/db/agents.js");
    const { watchdog } = await import("../src/daemon/scheduler.js");

    const agent = createAgent({
      kind: "worker",
      state: "working",
      tmux_target: "cc:@7",
    });
    updateAgent(agent.id, { pane_pid: 4242 });
    updateAgent(agent.id, { state: "dead" });

    const killed: number[] = [];
    const stuck = {
      spawn: () => {},
      windows: () => seen(["cc:@7"]),
      now: () => new Date(),
      kill: (id: number) => void killed.push(id), // never gets through
    };
    for (let pass = 0; pass < 6; pass++) watchdog(stuck);

    expect(killed).toHaveLength(3);
  });

  it("recovers a false vanish rather than tearing it down as an unfinished kill", async () => {
    // Both passes key off a dead row with a live window; recovery has to win,
    // or a transient miss would turn into the kill it was never given.
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const { createAgent, updateAgent, getAgent } = await import("../src/db/agents.js");
    const { logEvent } = await import("../src/db/events.js");
    const { watchdog } = await import("../src/daemon/scheduler.js");

    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    const agent = createAgent({
      kind: "worker",
      state: "working",
      task_id: task.id,
      tmux_target: "cc:@9",
    });
    updateAgent(agent.id, { pane_pid: 4242, session_id: "s1" });
    updateTask(task.id, { status: "in_progress", agent_id: agent.id });
    logEvent("agent.vanished", { agentId: agent.id, taskId: task.id });
    updateAgent(agent.id, { state: "dead" });

    const killed: number[] = [];
    watchdog({
      spawn: () => {},
      windows: () => seen(["cc:@9"]),
      now: () => new Date(),
      kill: (id: number) => void killed.push(id),
    });

    expect(getAgent(agent.id)?.state).toBe("working");
    expect(killed).toEqual([]);
  });

  it("reaps the empty window a dead agent leaves behind, once the grace period is up", async () => {
    const { createAgent, updateAgent } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    const { watchdog } = await import("../src/daemon/scheduler.js");

    const agent = createAgent({
      kind: "worker",
      state: "working",
      tmux_target: "cc:@1004",
    });
    updateAgent(agent.id, {
      state: "dead",
      last_event_at: "2026-07-03T11:40:00.000Z",
    });

    const reaped: string[] = [];
    const at = (iso: string) => ({
      spawn: () => {},
      windows: () => seen([], ["cc:@1004"]),
      now: () => new Date(iso),
      reapWindow: (target: string) => reaped.push(target),
    });

    // reap_after_minutes defaults to 10: still inspectable at 5.
    watchdog(at("2026-07-03T11:45:00.000Z"));
    expect(reaped).toEqual([]);

    watchdog(at("2026-07-03T12:00:00.000Z"));
    expect(reaped).toEqual(["cc:@1004"]);
    expect(listEvents(20).map((event) => event.kind)).toContain(
      "agent.orphan_window_reaped",
    );
  });

  it("leaves windows it does not own, and windows whose agent is still live", async () => {
    const { createAgent } = await import("../src/db/agents.js");
    const { watchdog } = await import("../src/daemon/scheduler.js");

    // A live agent whose pane just died belongs to the vanish path, which
    // confirms before touching anything; the hub window belongs to nobody.
    createAgent({ kind: "worker", state: "working", tmux_target: "cc:@9" });

    const reaped: string[] = [];
    watchdog({
      spawn: () => {},
      windows: () => seen([], ["cc:@9", "cc:@0"]),
      now: () => new Date("2026-07-03T12:00:00.000Z"),
      reapWindow: (target: string) => reaped.push(target),
    });

    expect(reaped).toEqual([]);
  });

  it("surfaces a startup trust prompt before SessionStart is available", async () => {
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    const { watchdog } = await import("../src/daemon/scheduler.js");
    const main = createAgent({
      kind: "main",
      provider: "claude",
      state: "spawning",
      tmux_target: "cc:@9",
    });

    watchdog({
      spawn: () => {},
      windows: () => seen(["cc:@9"]),
      now: () => new Date(),
      pendingPermission: () => ({
        question: "Security guide",
        options: [
          { n: 1, label: "Yes, I trust this folder" },
          { n: 2, label: "No, exit" },
        ],
      }),
    });

    expect(getAgent(main.id)?.state).toBe("waiting_input");
    expect(listEvents(10).map((event) => event.kind)).toContain(
      "agent.startup_permission",
    );
  });

  it("recovers a false vanish only while its original task is still unclaimed", async () => {
    const { createTask, getTask, updateTask } = await import("../src/db/tasks.js");
    const { createAgent, getAgent, updateAgent } = await import("../src/db/agents.js");
    const { watchdog } = await import("../src/daemon/scheduler.js");
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    const agent = createAgent({
      kind: "worker",
      provider: "codex",
      state: "working",
      task_id: task.id,
      tmux_target: "cc:@9",
    });
    updateTask(task.id, { status: "in_progress", agent_id: agent.id });
    const missing = { spawn: () => {}, windows: () => seen([]), now: () => new Date() };
    watchdog(missing);
    watchdog(missing);
    expect(getTask(task.id)?.status).toBe("queued");

    watchdog({
      spawn: () => {},
      windows: () => seen(["cc:@9"]),
      now: () => new Date(),
      pendingPermission: () => ({
        question: "run command?",
        options: [
          { n: 1, label: "Yes, proceed" },
          { n: 2, label: "No" },
        ],
      }),
    });

    expect(getAgent(agent.id)?.state).toBe("waiting_input");
    expect(getTask(task.id)).toMatchObject({
      status: "in_progress",
      agent_id: agent.id,
    });

    // The recovered false signal must not spend the task's one real retry.
    updateAgent(agent.id, { state: "working" });
    watchdog(missing);
    watchdog(missing);
    expect(getTask(task.id)?.status).toBe("queued");
  });

  it("recovers a falsely vanished main past a live main row that never got a pane", async () => {
    // An interrupted spawn leaves a live main row with no pane, and nothing
    // retires it. Refusing recovery while it sits there discards a session whose
    // process is still running — its context and in-flight delegations with it —
    // and buys a cold start instead.
    const { createAgent, getAgent, updateAgent } = await import("../src/db/agents.js");
    const { logEvent, listEvents } = await import("../src/db/events.js");
    const { watchdog } = await import("../src/daemon/scheduler.js");

    // The state the SessionStart timeout leaves behind, per the relabel above.
    const leaked = createAgent({ kind: "main", provider: "claude", state: "stalled" });
    const main = createAgent({
      kind: "main",
      provider: "claude",
      state: "working",
      tmux_target: "cc:@9",
    });
    updateAgent(main.id, { session_id: "s1" });
    logEvent("agent.vanished", { agentId: main.id });
    updateAgent(main.id, { state: "dead" });

    watchdog({
      spawn: () => {},
      windows: () => seen(["cc:@9"]),
      now: () => new Date(),
    });

    expect(getAgent(main.id)?.state).toBe("working");
    expect(listEvents(20).map((event) => event.kind)).toContain("agent.recovered");
    // The paneless row is left exactly as the relabel left it: retiring rows is
    // spawnMain's job, and pre-empting it here would consume the
    // agent.session_start_missing signal the human is owed.
    expect(getAgent(leaked.id)?.state).toBe("stalled");
  });

  it("refuses to recover a main when a paneless row's session did come up", async () => {
    // A daemon death between newWindow and attachPane leaves a real orchestrator
    // in a window no row claims; it handshakes anyway. Two live orchestrators
    // would compete over triage and merges, so this recovery must not happen.
    const { createAgent, getAgent, updateAgent } = await import("../src/db/agents.js");
    const { logEvent } = await import("../src/db/events.js");
    const { watchdog } = await import("../src/daemon/scheduler.js");

    const unclaimed = createAgent({ kind: "main", provider: "claude", state: "spawning" });
    logEvent("hook.sessionstart", { agentId: unclaimed.id });
    const main = createAgent({
      kind: "main",
      provider: "claude",
      state: "working",
      tmux_target: "cc:@9",
    });
    updateAgent(main.id, { session_id: "s1" });
    logEvent("agent.vanished", { agentId: main.id });
    updateAgent(main.id, { state: "dead" });

    watchdog({
      spawn: () => {},
      windows: () => seen(["cc:@9"]),
      now: () => new Date(),
    });

    expect(getAgent(main.id)?.state).toBe("dead");
  });

  it("refuses to recover a main while another one holds a pane", async () => {
    const { createAgent, getAgent, updateAgent } = await import("../src/db/agents.js");
    const { logEvent } = await import("../src/db/events.js");
    const { watchdog } = await import("../src/daemon/scheduler.js");

    createAgent({
      kind: "main",
      provider: "claude",
      state: "idle",
      tmux_target: "cc:@3",
    });
    const main = createAgent({
      kind: "main",
      provider: "claude",
      state: "working",
      tmux_target: "cc:@9",
    });
    updateAgent(main.id, { session_id: "s1" });
    logEvent("agent.vanished", { agentId: main.id });
    updateAgent(main.id, { state: "dead" });

    watchdog({
      spawn: () => {},
      windows: () => seen(["cc:@9", "cc:@3"]),
      now: () => new Date(),
    });

    expect(getAgent(main.id)?.state).toBe("dead");
  });

  it("marks silent working agents stalled", async () => {
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const { createAgent, getAgent, updateAgent } = await import("../src/db/agents.js");
    const { watchdog } = await import("../src/daemon/scheduler.js");

    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    const agent = createAgent({ kind: "worker", state: "working", task_id: task.id, tmux_target: "cc:@9" });
    updateTask(task.id, { status: "in_progress", agent_id: agent.id });
    updateAgent(agent.id, { last_event_at: "2026-07-03T10:00:00.000Z" });

    // 20 minutes later, window still alive, no events since
    watchdog({
      spawn: () => {},
      windows: () => seen(["cc:@9"]),
      now: () => new Date("2026-07-03T10:20:00.000Z"),
    });
    expect(getAgent(agent.id)?.state).toBe("stalled");
  });
});

describe("watchdog auto-reap", () => {
  async function setup() {
    const tasks = await import("../src/db/tasks.js");
    const agents = await import("../src/db/agents.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    const { watchdog } = await import("../src/daemon/scheduler.js");
    const { listEvents } = await import("../src/db/events.js");
    setSchedulerConfig({ reap_after_minutes: 10 });
    return { ...tasks, ...agents, watchdog, listEvents };
  }

  // window still alive throughout; only the reap decision is under test
  function reapDeps(killed: number[], nowIso: string) {
    return {
      spawn: () => {},
      kill: (id: number) => killed.push(id),
      windows: () => seen(["cc:@9"]),
      now: () => new Date(nowIso),
    };
  }

  it("reaps a finished worker once the grace period elapses, freeing its slot", async () => {
    const { createTask, updateTask, createAgent, updateAgent, watchdog, listEvents } = await setup();
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    const a = createAgent({ kind: "worker", state: "idle", task_id: task.id, tmux_target: "cc:@9" });
    updateTask(task.id, { status: "done", agent_id: a.id });
    updateAgent(a.id, { last_event_at: "2026-07-03T10:00:00.000Z" });

    const killed: number[] = [];
    watchdog(reapDeps(killed, "2026-07-03T10:20:00.000Z")); // 20m > 10m grace
    expect(killed).toEqual([a.id]);
    const reaped = listEvents().find((e) => e.kind === "agent.reaped");
    expect(reaped?.agent_id).toBe(a.id);
    expect(reaped?.task_id).toBe(task.id);
  });

  it("does NOT reap before the grace period elapses", async () => {
    const { createTask, updateTask, createAgent, updateAgent, watchdog } = await setup();
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    const a = createAgent({ kind: "worker", state: "idle", task_id: task.id, tmux_target: "cc:@9" });
    updateTask(task.id, { status: "done", agent_id: a.id });
    updateAgent(a.id, { last_event_at: "2026-07-03T10:00:00.000Z" });

    const killed: number[] = [];
    watchdog(reapDeps(killed, "2026-07-03T10:05:00.000Z")); // 5m < 10m grace
    expect(killed).toEqual([]);
  });

  it("reaps for every terminal status but never a non-terminal one", async () => {
    const { createTask, updateTask, createAgent, updateAgent, watchdog } = await setup();
    const mk = (status: string) => {
      const t = createTask({ title: status, prompt: "x", repo: "/r" });
      const a = createAgent({ kind: "worker", state: "idle", task_id: t.id, tmux_target: "cc:@9" });
      updateTask(t.id, { status: status as never, agent_id: a.id });
      updateAgent(a.id, { last_event_at: "2026-07-03T10:00:00.000Z" });
      return a.id;
    };
    const done = mk("done");
    const cancelled = mk("cancelled");
    const failed = mk("failed");
    const inProgress = mk("in_progress"); // active — must survive
    const review = mk("review"); // may still get rejection feedback — survive

    const killed: number[] = [];
    watchdog(reapDeps(killed, "2026-07-03T11:00:00.000Z"));
    expect(killed.sort((x, y) => x - y)).toEqual([done, cancelled, failed].sort((x, y) => x - y));
    expect(killed).not.toContain(inProgress);
    expect(killed).not.toContain(review);
  });

  it("never reaps the main agent or a reviewer, even on a terminal task", async () => {
    const { createTask, updateTask, createAgent, updateAgent, watchdog } = await setup();
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    updateTask(task.id, { status: "done" });
    const main = createAgent({ kind: "main", state: "idle", tmux_target: "cc:@9" });
    updateAgent(main.id, { last_event_at: "2026-07-03T10:00:00.000Z" });
    const reviewer = createAgent({ kind: "reviewer", state: "working", task_id: task.id, tmux_target: "cc:@9" });
    updateAgent(reviewer.id, { last_event_at: "2026-07-03T10:00:00.000Z" });

    const killed: number[] = [];
    watchdog(reapDeps(killed, "2026-07-03T11:00:00.000Z"));
    expect(killed).toEqual([]);
  });

  // --- early-reap: approved, awaiting human merge ---

  /** An in-review task whose internal review APPROVED and whose PR is ready,
   *  with a finished (idle) worker that has been silent past the grace. */
  async function approvedReadyWorker(
    setupFns: Awaited<ReturnType<typeof setup>>,
    overrides: Record<string, unknown> = {},
  ) {
    const { createTask, updateTask, createAgent, updateAgent } = setupFns;
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    const a = createAgent({ kind: "worker", state: "idle", task_id: task.id, tmux_target: "cc:@9" });
    updateTask(task.id, {
      status: "review",
      agent_id: a.id,
      review_verdict: "approve",
      pr_is_draft: 0,
      ...overrides,
    });
    updateAgent(a.id, { last_event_at: "2026-07-03T10:00:00.000Z" });
    return a.id;
  }

  // One table for the whole early-reap decision. These were six tests differing
  // in a single task/agent field each. Reaping wrongly costs a worker that a fix
  // round could have resumed in-session, so every input is kept as a row.
  it("early-reaps only an approved, idle worker whose PR is out of internal review", async () => {
    for (const { why, overrides, agentPatch, now, reaped } of [
      {
        why: "an approved worker whose PR has flipped ready, after the grace",
        now: "2026-07-03T10:20:00.000Z", // 20m > 10m grace
        reaped: true,
      },
      {
        why: "an approved no-PR task's worker",
        overrides: { open_pr: 0, pr_is_draft: null },
        now: "2026-07-03T10:20:00.000Z",
        reaped: true,
      },
      {
        why: "NOT while the PR is still a draft (internal review pending)",
        overrides: { pr_is_draft: 1 },
        now: "2026-07-03T11:00:00.000Z",
        reaped: false,
      },
      {
        why: "NOT a rejected in-review worker (a fix round may resume it live)",
        overrides: { review_verdict: "reject" },
        now: "2026-07-03T11:00:00.000Z",
        reaped: false,
      },
      {
        why: "NOT an unreviewed in-review worker",
        overrides: { review_verdict: null },
        now: "2026-07-03T11:00:00.000Z",
        reaped: false,
      },
      {
        why: "NOT a worker that is still mid-turn (resumed / working)",
        agentPatch: { state: "working" },
        now: "2026-07-03T11:00:00.000Z",
        reaped: false,
      },
      {
        why: "NOT before the grace period elapses",
        now: "2026-07-03T10:05:00.000Z", // 5m < 10m grace
        reaped: false,
      },
    ] as const) {
      const fns = await setup();
      // Per-row isolation: setup() re-imports the modules but shares the
      // database, so an agent left by the previous row is still reapable and
      // would be counted against this row's expectation.
      const { getDb } = await import("../src/db/db.js");
      getDb().prepare("DELETE FROM agents").run();
      getDb().prepare("DELETE FROM tasks").run();
      const id = await approvedReadyWorker(fns, overrides ?? {});
      if (agentPatch) fns.updateAgent(id, agentPatch);
      const killed: number[] = [];
      fns.watchdog(reapDeps(killed, now));
      expect(killed, why).toEqual(reaped ? [id] : []);
      if (reaped) {
        const event = fns.listEvents().find((e) => e.kind === "agent.reaped");
        expect(JSON.parse(event?.payload ?? "{}").reason, why).toBe(
          "approved_awaiting_merge",
        );
      }
    }
  });

});

describe("watchdog abandoned-spawn reap", () => {
  /**
   * The state a daemon death between createAgent and attachPane leaves: a live
   * worker row with no window and no pane handle, on a task it has claimed.
   * `spawning` is where spawnWorker leaves it; the watchdog's own SessionStart
   * timeout is what moves it to `stalled` (asserted below rather than faked).
   */
  async function interruptedSpawn() {
    const tasks = await import("../src/db/tasks.js");
    const agents = await import("../src/db/agents.js");
    const { getDb } = await import("../src/db/db.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    const scheduler = await import("../src/daemon/scheduler.js");
    const { listEvents } = await import("../src/db/events.js");
    const { workerSlots } = await import("../src/daemon/capacity.js");
    const { killAgent } = await import("../src/daemon/spawn.js");
    setSchedulerConfig({ reap_after_minutes: 10, max_concurrent: 1 });
    // Table-driven callers share one database across rows; a row left live by
    // the previous case would be reaped (or counted) against this one.
    getDb().prepare("DELETE FROM agents").run();
    getDb().prepare("DELETE FROM tasks").run();
    getDb().prepare("DELETE FROM events").run();

    // The grace period is measured from an EVENT the watchdog writes, and
    // logEvent stamps those from the database clock — so the injected clock has
    // to be anchored to the real one, offset by minutes, or every age comes out
    // negative. Same reason test/reviewer-reap.ts drives its reap off Date.now().
    const base = Date.now();
    /** How long before the first pass the interrupted spawn started. Anything
     *  past SESSION_START_TIMEOUT_MS (90s) makes that pass relabel the row. */
    const spawnedAgo = 5 * 60_000;

    const task = tasks.createTask({ title: "t", prompt: "x", repo: "/r" });
    const claimed = tasks.claimTask(task.id)!;
    const agent = agents.createAgent({
      kind: "worker",
      provider: "codex",
      state: "spawning",
      task_id: task.id,
    });
    const spawnedAt = (agentId: number, atMs: number) =>
      getDb()
        .prepare("UPDATE agents SET spawned_at = ? WHERE id = ?")
        .run(new Date(atMs).toISOString(), agentId);
    spawnedAt(agent.id, base - spawnedAgo);

    // The real teardown: a paneless row has no window and no pane handle, so
    // killAgent asks tmux nothing at all — no mock needed, and the row really
    // does end up dead, which is what the capacity assertions depend on.
    const killed: number[] = [];
    const deps = (afterMin: number) => ({
      spawn: () => {},
      kill: (id: number) => {
        killed.push(id);
        killAgent(id);
      },
      // cc:@9 is listed as live so that a row given that target is declined by
      // the reap predicate itself, not by the vanished-window confirmation.
      windows: () => seen(["cc:@9"]),
      now: () => new Date(base + afterMin * 60_000),
    });
    return {
      ...tasks,
      ...agents,
      ...scheduler,
      listEvents,
      workerSlots,
      task: claimed,
      agent,
      killed,
      deps,
      base,
      spawnedAgo,
      spawnedAt,
    };
  }

  it("retires a paneless stalled worker after the grace period and gives the slot back", async () => {
    const { watchdog, getAgent, getTask, listEvents, workerSlots, task, agent, killed, deps } =
      await interruptedSpawn();

    // First pass: the SessionStart timeout relabels it, and nothing reaps it.
    watchdog(deps(0));
    expect(getAgent(agent.id)?.state).toBe("stalled");
    expect(killed).toEqual([]);
    expect(workerSlots().counted.map((w) => w.id)).toEqual([agent.id]);

    // Still inside the 10m reap grace, which runs from the relabelling — not
    // from spawned_at, which is already 5m old by the first pass.
    watchdog(deps(9));
    expect(killed).toEqual([]);

    // Past the grace: retired, task back on the queue, slot released.
    watchdog(deps(11));
    expect(killed).toEqual([agent.id]);
    expect(getAgent(agent.id)?.state).toBe("dead");
    expect(getTask(task.id)?.status).toBe("queued");
    expect(getTask(task.id)?.agent_id).toBeNull();
    // The point of the reap: capacity accounting must agree the slot is free.
    expect(workerSlots().counted).toEqual([]);
    const abandoned = listEvents().find((e) => e.kind === "worker.spawn_abandoned");
    expect(abandoned?.agent_id).toBe(agent.id);
    expect(abandoned?.task_id).toBe(task.id);
    // The "did not initialize" signal is not replaced by the reap.
    expect(listEvents().map((e) => e.kind)).toContain("agent.session_start_missing");
  });

  it("spends the task's one retry, then fails it instead of retrying forever", async () => {
    const { watchdog, createAgent, getTask, claimTask, task, deps, base, spawnedAt } =
      await interruptedSpawn();
    watchdog(deps(0));
    watchdog(deps(11));
    expect(getTask(task.id)?.status).toBe("queued");

    // The replacement spawn is interrupted exactly the same way.
    claimTask(task.id);
    const second = createAgent({ kind: "worker", state: "spawning", task_id: task.id });
    spawnedAt(second.id, base + 11 * 60_000);
    watchdog(deps(14)); // relabelled
    watchdog(deps(25)); // past the grace
    expect(getTask(task.id)?.status).toBe("failed");
  });

  it("only retires a row that proves nothing is running behind it", async () => {
    for (const { why, patch, events, reaped } of [
      {
        why: "a paneless stalled worker with no session handshake",
        reaped: true,
      },
      {
        why: "NOT one that still has a tmux window",
        patch: { tmux_target: "cc:@9" },
        reaped: false,
      },
      {
        why: "NOT one that recorded a pane pid",
        patch: { pane_pid: 4242 },
        reaped: false,
      },
      {
        why: "NOT one whose provider session reported in",
        events: ["hook.sessionstart"],
        reaped: false,
      },
      {
        why: "NOT one that is still spawning",
        patch: { state: "spawning" },
        reaped: false,
      },
      {
        why: "NOT one that reached a live-session state",
        patch: { state: "idle" },
        reaped: false,
      },
    ] as const) {
      const { watchdog, updateAgent, agent, killed, deps } = await interruptedSpawn();
      const { logEvent } = await import("../src/db/events.js");
      // Relabel it via the real timeout first, then perturb one input.
      watchdog(deps(0));
      if (patch) updateAgent(agent.id, patch);
      for (const kind of events ?? []) logEvent(kind, { agentId: agent.id });

      watchdog(deps(11));
      expect(killed, why).toEqual(reaped ? [agent.id] : []);
    }
  });
});

describe("watchdog stall detection (unaffected by idle-in-review suppression)", () => {
  async function setup() {
    const tasks = await import("../src/db/tasks.js");
    const agents = await import("../src/db/agents.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    const { watchdog } = await import("../src/daemon/scheduler.js");
    const { listEvents } = await import("../src/db/events.js");
    setSchedulerConfig({ stall_minutes: 15 });
    return { ...tasks, ...agents, watchdog, listEvents };
  }

  function stallDeps(nowIso: string) {
    return {
      spawn: () => {},
      kill: () => {},
      windows: () => seen(["cc:@9"]),
      now: () => new Date(nowIso),
    };
  }

  it("still stalls a silent working WORKER (stall is a separate detector from idle suppression)", async () => {
    const { createTask, updateTask, createAgent, updateAgent, watchdog, listEvents } = await setup();
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    const a = createAgent({ kind: "worker", state: "working", task_id: task.id, tmux_target: "cc:@9" });
    updateTask(task.id, { status: "in_progress", agent_id: a.id });
    updateAgent(a.id, { last_event_at: "2026-07-03T10:00:00.000Z" });

    watchdog(stallDeps("2026-07-03T10:20:00.000Z")); // 20m > 15m stall
    const stalled = listEvents().filter((e) => e.kind === "agent.stalled");
    expect(stalled.map((e) => e.agent_id)).toEqual([a.id]);
    expect(listEvents().map((e) => e.kind)).not.toContain("waiting.suppressed_in_review");
  });

  it("stalls (escalates) a frozen working REVIEWER mid-review — idle suppression does not touch it", async () => {
    const { createTask, updateTask, createAgent, updateAgent, watchdog, listEvents } = await setup();
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    updateTask(task.id, { status: "review" });
    const reviewer = createAgent({
      kind: "reviewer",
      state: "working",
      task_id: task.id,
      tmux_target: "cc:@9",
    });
    updateAgent(reviewer.id, { last_event_at: "2026-07-03T10:00:00.000Z" });

    watchdog(stallDeps("2026-07-03T10:20:00.000Z")); // 20m > 15m stall
    const stalled = listEvents().filter((e) => e.kind === "agent.stalled");
    expect(stalled.map((e) => e.agent_id)).toEqual([reviewer.id]);
    const { getAgent } = await import("../src/db/agents.js");
    expect(getAgent(reviewer.id)?.state).toBe("stalled");
    expect(listEvents().map((e) => e.kind)).not.toContain("waiting.suppressed_in_review");
  });

  it("does NOT stall before stall_minutes elapses", async () => {
    const { createTask, updateTask, createAgent, updateAgent, watchdog, listEvents } = await setup();
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    updateTask(task.id, { status: "review" });
    const reviewer = createAgent({ kind: "reviewer", state: "working", task_id: task.id, tmux_target: "cc:@9" });
    updateAgent(reviewer.id, { last_event_at: "2026-07-03T10:00:00.000Z" });

    watchdog(stallDeps("2026-07-03T10:05:00.000Z")); // 5m < 15m
    expect(listEvents().map((e) => e.kind)).not.toContain("agent.stalled");
  });
});

describe("scheduler capacity_blocked visibility", () => {
  it("emits capacity_blocked (once, throttled) when ready work has no free slot", async () => {
    const { createTask } = await import("../src/db/tasks.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    const { countEventsToday } = await import("../src/db/events.js");
    const { tick } = await import("../src/daemon/scheduler.js");
    setSchedulerConfig({ enabled: true, max_concurrent: 1 });
    createAgent({ kind: "worker", state: "idle" }); // holds the only slot
    createTask({ title: "waiting", prompt: "x", repo: "/r" });

    const { spawned, deps: d } = deps({ now: new Date("2026-07-03T12:00:00Z") });
    tick(d);
    tick(d); // same minute -> throttled, no second event
    expect(spawned).toEqual([]);
    expect(countEventsToday("scheduler.capacity_blocked")).toBe(1);
  });

  it("does not emit capacity_blocked when the queue is empty", async () => {
    const { createAgent } = await import("../src/db/agents.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    const { countEventsToday } = await import("../src/db/events.js");
    const { tick } = await import("../src/daemon/scheduler.js");
    setSchedulerConfig({ enabled: true, max_concurrent: 1 });
    createAgent({ kind: "worker", state: "idle" });

    const { deps: d } = deps();
    tick(d);
    expect(countEventsToday("scheduler.capacity_blocked")).toBe(0);
  });
});
