import type { Agent } from "../db/agents.js";
import { countAgentEvents, latestAgentEventTs } from "../db/events.js";

/**
 * One definition of "is this reviewer real", shared by everything that keys a
 * decision on a reviewer existing: the cap exemption for its parked worker
 * (capacity.ts), the double-spawn guards (review.ts, spawn.ts), and the
 * watchdog's reviewer reap (scheduler.ts). They must never disagree — a
 * reviewer that counts as live for the spawn guard but dead for the accounting
 * is exactly the state that wedges a task.
 *
 * It lives in its own module because spawn.ts needs it and review.ts imports
 * spawn.ts; putting it in either would close an import cycle.
 */

/** Reviewer states that mean no verdict is coming from this agent any more.
 *  `idle` is the zombie case: a reviewer whose turn ended without submitting is
 *  deliberately left alive for the human to inspect (hooks.reviewerStopped).
 *  `stalled` is the silence detector's verdict on the same thing. */
const STOPPED_STATES = new Set(["idle", "stalled", "dead"]);

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
  if (STOPPED_STATES.has(reviewer.state)) return false;
  // Its turn ended without a verdict at least once (hooks.reviewerStopped).
  // Auto-nudge recovery is already exhausted by then; the human has been paged.
  return countAgentEvents(reviewer.id, ["reviewer.stopped_incomplete"]) === 0;
}

/**
 * When did this reviewer stop being able to produce a verdict? Returns null
 * while it is still going, so this doubles as "is it reapable", plus the
 * timestamp its grace period is measured from.
 *
 * Keyed on the CURRENT state, not on the history `reviewerActive` also reads:
 * a reviewer that stopped without a verdict and was then typed back to life by
 * hand is working again, and reaping it would throw away the rescue. The events
 * below only supply the anchor.
 *
 * A reviewer whose spawn never reached a pane is covered by `stalled`: the
 * watchdog's SessionStart timeout moves it there within 90s and its
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
