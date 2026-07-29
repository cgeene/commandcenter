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

const REJECT_NOTES =
  "The migration drops a column still read by the reporting job; guard it first.";

describe("humanizeEvent", () => {
  // One table: every row is humanizeEvent(event) -> the exact line the panel
  // shows. These were 20 tests of identical shape differing only in the kind and
  // payload. Formatter output IS the assertion here, so exact strings are kept
  // rather than loosened to substrings.
  it("renders each event kind as its operator-facing line", () => {
    for (const { why, e, out } of [
      {
        why: "review.rejected quotes the notes",
        e: { kind: "review.rejected", task_id: 16, payload: { notes: REJECT_NOTES } },
        out: `Reviewer rejected #16: ${REJECT_NOTES}`,
      },
      {
        why: "review.rejected clips notes past 80 chars",
        e: { kind: "review.rejected", task_id: 3, payload: { notes: "x".repeat(200) } },
        out: `Reviewer rejected #3: ${"x".repeat(80)}…`,
      },
      {
        why: "review.rejected with no payload at all",
        e: { kind: "review.rejected", task_id: 2, payload: null },
        out: "Reviewer rejected #2",
      },
      {
        why: "review.round_started names the round and cap",
        e: { kind: "review.round_started", task_id: 12, payload: { round: 2, max: 4 } },
        out: "Started review round 2/4 for #12",
      },
      {
        why: "review.loop_exhausted names the round count",
        e: { kind: "review.loop_exhausted", task_id: 8, payload: { rounds: 4, max: 4 } },
        out: "#8 blocked — review loop exhausted after 4 rounds, human decision needed",
      },
      {
        why: "review.verdict_superseded names the superseding push",
        e: { kind: "review.verdict_superseded", task_id: 5, payload: { new_head: "abcdef1234567890" } },
        out: "#5's approval was superseded by a new push (abcdef123456…) — re-drafting and re-reviewing",
      },
      {
        why: "review.skipped_no_pr on a repo task with no PR",
        e: { kind: "review.skipped_no_pr", task_id: 109, payload: { task_id: 109, open_pr: 0, branch_has_commits: false } },
        out: "Skipped auto-review of #109 — repo task has no PR to review; review it manually if needed",
      },
      {
        why: "agent.auto_nudged names the worker and the transient stall",
        e: { kind: "agent.auto_nudged", agent_id: 22, payload: { error: "529 overloaded", attempt: 1 } },
        out: "Auto-nudged worker 22 (transient API stall)",
      },
      {
        why: "suppressed_active_monitor pluralizes each count independently",
        e: { kind: "waiting.suppressed_active_monitor", agent_id: 7, payload: { shells: 1, monitors: 2 } },
        out: "worker 7 parked between turns — 1 shell + 2 monitors still running, no ping needed",
      },
      {
        why: "suppressed_active_monitor omits a zero count",
        e: { kind: "waiting.suppressed_active_monitor", agent_id: 4, payload: { shells: 0, monitors: 1 } },
        out: "worker 4 parked between turns — 1 monitor still running, no ping needed",
      },
      {
        why: "suppressed_active_monitor falls back when counts are missing",
        e: { kind: "waiting.suppressed_active_monitor", agent_id: 9, payload: null },
        out: "worker 9 parked between turns — background work still running, no ping needed",
      },
      {
        why: "cron.skipped names the cron and reason",
        e: { kind: "cron.skipped", payload: { name: "slack-triage", reason: "previous run still open" } },
        out: "Skipped slack-triage: previous run still open",
      },
      {
        why: "task.status renders the transition",
        e: { kind: "task.status", task_id: 7, payload: { from: "queued", to: "in_progress" } },
        out: "#7 moved queued → in_progress",
      },
      {
        why: "task.status with an unparseable payload still renders",
        e: { kind: "task.status", task_id: 2, payload: "not json" },
        out: "#2 moved ? → ?",
      },
      {
        why: "task.autocompleted names the task and reason",
        e: { kind: "task.autocompleted", task_id: 70, payload: { reason: "PR merged" } },
        out: "Auto-completed #70 (PR merged)",
      },
      {
        why: "pr.sync_broken surfaces the failure count and error",
        e: { kind: "pr.sync_broken", task_id: 41, payload: { fails: 3, error: "gh: not found" } },
        out: "PR sync broken for #41 after 3 tries: gh: not found",
      },
      {
        why: "pr.feedback singular",
        e: { kind: "pr.feedback", task_id: 5, payload: { comments: 1 } },
        out: "New PR feedback on #5 (1 comment)",
      },
      {
        why: "pr.feedback plural with changes requested",
        e: { kind: "pr.feedback", task_id: 5, payload: { comments: 2, changes_requested: true } },
        out: "New PR feedback on #5 (2 comments, changes requested)",
      },
      {
        why: "review_local_branch_expected reads as expected operation, not an alarm",
        e: {
          kind: "worktree.review_local_branch_expected",
          task_id: 32,
          payload: { branch: "agent/task-32", reason: "branch-not-on-origin", open_pr: false },
        },
        out: "Reviewing #32 from the local branch (branch-not-on-origin) — expected, origin has no newer copy",
      },
      {
        why: "review_fallback_local_branch surfaces the fetch error as a stale-review risk",
        e: {
          kind: "worktree.review_fallback_local_branch",
          task_id: 12,
          payload: {
            branch: "agent/task-12",
            reason: "fetch-failed",
            open_pr: true,
            detail: "fatal: unable to access remote",
          },
        },
        out: "Reviewing #12 from a stale local branch — fetch failed (fatal: unable to access remote)",
      },
      {
        why: "agent.reaped names the worker, task, and terminal status",
        e: { kind: "agent.reaped", agent_id: 7, task_id: 42, payload: { task_status: "done" } },
        out: "Reaped worker 7 — #42 finished (done), freeing its slot",
      },
      {
        why: "scheduler.capacity_blocked reports the taken slots",
        e: { kind: "scheduler.capacity_blocked", payload: { live_workers: 3, max_concurrent: 3 } },
        out: "Scheduler stalled — 3/3 worker slots taken while tasks wait",
      },
    ]) {
      const { payload, ...rest } = e as Record<string, unknown>;
      const event = ev({
        ...rest,
        payload:
          payload === null || payload === undefined
            ? null
            : typeof payload === "string"
              ? payload
              : JSON.stringify(payload),
      } as Partial<Event>);
      expect(humanizeEvent(event), why).toBe(out);
    }
  });

  // Kept separate: these two assert a SHAPE rather than an exact line — the
  // negative ("must not say done") and the unknown-kind fallback's four
  // independent parts — so folding them into the exact-string table above would
  // mean weakening them to substrings.
  it("pr.merged on the override branch does NOT claim the task is done", () => {
    // pr.merged now fires only when a human merged a rejected/capped PR that
    // prsync deliberately left in review — the line must not say "done".
    const s = humanizeEvent(
      ev({ kind: "pr.merged", task_id: 20, payload: JSON.stringify({ autocompleted: false }) }),
    );
    expect(s).toContain("#20");
    expect(s).toContain("left in review");
    expect(s).not.toMatch(/\bdone\b/);
  });

  it("review.skipped_no_pr notes when the branch has commits", () => {
    const s = humanizeEvent(
      ev({
        kind: "review.skipped_no_pr",
        task_id: 42,
        payload: JSON.stringify({ task_id: 42, open_pr: 1, branch_has_commits: true }),
      }),
    );
    expect(s).toContain("#42");
    expect(s).toContain("branch has commits");
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
});
