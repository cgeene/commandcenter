import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-attention-"));
  process.env.CC_DATA_DIR = tmpDir;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const allOpen = () => true;

/** An approved task with an open PR — the raw material for a merge item. */
async function approvedPrTask(over: {
  prompt?: string;
  status?: "review" | "done";
} = {}) {
  const { createTask, updateTask } = await import("../src/db/tasks.js");
  const t = createTask({
    title: "ship it",
    prompt: over.prompt ?? "do a thing",
    repo: "/r",
  });
  return updateTask(t.id, {
    status: over.status ?? "review",
    review_verdict: "approve",
    review_notes: "looks good",
    result_summary: "implemented X and verified with tests",
    pr_url: `https://github.com/nylas/repo/pull/${t.id}`,
    branch: `agent/task-${t.id}`,
  })!;
}

async function backdate(table: "tasks" | "agents", id: number, col: string, minutesAgo: number) {
  const { getDb } = await import("../src/db/db.js");
  getDb()
    .prepare(`UPDATE ${table} SET ${col} = ? WHERE id = ?`)
    .run(new Date(Date.now() - minutesAgo * 60_000).toISOString(), id);
}

describe("deriveAttention — kinds", () => {
  it("surfaces orchestrated tasks when Claude main is unavailable", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const { createTask } = await import("../src/db/tasks.js");
    const task = createTask({
      title: "needs triage",
      prompt: "x",
      repo: "/r",
      dispatch_mode: "orchestrated",
    });
    const items = deriveAttention({ isPrOpen: allOpen });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "orchestration",
      task_id: task.id,
      severity: "yellow",
    });
  });

  it("does not page the human when Claude main owns the orchestration queue", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const { createTask } = await import("../src/db/tasks.js");
    const { createAgent } = await import("../src/db/agents.js");
    createTask({
      title: "owned",
      prompt: "x",
      repo: "/r",
      dispatch_mode: "orchestrated",
    });
    createAgent({ kind: "main", state: "idle", tmux_target: "cc:@main" });
    expect(deriveAttention({ isPrOpen: allOpen })).toHaveLength(0);
  });

  it("does not page for an orchestrated task whose blocker is still open", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const { createTask } = await import("../src/db/tasks.js");
    const blocker = createTask({ title: "first", prompt: "x", repo: "/r" });
    createTask({
      title: "wait for first",
      prompt: "x",
      repo: "/r",
      dispatch_mode: "orchestrated",
      blocked_by: blocker.id,
    });
    expect(deriveAttention({ isPrOpen: allOpen })).toHaveLength(0);
  });

  it("merge_pr for an approved task with an open PR", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const t = await approvedPrTask();
    const items = deriveAttention({ isPrOpen: allOpen });
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("merge_pr");
    expect(items[0].id).toBe(`merge_pr:${t.id}`);
    expect(items[0].severity).toBe("yellow");
    expect(items[0].pr_url).toBe(t.pr_url);
    expect(items[0].context).toContain("implemented X");
  });

  it("merge_and_apply (red, urgent) when the prompt has a terraform apply", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    await approvedPrTask({ prompt: "run terraform apply for cost allocation" });
    const items = deriveAttention({ isPrOpen: allOpen });
    expect(items[0].kind).toBe("merge_and_apply");
    expect(items[0].severity).toBe("red");
    expect(items[0].urgent).toBe(true);
  });

  it("a merged/closed PR produces no merge item", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    await approvedPrTask();
    const items = deriveAttention({ isPrOpen: () => false });
    expect(items).toHaveLength(0);
  });

  it("skips a branch-only task (open_pr=0) even if approved with a pr_url", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const { updateTask } = await import("../src/db/tasks.js");
    const t = await approvedPrTask();
    updateTask(t.id, { open_pr: 0 });
    expect(deriveAttention({ isPrOpen: allOpen })).toHaveLength(0);
  });

  it("skips a still-draft PR (never merge a PR that hasn't passed internal review)", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const { updateTask } = await import("../src/db/tasks.js");
    const t = await approvedPrTask();
    updateTask(t.id, { pr_is_draft: 1 }); // ready-flip failed or stale
    expect(deriveAttention({ isPrOpen: allOpen })).toHaveLength(0);
  });

  it("still surfaces a ready (pr_is_draft=0) approved PR for merge", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const { updateTask } = await import("../src/db/tasks.js");
    const t = await approvedPrTask();
    updateTask(t.id, { pr_is_draft: 0 });
    const items = deriveAttention({ isPrOpen: allOpen });
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("merge_pr");
  });

  it("decision for a task blocked after >= review_max_cycles", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    setSchedulerConfig({ review_max_cycles: 2 });
    const t = createTask({ title: "hard call", prompt: "x", repo: "/r" });
    updateTask(t.id, {
      status: "blocked",
      review_cycles: 2,
      review_notes: "reviewer and worker disagree on the approach",
    });
    const items = deriveAttention({ isPrOpen: allOpen });
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("decision");
    expect(items[0].id).toBe(`decision:${t.id}:2`);
    expect(items[0].title).toContain("review loop exhausted after 2 rounds");
    expect(items[0].context).toContain("disagree");
  });

  it("a blocked task with < review_max_cycles is not a decision", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    setSchedulerConfig({ review_max_cycles: 2 });
    const t = createTask({ title: "t", prompt: "x", repo: "/r" });
    updateTask(t.id, { status: "blocked", review_cycles: 1 });
    expect(deriveAttention({ isPrOpen: allOpen })).toHaveLength(0);
  });

  it("escalation for a live waiting worker whose wait was escalated", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { logEvent } = await import("../src/db/events.js");
    const a = createAgent({ kind: "worker", state: "waiting_input" });
    logEvent("hook.notification", { agentId: a.id });
    await backdate("agents", a.id, "spawned_at", 20); // not used, harmless
    logEvent("waiting.escalated", { agentId: a.id });
    const items = deriveAttention({ isPrOpen: allOpen });
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("escalation");
    expect(items[0].agent_id).toBe(a.id);
    expect(items[0].severity).toBe("red");
  });

  it("no escalation when the wait was never escalated", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { logEvent } = await import("../src/db/events.js");
    const a = createAgent({ kind: "worker", state: "waiting_input" });
    logEvent("hook.notification", { agentId: a.id });
    // fresh wait, still within threshold -> nothing yet
    const items = deriveAttention({ isPrOpen: allOpen });
    expect(items).toHaveLength(0);
  });

  it("stale_waiting for a worker waiting past the threshold, un-escalated", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { logEvent } = await import("../src/db/events.js");
    const a = createAgent({ kind: "worker", state: "waiting_input" });
    logEvent("hook.notification", { agentId: a.id });
    await backdate("agents", a.id, "spawned_at", 30);
    const { getDb } = await import("../src/db/db.js");
    getDb()
      .prepare("UPDATE events SET ts = ? WHERE kind = 'hook.notification'")
      .run(new Date(Date.now() - 15 * 60_000).toISOString()); // > 10m default
    const items = deriveAttention({ isPrOpen: allOpen });
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("stale_waiting");
    expect(items[0].severity).toBe("yellow");
  });

  it("stale_waiting includes Codex permission waits", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { logEvent } = await import("../src/db/events.js");
    const { getDb } = await import("../src/db/db.js");
    const a = createAgent({
      kind: "worker",
      provider: "codex",
      state: "waiting_input",
    });
    logEvent("hook.permissionrequest", { agentId: a.id });
    getDb()
      .prepare("UPDATE events SET ts = ? WHERE kind = 'hook.permissionrequest'")
      .run(new Date(Date.now() - 15 * 60_000).toISOString());

    const items = deriveAttention({ isPrOpen: allOpen });
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("stale_waiting");
    expect(items[0].agent_id).toBe(a.id);
  });

  it("stale_waiting includes provider startup trust waits", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { logEvent } = await import("../src/db/events.js");
    const { getDb } = await import("../src/db/db.js");
    const a = createAgent({
      kind: "worker",
      provider: "codex",
      state: "waiting_input",
    });
    logEvent("agent.startup_permission", {
      agentId: a.id,
      payload: { trust: true },
    });
    getDb()
      .prepare("UPDATE events SET ts = ? WHERE kind = 'agent.startup_permission'")
      .run(new Date(Date.now() - 15 * 60_000).toISOString());

    const items = deriveAttention({ isPrOpen: allOpen });
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("stale_waiting");
    expect(items[0].agent_id).toBe(a.id);
  });

  it("an escalated wait is reported once, as escalation not stale_waiting", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { logEvent } = await import("../src/db/events.js");
    const { getDb } = await import("../src/db/db.js");
    const a = createAgent({ kind: "worker", state: "waiting_input" });
    logEvent("hook.notification", { agentId: a.id });
    getDb()
      .prepare("UPDATE events SET ts = ? WHERE kind = 'hook.notification'")
      .run(new Date(Date.now() - 15 * 60_000).toISOString());
    logEvent("waiting.escalated", { agentId: a.id });
    const items = deriveAttention({ isPrOpen: allOpen });
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("escalation");
  });

  /**
   * Both wait producers are anchored on EVENTS, so neither notices a task moving
   * on underneath them: the wait hook and the escalation stay the newest of their
   * kind forever. A worker that idled mid-verify and then had its task sent to
   * review therefore kept generating both items — while a live reviewer was
   * working that very task.
   */
  describe("a wait whose task moved out of the worker's reach", () => {
    async function waitingWorkerOn(
      status: "in_progress" | "blocked" | "review" | "done" | "cancelled",
      kind: "worker" | "reviewer" = "worker",
      opts: { escalate?: boolean } = {},
    ) {
      const { createAgent } = await import("../src/db/agents.js");
      const { createTask, updateTask } = await import("../src/db/tasks.js");
      const { logEvent } = await import("../src/db/events.js");
      const { getDb } = await import("../src/db/db.js");
      const t = createTask({ title: "ship it", prompt: "x", repo: "/r" });
      const a = createAgent({ kind, state: "waiting_input", task_id: t.id });
      updateTask(t.id, { status, agent_id: a.id });
      logEvent("hook.notification", { agentId: a.id });
      // Older than attention_stale_minutes (10m default) so stale_waiting is due.
      getDb()
        .prepare("UPDATE events SET ts = ? WHERE kind = 'hook.notification'")
        .run(new Date(Date.now() - 15 * 60_000).toISOString());
      if (opts.escalate) logEvent("waiting.escalated", { agentId: a.id });
      return { task: t, agent: a };
    }

    for (const status of ["review", "done", "cancelled"] as const) {
      it(`produces no escalation item while the task is ${status}`, async () => {
        const { deriveAttention } = await import("../src/daemon/attention.js");
        const { agent } = await waitingWorkerOn(status, "worker", {
          escalate: true,
        });
        const items = deriveAttention({ isPrOpen: allOpen });
        expect(items.filter((i) => i.agent_id === agent.id)).toEqual([]);
        expect(items.map((i) => i.kind)).not.toContain("escalation");
      });

      it(`produces no stale_waiting item while the task is ${status}`, async () => {
        const { deriveAttention } = await import("../src/daemon/attention.js");
        const { agent } = await waitingWorkerOn(status);
        const items = deriveAttention({ isPrOpen: allOpen });
        expect(items.filter((i) => i.agent_id === agent.id)).toEqual([]);
        expect(items.map((i) => i.kind)).not.toContain("stale_waiting");
      });
    }

    for (const status of ["in_progress", "blocked"] as const) {
      it(`still escalates a worker waiting on a ${status} task`, async () => {
        const { deriveAttention } = await import("../src/daemon/attention.js");
        const { agent } = await waitingWorkerOn(status, "worker", {
          escalate: true,
        });
        const items = deriveAttention({ isPrOpen: allOpen }).filter(
          (i) => i.agent_id === agent.id,
        );
        expect(items).toHaveLength(1);
        expect(items[0].kind).toBe("escalation");
      });

      it(`still flags a stale wait on a ${status} task`, async () => {
        const { deriveAttention } = await import("../src/daemon/attention.js");
        const { agent } = await waitingWorkerOn(status);
        const items = deriveAttention({ isPrOpen: allOpen }).filter(
          (i) => i.agent_id === agent.id,
        );
        expect(items).toHaveLength(1);
        expect(items[0].kind).toBe("stale_waiting");
      });
    }

    // A reviewer's task is "review" by definition, so a status-only test would
    // silence every reviewer wait — and an unanswered reviewer is a task stuck
    // in review with no verdict coming.
    it("still flags a REVIEWER waiting on a task that is in review", async () => {
      const { deriveAttention } = await import("../src/daemon/attention.js");
      const { agent } = await waitingWorkerOn("review", "reviewer");
      const items = deriveAttention({ isPrOpen: allOpen }).filter(
        (i) => i.agent_id === agent.id,
      );
      expect(items).toHaveLength(1);
      expect(items[0].kind).toBe("stale_waiting");
    });
  });

  it("ignores the main agent's own waiting_input", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { logEvent } = await import("../src/db/events.js");
    const m = createAgent({ kind: "main", state: "waiting_input" });
    logEvent("hook.notification", { agentId: m.id });
    logEvent("waiting.escalated", { agentId: m.id });
    expect(deriveAttention({ isPrOpen: allOpen })).toHaveLength(0);
  });
});

