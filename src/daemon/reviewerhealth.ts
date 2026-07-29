import type { Agent } from "../db/agents.js";
import { countAgentEvents, latestAgentEventTs } from "../db/events.js";

/**
 * One definition of "is this agent real", shared by everything that keys a
 * decision on an agent existing: the cap exemption for a parked worker
 * (capacity.ts), the double-spawn guards (review.ts, spawn.ts), PR-feedback
 * forwarding (prsync.ts), and the watchdog's reviewer reap (scheduler.ts).
 *
 * Reviewers and the main agent get one predicate each because their states mean
 * different things (see `mainActive`), but both are built on the same evidence
 * and neither may be replaced by a caller's own reading of a row.
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
 * Did this row's spawn get as far as attaching a pane? `attachPane` records the
 * target, so a row without one was never given a window and no process runs
 * behind it.
 *
 * This is the one piece of evidence no autonomous pass can supply later: the
 * watchdog's vanished-agent pass needs a target to find missing, and
 * deliberately leaves paneless rows to the SessionStart timeout, which only
 * relabels them `stalled`. So a guard that refuses to spawn a replacement while
 * such a row is merely live refuses for as long as the row exists.
 */
function hasAttachedPane(agent: Agent): boolean {
  return Boolean(agent.tmux_target);
}

/**
 * Is this reviewer still going to land a verdict? Being "live" is not enough:
 * `listAgents({live: true})` only means `state != 'dead'`, and both a reviewer
 * that stopped without submitting and a reviewer whose spawn threw before it
 * got a pane stay live indefinitely. Callers need positive evidence, so
 * anything unclear here reads as "no verdict coming".
 */
export function reviewerActive(reviewer: Agent): boolean {
  // No pane: spawn threw between createAgent and attach, so no process exists.
  if (!hasAttachedPane(reviewer)) return false;
  return !STOPPED_STATES.has(reviewer.state);
}

/**
 * Is there really an orchestrator behind this main row — the question spawnMain
 * has to answer before refusing to start one, since only one main may run at a
 * time.
 *
 * Same evidence as `reviewerActive`, but STOPPED_STATES deliberately does NOT
 * apply: `idle` is the orchestrator's normal resting state between turns, which
 * is precisely when the rest of the system wants it (orchestration.ts delegates
 * triage to a `working`/`idle` main, notifqueue delivers only to an `idle` one).
 * Treating `idle` as stopped here would start a second orchestrator on top of a
 * healthy one. `stalled` and `waiting_input` are alive too: the window and its
 * process are still there for a human to attach to, and the error message names
 * the row so they can kill it.
 *
 * That leaves the pane as the whole test. It is the right line to draw because
 * it splits the rows nothing recovers from the rows something does: a main row
 * with a stale target is retired by the watchdog's vanished-agent pass (which
 * is not gated on kind), while a paneless one is invisible to that pass and
 * would otherwise block every later spawn until a human deleted it by hand.
 */
export function mainActive(main: Agent): boolean {
  if (main.state === "dead") return false;
  return hasAttachedPane(main);
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
