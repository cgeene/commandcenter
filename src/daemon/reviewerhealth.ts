import type { Agent } from "../db/agents.js";
import { countAgentEvents, latestAgentEventTs } from "../db/events.js";

/**
 * One definition of "is this reviewer real", shared by everything that keys a
 * decision on a reviewer existing: the cap exemption for its parked worker
 * (capacity.ts), the double-spawn guards (review.ts, spawn.ts), PR-feedback
 * forwarding (prsync.ts), and the watchdog's reviewer reap (scheduler.ts).
 *
 * `reviewerActive` and `reviewerGaveUpAt` are two readings of the SAME
 * signal — the reviewer's current state — so a reviewer can never be both
 * "no verdict coming, replace it" and "still working, don't touch it". The one
 * case they intentionally both decline is a row that has no pane yet: its spawn
 * may still be in flight, so it is not active (it must not block a
 * replacement) but it is not reapable either until the SessionStart timeout
 * relabels it `stalled`.
 *
 * Neither predicate reads the reviewer's HISTORY. A reviewer that stopped
 * without a verdict is already `idle`, so the state check covers it — while
 * keying on the past would permanently condemn a reviewer a human typed back
 * to life, and letting a duplicate spawn onto a task whose reviewer is
 * genuinely working corrupts the review worktree they would share.
 *
 * This lives in its own module because spawn.ts needs it and review.ts imports
 * spawn.ts; putting it in either would close an import cycle.
 */

/** Reviewer states that mean no verdict is coming from this agent any more.
 *  `idle` is the zombie case: a reviewer whose turn ended without submitting is
 *  deliberately left alive for the human to inspect (hooks.reviewerStopped).
 *  `stalled` is the silence detector's verdict on the same thing. */
const STOPPED_STATES = new Set(["idle", "stalled", "dead"]);

/** The events a reviewer logs by submitting. Same set hooks.reviewerStopped
 *  checks to decide whether a stopping reviewer did its job. */
const VERDICT_EVENTS = [
  "review.approved",
  "review.rejected",
  "review.verdict_stale",
];

/**
 * Is this reviewer still going to land a verdict? Being "live" is not enough:
 * `listAgents({live: true})` only means `state != 'dead'`, and both a reviewer
 * that stopped without submitting and a reviewer whose spawn threw before it
 * got a pane stay live indefinitely. Callers need positive evidence, so
 * anything unclear here reads as "no verdict coming".
 */
export function reviewerActive(reviewer: Agent): boolean {
  // No pane: spawn threw between createAgent and attach, so no process exists.
  if (!reviewer.tmux_target) return false;
  return !STOPPED_STATES.has(reviewer.state);
}

/**
 * When did this reviewer stop being able to produce a verdict? Returns null
 * while it is still going, so this doubles as "is it reapable", plus the
 * timestamp its grace period is measured from.
 *
 * A reviewer whose spawn never reached a pane is covered by `stalled`: the
 * watchdog's SessionStart timeout moves it there a minute or two in, and its
 * `agent.session_start_missing` marker is the anchor. The vanished-agent pass
 * deliberately does not claim those rows — a paneless agent is "did not
 * initialize", which that pass would report as a window that disappeared.
 */
export function reviewerGaveUpAt(reviewer: Agent): string | null {
  if (!STOPPED_STATES.has(reviewer.state)) return null;
  return (
    latestAgentEventTs(reviewer.id, [
      "reviewer.stopped_incomplete",
      "agent.stalled",
      "agent.session_start_missing",
    ]) ??
    reviewer.last_event_at ??
    reviewer.spawned_at
  );
}

/**
 * Did this reviewer already deliver a verdict? A reviewer whose session dies
 * after submitting but before its Stop hook fires is never killed by
 * hooks.reviewerStopped, so the watchdog still has to retire it — but it did
 * its job, and calling that a give-up both mislabels it and would spend one of
 * the task's replacement attempts on a round that actually completed.
 */
export function reviewerSubmittedVerdict(reviewer: Agent): boolean {
  return countAgentEvents(reviewer.id, VERDICT_EVENTS) > 0;
}