describe("deriveAttention — ordering", () => {
  it("sorts by severity desc then age desc", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    setSchedulerConfig({ review_max_cycles: 2 });

    // yellow merge_pr (newest)
    await approvedPrTask();
    // orange decision
    const d = createTask({ title: "decide", prompt: "x", repo: "/r" });
    updateTask(d.id, { status: "blocked", review_cycles: 2, review_notes: "n" });
    // red merge_and_apply, aged so it also wins the age tiebreak within red
    const r = await approvedPrTask({ prompt: "terraform apply this" });
    await backdate("tasks", r.id, "updated_at", 120);

    const items = deriveAttention({ isPrOpen: allOpen });
    expect(items.map((i) => i.severity)).toEqual(["red", "orange", "yellow"]);
  });

  it("within a severity, older items rank first", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const older = await approvedPrTask();
    const newer = await approvedPrTask();
    await backdate("tasks", older.id, "updated_at", 90);
    const items = deriveAttention({ isPrOpen: allOpen });
    expect(items[0].task_id).toBe(older.id);
    expect(items[1].task_id).toBe(newer.id);
  });
});

describe("deriveAttention — dismissal", () => {
  it("a dismissed item drops out", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const { dismissAttention } = await import("../src/db/attention.js");
    const t = await approvedPrTask();
    dismissAttention(`merge_pr:${t.id}`);
    expect(deriveAttention({ isPrOpen: allOpen })).toHaveLength(0);
  });

  it("a re-triggered situation gets a new key and reappears", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const { dismissAttention } = await import("../src/db/attention.js");
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    setSchedulerConfig({ review_max_cycles: 2 });
    const t = createTask({ title: "t", prompt: "x", repo: "/r" });
    updateTask(t.id, { status: "blocked", review_cycles: 2, review_notes: "n" });
    dismissAttention(`decision:${t.id}:2`);
    expect(deriveAttention({ isPrOpen: allOpen })).toHaveLength(0);

    // a later review cycle -> new key -> old dismissal no longer covers it
    updateTask(t.id, { status: "blocked", review_cycles: 3 });
    const items = deriveAttention({ isPrOpen: allOpen });
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(`decision:${t.id}:3`);
  });
});

