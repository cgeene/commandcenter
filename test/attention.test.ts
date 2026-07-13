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
  const { _clearPrCache } = await import("../src/daemon/prcache.js");
  _clearPrCache();
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

  it("decision for a task blocked after >= MAX_REVIEW_CYCLES", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const { createTask, updateTask } = await import("../src/db/tasks.js");
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
    expect(items[0].context).toContain("disagree");
  });

  it("a blocked task with < MAX_REVIEW_CYCLES is not a decision", async () => {
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const { createTask, updateTask } = await import("../src/db/tasks.js");
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

describe("prcache", () => {
  it("returns a fresh cached value without shelling out", async () => {
    const { prState, _seedPrCache } = await import("../src/daemon/prcache.js");
    const url = "https://github.com/nylas/repo/pull/1";
    const now = 1_000_000;
    _seedPrCache(url, "MERGED", now);
    expect(await prState(url, now + 60_000)).toBe("MERGED"); // within 5m TTL
  });

  it("keeps the stale value when a refresh fails", async () => {
    const { prState, _seedPrCache } = await import("../src/daemon/prcache.js");
    // an unresolvable PR forces the gh call to fail on the stale-entry path
    const url = "https://github.com/nylas-does-not-exist-xyz/nope/pull/999999";
    const now = 2_000_000;
    _seedPrCache(url, "OPEN", now);
    // 6 minutes later the entry is stale; gh fails -> previous value retained
    expect(await prState(url, now + 6 * 60_000)).toBe("OPEN");
  });

  it("treats a non-PR url as unknown", async () => {
    const { prState } = await import("../src/daemon/prcache.js");
    expect(await prState("https://example.com/not/a/pr")).toBe("unknown");
  });

  it("prStates resolves many urls into one map", async () => {
    const { prStates, _seedPrCache } = await import("../src/daemon/prcache.js");
    const now = 3_000_000;
    _seedPrCache("https://github.com/a/b/pull/1", "OPEN", now);
    _seedPrCache("https://github.com/a/b/pull/2", "CLOSED", now);
    const map = await prStates(
      ["https://github.com/a/b/pull/1", "https://github.com/a/b/pull/2"],
      now + 1000,
    );
    expect(map.get("https://github.com/a/b/pull/1")).toBe("OPEN");
    expect(map.get("https://github.com/a/b/pull/2")).toBe("CLOSED");
  });
});
