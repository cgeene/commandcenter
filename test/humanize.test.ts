import { describe, expect, it } from "vitest";
import { humanizeEvent } from "../src/daemon/humanize.js";
import type { Event } from "../src/db/events.js";

function ev(over: Partial<Event>): Event {
  return {
    id: 1,
    ts: "2026-07-09T12:00:00.000Z",
    agent_id: null,
    task_id: null,
    kind: "task.created",
    payload: null,
    ...over,
  };
}

describe("humanizeEvent", () => {
  it("review.rejected quotes the first 80 chars of the notes", () => {
    const notes = "The migration drops a column still read by the reporting job; guard it first.";
    const s = humanizeEvent(
      ev({ kind: "review.rejected", task_id: 16, payload: JSON.stringify({ notes }) }),
    );
    expect(s).toBe(`Reviewer rejected #16: ${notes}`);
  });

  it("review.rejected clips notes longer than 80 chars", () => {
    const notes = "x".repeat(200);
    const s = humanizeEvent(
      ev({ kind: "review.rejected", task_id: 3, payload: JSON.stringify({ notes }) }),
    );
    expect(s).toBe(`Reviewer rejected #3: ${"x".repeat(80)}…`);
  });

  it("agent.auto_nudged names the worker and the transient stall", () => {
    const s = humanizeEvent(
      ev({ kind: "agent.auto_nudged", agent_id: 22, payload: JSON.stringify({ error: "529 overloaded", attempt: 1 }) }),
    );
    expect(s).toBe("Auto-nudged worker 22 (transient API stall)");
  });

  it("cron.skipped names the cron and reason", () => {
    const s = humanizeEvent(
      ev({ kind: "cron.skipped", payload: JSON.stringify({ name: "slack-triage", reason: "previous run still open" }) }),
    );
    expect(s).toBe("Skipped slack-triage: previous run still open");
  });

  it("task.status renders the transition", () => {
    const s = humanizeEvent(
      ev({ kind: "task.status", task_id: 7, payload: JSON.stringify({ from: "queued", to: "in_progress" }) }),
    );
    expect(s).toBe("#7 moved queued → in_progress");
  });

  it("pr.sync_broken surfaces the failure count and error", () => {
    const s = humanizeEvent(
      ev({ kind: "pr.sync_broken", task_id: 41, payload: JSON.stringify({ fails: 3, error: "gh: not found" }) }),
    );
    expect(s).toBe("PR sync broken for #41 after 3 tries: gh: not found");
  });

  it("pr.feedback pluralizes correctly", () => {
    expect(
      humanizeEvent(ev({ kind: "pr.feedback", task_id: 5, payload: JSON.stringify({ comments: 1 }) })),
    ).toBe("New PR feedback on #5 (1 comment)");
    expect(
      humanizeEvent(ev({ kind: "pr.feedback", task_id: 5, payload: JSON.stringify({ comments: 2, changes_requested: true }) })),
    ).toBe("New PR feedback on #5 (2 comments, changes requested)");
  });

  it("review_local_branch_expected reads as expected operation, not an alarm", () => {
    const s = humanizeEvent(
      ev({
        kind: "worktree.review_local_branch_expected",
        task_id: 32,
        payload: JSON.stringify({ branch: "agent/task-32", reason: "branch-not-on-origin", open_pr: false }),
      }),
    );
    expect(s).toBe(
      "Reviewing #32 from the local branch (branch-not-on-origin) — expected, origin has no newer copy",
    );
  });

  it("review_fallback_local_branch surfaces the fetch error as a stale-review risk", () => {
    const s = humanizeEvent(
      ev({
        kind: "worktree.review_fallback_local_branch",
        task_id: 12,
        payload: JSON.stringify({ branch: "agent/task-12", reason: "fetch-failed", open_pr: true, detail: "fatal: unable to access remote" }),
      }),
    );
    expect(s).toBe(
      "Reviewing #12 from a stale local branch — fetch failed (fatal: unable to access remote)",
    );
  });

  it("unknown kinds fall back to kind + refs + raw payload", () => {
    const s = humanizeEvent(
      ev({ kind: "some.new_kind", task_id: 9, agent_id: 4, payload: JSON.stringify({ a: 1 }) }),
    );
    expect(s).toContain("some.new_kind");
    expect(s).toContain("#9");
    expect(s).toContain("a4");
    expect(s).toContain('{"a":1}');
  });

  it("agent.reaped names the worker, task, and terminal status", () => {
    const s = humanizeEvent(
      ev({ kind: "agent.reaped", agent_id: 7, task_id: 42, payload: JSON.stringify({ task_status: "done" }) }),
    );
    expect(s).toBe("Reaped worker 7 — #42 finished (done), freeing its slot");
  });

  it("scheduler.capacity_blocked reports the taken slots", () => {
    const s = humanizeEvent(
      ev({ kind: "scheduler.capacity_blocked", payload: JSON.stringify({ live_workers: 3, max_concurrent: 3 }) }),
    );
    expect(s).toBe("Scheduler stalled — 3/3 worker slots taken while tasks wait");
  });

  it("tolerates missing/garbage payloads without throwing", () => {
    expect(humanizeEvent(ev({ kind: "review.rejected", task_id: 2, payload: null }))).toBe(
      "Reviewer rejected #2",
    );
    expect(humanizeEvent(ev({ kind: "task.status", task_id: 2, payload: "not json" }))).toBe(
      "#2 moved ? → ?",
    );
  });
});