describe("deriveAttention — scheduler_stalled", () => {
  async function backdateEvent(kind: string, minutesAgo: number) {
    const { getDb } = await import("../src/db/db.js");
    getDb()
      .prepare("UPDATE events SET ts = ? WHERE kind = ?")
      .run(new Date(Date.now() - minutesAgo * 60_000).toISOString(), kind);
  }

  it("surfaces a yellow capacity item once the blockage persists past 15m", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const { createTask } = await import("../src/db/tasks.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    const { logEvent } = await import("../src/db/events.js");
    setSchedulerConfig({ enabled: true, max_concurrent: 1 });
    createAgent({ kind: "worker", state: "idle" }); // holds the only slot
    createTask({ title: "waiting", prompt: "x", repo: "/r" }); // ready
    logEvent("scheduler.capacity_blocked", { payload: { max_concurrent: 1 } });
    await backdateEvent("scheduler.capacity_blocked", 20);

    const items = deriveAttention({ isPrOpen: allOpen });
    const stalled = items.filter((i) => i.kind === "scheduler_stalled");
    expect(stalled).toHaveLength(1);
    expect(stalled[0].severity).toBe("yellow");
    expect(stalled[0].id).toContain("scheduler_stalled:capacity");
  });

  it("does not surface a capacity item before the 15m threshold", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const { createTask } = await import("../src/db/tasks.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    const { logEvent } = await import("../src/db/events.js");
    setSchedulerConfig({ enabled: true, max_concurrent: 1 });
    createAgent({ kind: "worker", state: "idle" });
    createTask({ title: "waiting", prompt: "x", repo: "/r" });
    logEvent("scheduler.capacity_blocked", { payload: { max_concurrent: 1 } });
    await backdateEvent("scheduler.capacity_blocked", 5); // fresh blip

    expect(
      deriveAttention({ isPrOpen: allOpen }).some((i) => i.kind === "scheduler_stalled"),
    ).toBe(false);
  });

  it("surfaces a budget item when today's spawn budget is spent with work waiting", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const { createTask } = await import("../src/db/tasks.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    const { logEvent } = await import("../src/db/events.js");
    setSchedulerConfig({ enabled: true, max_concurrent: 3, daily_spawn_limit: 2 });
    createTask({ title: "waiting", prompt: "x", repo: "/r" }); // ready, slots free
    logEvent("scheduler.spawned");
    logEvent("scheduler.spawned"); // 2/2 budget spent today
    logEvent("scheduler.budget_reached");
    await backdateEvent("scheduler.budget_reached", 20);

    const stalled = deriveAttention({ isPrOpen: allOpen }).filter(
      (i) => i.kind === "scheduler_stalled",
    );
    expect(stalled).toHaveLength(1);
    expect(stalled[0].id).toContain("scheduler_stalled:budget");
  });

  it("stays quiet when the scheduler is disabled", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const { createTask } = await import("../src/db/tasks.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    const { logEvent } = await import("../src/db/events.js");
    setSchedulerConfig({ enabled: false, max_concurrent: 1 });
    createAgent({ kind: "worker", state: "idle" });
    createTask({ title: "waiting", prompt: "x", repo: "/r" });
    logEvent("scheduler.capacity_blocked", { payload: { max_concurrent: 1 } });
    await backdateEvent("scheduler.capacity_blocked", 20);

    expect(
      deriveAttention({ isPrOpen: allOpen }).some((i) => i.kind === "scheduler_stalled"),
    ).toBe(false);
  });

  it("a dismissed capacity item drops out", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const { dismissAttention } = await import("../src/db/attention.js");
    const { createTask } = await import("../src/db/tasks.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    const { logEvent } = await import("../src/db/events.js");
    setSchedulerConfig({ enabled: true, max_concurrent: 1 });
    createAgent({ kind: "worker", state: "idle" });
    createTask({ title: "waiting", prompt: "x", repo: "/r" });
    logEvent("scheduler.capacity_blocked", { payload: { max_concurrent: 1 } });
    await backdateEvent("scheduler.capacity_blocked", 20);

    const item = deriveAttention({ isPrOpen: allOpen }).find(
      (i) => i.kind === "scheduler_stalled",
    )!;
    dismissAttention(item.id);
    expect(
      deriveAttention({ isPrOpen: allOpen }).some((i) => i.kind === "scheduler_stalled"),
    ).toBe(false);
  });
});

describe("deriveAttention — jira_sync", () => {
  /** A PR-bearing task whose JIRA ticket has failed to sync `fails` times. */
  async function jiraFailingTask(over: { fails?: number; jira_key?: string | null } = {}) {
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const t = createTask({ title: "sync me", prompt: "x", repo: "/r" });
    return updateTask(t.id, {
      pr_url: `https://github.com/nylas/repo/pull/${t.id}`,
      jira_key: over.jira_key === undefined ? "EN-1234" : over.jira_key,
      jira_sync_fails: over.fails ?? 3,
    })!;
  }

  it("does not raise below the failure threshold", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const { logEvent } = await import("../src/db/events.js");
    const t = await jiraFailingTask({ fails: 2 });
    logEvent("jira.sync_broken", { taskId: t.id });
    const items = deriveAttention({ isPrOpen: allOpen });
    expect(items.filter((i) => i.kind === "jira_sync")).toHaveLength(0);
  });

  it("does not raise at threshold until the sync_broken anchor event exists", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const t = await jiraFailingTask({ fails: 3 });
    // no jira.sync_broken event logged yet
    const items = deriveAttention({ isPrOpen: allOpen });
    expect(items.filter((i) => i.kind === "jira_sync")).toHaveLength(0);
    void t;
  });

  it("raises a jira_sync item at the threshold for a synced ticket", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const { logEvent } = await import("../src/db/events.js");
    const t = await jiraFailingTask({ fails: 3 });
    logEvent("jira.sync_broken", { taskId: t.id });
    const items = deriveAttention({ isPrOpen: allOpen });
    const jira = items.filter((i) => i.kind === "jira_sync");
    expect(jira).toHaveLength(1);
    expect(jira[0]).toMatchObject({
      kind: "jira_sync",
      task_id: t.id,
      severity: "orange",
    });
    expect(jira[0].title).toContain("EN-1234");
    expect(jira[0].pr_url).toBe(t.pr_url);
  });

  it("labels a keyless failing task as ticket-creation failing", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const { logEvent } = await import("../src/db/events.js");
    const t = await jiraFailingTask({ fails: 3, jira_key: null });
    logEvent("jira.sync_broken", { taskId: t.id });
    const jira = deriveAttention({ isPrOpen: allOpen }).filter((i) => i.kind === "jira_sync");
    expect(jira).toHaveLength(1);
    expect(jira[0].title).toContain("creation failing");
  });

  it("re-raises with a fresh key after a dismissed episode recurs", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const { logEvent } = await import("../src/db/events.js");
    const { dismissAttention } = await import("../src/db/attention.js");
    const t = await jiraFailingTask({ fails: 3 });

    // Episode 1: threshold reached, anchor event fires, item raised.
    logEvent("jira.sync_broken", { taskId: t.id });
    const first = deriveAttention({ isPrOpen: allOpen }).find((i) => i.kind === "jira_sync")!;
    expect(first).toBeTruthy();

    // Human dismisses it — gone while this episode's streak persists.
    dismissAttention(first.id);
    expect(
      deriveAttention({ isPrOpen: allOpen }).some((i) => i.kind === "jira_sync"),
    ).toBe(false);

    // Episode 2: a later failure episode logs a NEW anchor event → fresh key.
    logEvent("jira.sync_broken", { taskId: t.id });
    const second = deriveAttention({ isPrOpen: allOpen }).find((i) => i.kind === "jira_sync");
    expect(second).toBeTruthy();
    expect(second!.id).not.toBe(first.id);
  });
});

describe("deriveAttention — quota", () => {
  const RESETS = "2099-01-01T00:00:00.000Z"; // never elapsed

  let savedLiveUsage: string | undefined;
  beforeEach(() => {
    // The panel surfaces nothing at all on an install that opted out of
    // reading the OAuth credential, so every case here has to opt in.
    savedLiveUsage = process.env.CC_LIVE_USAGE;
    process.env.CC_LIVE_USAGE = "1";
  });
  afterEach(() => {
    if (savedLiveUsage === undefined) delete process.env.CC_LIVE_USAGE;
    else process.env.CC_LIVE_USAGE = savedLiveUsage;
  });

  /** Seed the live-usage cache the way a poll would. `error`/`fetched_at`
   *  model a feed that has since broken while its last good reading lingers. */
  async function seedUsage(
    percent: number | null,
    over: {
      resets_at?: string | null;
      limit_reached?: boolean;
      error?: string;
      fetched_at?: string;
    } = {},
  ) {
    const { setLiveUsageCache } = await import("../src/db/settings.js");
    const headline = {
      key: "session",
      label: "Session (5h)",
      percent,
      resets_at: over.resets_at === undefined ? RESETS : over.resets_at,
      severity: null,
      used_usd: null,
      limit_usd: null,
    };
    setLiveUsageCache({
      usage: {
        fetched_at: over.fetched_at ?? new Date().toISOString(),
        source: "claude-code-oauth",
        meters: [headline],
        headline,
        spend:
          over.limit_reached === undefined
            ? null
            : {
                used_usd: 50,
                limit_usd: 50,
                percent: 100,
                enabled: true,
                limit_reached: over.limit_reached,
                disabled_reason: null,
              },
        plan: "team",
      },
      error: over.error ?? null,
      // Bumped by every attempt, successful or not — which is exactly why the
      // staleness check keys off fetched_at instead.
      checked_at: new Date().toISOString(),
    });
  }

  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  const quotaItems = async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    return deriveAttention({ isPrOpen: allOpen }).filter((i) => i.kind === "quota");
  };

  it("raises nothing without a live feed", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    expect(deriveAttention({ isPrOpen: allOpen }).filter((i) => i.kind === "quota")).toHaveLength(
      0,
    );
  });

  it("raises nothing below the threshold", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    await seedUsage(70);
    expect(deriveAttention({ isPrOpen: allOpen }).filter((i) => i.kind === "quota")).toHaveLength(
      0,
    );
  });

  it("raises a quota item above the threshold", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    await seedUsage(88);
    const quota = deriveAttention({ isPrOpen: allOpen }).filter((i) => i.kind === "quota");
    expect(quota).toHaveLength(1);
    expect(quota[0]).toMatchObject({ severity: "yellow", task_id: null });
    expect(quota[0].title).toContain("88%");
  });

  it("goes hotter as the meter approaches exhaustion", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    await seedUsage(97);
    const quota = deriveAttention({ isPrOpen: allOpen }).find((i) => i.kind === "quota")!;
    expect(quota.severity).toBe("orange");
  });

  it("drops the item once the window it measured has elapsed", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    await seedUsage(97, { resets_at: "2020-01-01T00:00:00.000Z" });
    expect(deriveAttention({ isPrOpen: allOpen }).filter((i) => i.kind === "quota")).toHaveLength(
      0,
    );
  });

  it("raises a red item when the spend cap is hit", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    await seedUsage(10, { limit_reached: true });
    const quota = deriveAttention({ isPrOpen: allOpen }).filter((i) => i.kind === "quota");
    expect(quota).toHaveLength(1);
    expect(quota[0]).toMatchObject({ severity: "red", urgent: true });
  });

  it("honours the configured threshold and an explicit disable", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const { setQuotaSettings } = await import("../src/db/settings.js");
    await seedUsage(55);
    setQuotaSettings({ alert_threshold_percent: 50 });
    expect(deriveAttention({ isPrOpen: allOpen }).filter((i) => i.kind === "quota")).toHaveLength(
      1,
    );
    setQuotaSettings({ alert_threshold_percent: null });
    expect(deriveAttention({ isPrOpen: allOpen }).filter((i) => i.kind === "quota")).toHaveLength(
      0,
    );
  });

  // The cache is sticky by design (usagelive keeps the last good reading on a
  // failed poll, and nothing clears it when the poller stops for good), so a
  // hot value can outlive the situation it described.
  it("keeps raising through a brief outage — one 503 must not blank a real crossing", async () => {
    await seedUsage(90, { error: "HTTP 503", fetched_at: hoursAgo(1) });
    expect(await quotaItems()).toHaveLength(1);
  });

  it("drops a threshold item whose reading has gone stale behind a broken feed", async () => {
    await seedUsage(90, { error: "HTTP 401", fetched_at: hoursAgo(9) });
    expect(await quotaItems()).toHaveLength(0);
  });

  it("drops a stale spend-cap item — it has no reset instant to age it out", async () => {
    // The reviewer's repro: the last good poll caught the cap, then the token
    // expired. Without the age bound this red/urgent item never goes away.
    await seedUsage(10, {
      limit_reached: true,
      error: "Claude Code OAuth token expired — it refreshes on next use",
      fetched_at: hoursAgo(30),
    });
    expect(await quotaItems()).toHaveLength(0);

    // Same reading, freshly fetched: still very much the operator's problem.
    await seedUsage(10, { limit_reached: true });
    expect(await quotaItems()).toHaveLength(1);
  });

  it("surfaces nothing when the operator opted out of the live feed", async () => {
    await seedUsage(97, { limit_reached: true });
    expect(await quotaItems()).toHaveLength(2);
    delete process.env.CC_LIVE_USAGE;
    expect(await quotaItems()).toHaveLength(0);
  });

  it("anchors the age on the latch only when it belongs to this window", async () => {
    const { setQuotaAlertLatch } = await import("../src/db/settings.js");
    const fetched = hoursAgo(1);

    // Latch left behind on an EARLIER window (alerting was off while the
    // window rolled, so evaluateQuotaAlerts never cleared it).
    setQuotaAlertLatch({
      threshold_window: "session@1999-01-01T00:00:00.000Z",
      threshold_at: "1999-01-01T00:00:00.000Z",
      spend_limit: false,
      spend_limit_at: null,
    });
    await seedUsage(90, { fetched_at: fetched });
    expect((await quotaItems())[0].created_at).toBe(fetched);

    // Latch that does describe this window supplies the real crossing time.
    const crossed = hoursAgo(2);
    setQuotaAlertLatch({
      threshold_window: `session@${RESETS}`,
      threshold_at: crossed,
      spend_limit: false,
      spend_limit_at: null,
    });
    expect((await quotaItems())[0].created_at).toBe(crossed);
  });

  it("re-raises in the next window after a dismissal", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const { dismissAttention } = await import("../src/db/attention.js");
    await seedUsage(90);
    const first = deriveAttention({ isPrOpen: allOpen }).find((i) => i.kind === "quota")!;
    dismissAttention(first.id);
    expect(deriveAttention({ isPrOpen: allOpen }).some((i) => i.kind === "quota")).toBe(false);

    await seedUsage(90, { resets_at: "2099-06-01T00:00:00.000Z" }); // next window
    const second = deriveAttention({ isPrOpen: allOpen }).find((i) => i.kind === "quota");
    expect(second).toBeTruthy();
    expect(second!.id).not.toBe(first.id);
  });
});
