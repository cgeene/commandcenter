import type { Agent } from "../db/agents.js";
import { countAgentEvents, latestAgentEventTs } from "../db/events.js";

/**
 * One definition of "is this agent real", shared by everything that keys a
 * decision on an agent existing: the cap exemption for a parked worker
 * (capacity.ts), the double-spawn guards (review.ts, spawn.ts), PR-feedback
 * forwarding (prsync.ts), the watchdog's reviewer reap and false-vanish recovery
 * (scheduler.ts), the "Needs You" queue (attention.ts) and `cc upgrade --main`.
 *
 * Reviewers and the main agent get one predicate each because their states mean
 * different things (see `mainActive`), but both are built on the same evidence
 * and neither may be replaced by a caller's own reading of a row. For main there
 * is also `resolveMain`, since "is there an orchestrator" and "which row is it"
 * are separate questions and both were being answered ad hoc.
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
 * How long a paneless `spawning` main row is treated as a spawn that might
 * still be running. spawnMain is called from two processes — the daemon's API
 * and `cc upgrade --main` — so one can observe the other partway through, and
 * spawning over an in-flight spawn produces exactly the two concurrent
 * orchestrators this predicate exists to prevent. A real spawn crosses the
 * window in well under a second; the margin is for a loaded box. It stays under
 * the watchdog's 90s SessionStart timeout, so a row that never came up becomes
 * retirable either by aging out here or by being relabelled `stalled`.
 */
const MAIN_SPAWN_IN_FLIGHT_MS = 60_000;

/**
 * Is there really an orchestrator behind this main row — the question spawnMain
 * has to answer before refusing to start one, since only one main may run at a
 * time, and before retiring a row it judges empty.
 *
 * Same evidence as `reviewerActive`, but STOPPED_STATES deliberately does NOT
 * apply: `idle` is the orchestrator's normal resting state between turns, which
 * is precisely when the rest of the system wants it (orchestration.ts delegates
 * triage to a `working`/`idle` main, notifqueue delivers only to an `idle` one).
 * Treating `idle` as stopped here would start a second orchestrator on top of a
 * healthy one. `stalled` and `waiting_input` are alive too: the window and its
 * process are still there for a human to attach to.
 *
 * A pane is the ordinary evidence, and the right line to draw because it splits
 * the rows nothing recovers from the rows something does: a main row with a
 * stale target is retired by the watchdog's vanished-agent pass (which is not
 * gated on kind), while a paneless one is invisible to that pass and would
 * otherwise block every later spawn until a human deleted it by hand.
 *
 * But paneless is NOT the same as empty, so two further readings can each keep
 * such a row active — the same two `abandonedSpawnAt` applies to workers:
 *
 *  - a `hook.sessionstart` in its history. A daemon killed in the one statement
 *    between `newWindow` returning and `attachPane` storing the target leaves a
 *    real window no row claims, and its provider handshakes normally anyway:
 *    handleHookEvent resolves the row by agent id and never consults
 *    tmux_target. That session was handed ORCHESTRATOR_PROMPT and is triaging,
 *    so it must be neither retired nor spawned over;
 *  - `spawning` within MAIN_SPAWN_IN_FLIGHT_MS: a spawn that may simply not have
 *    reached attachPane yet.
 *
 * What is left — no pane, no handshake, too old to be in flight — is a row no
 * session ever answered for, and the only kind spawnMain retires.
 */
export function mainActive(main: Agent, nowMs = Date.now()): boolean {
  if (main.state === "dead") return false;
  if (hasAttachedPane(main)) return true;
  if (mainSessionStarted(main)) return true;
  return (
    main.state === "spawning" &&
    nowMs - Date.parse(main.spawned_at) < MAIN_SPAWN_IN_FLIGHT_MS
  );
}

/** Did a provider session ever answer for this row? True of a paneless row only
 *  in the daemon-died-mid-spawn case, where it means a running orchestrator sits
 *  in a window no target points at — which is what the human must be told. */
export function mainSessionStarted(main: Agent): boolean {
  return countAgentEvents(main.id, ["hook.sessionstart"]) > 0;
}

/**
 * WHICH row is the main agent — the companion to `mainActive`'s "is there one at
 * all", and the only way to answer that question. `find(a => a.kind === "main")`
 * is not equivalent: more than one live main row is an ordinary state, because a
 * spawn interrupted before `attachPane` leaves a paneless row that no autonomous
 * pass retires, and a bare search resolves to whichever id happens to be lower.
 * It is `mainActive` that separates that shell from an orchestrator.
 *
 * Ordering matters when two rows are active at once (a paneless spawn in flight
 * or mid-handshake, alongside a running orchestrator):
 *
 *  - a row WITH a pane wins, because a target is what makes a row usable at all
 *    — attaching, delivering into the composer and killing by target all need
 *    one, so preferring a paneless row over a paned one would resolve to the
 *    single row a caller can do nothing with;
 *  - otherwise the newest wins, since spawnMain retires the rows it replaces, so
 *    a lower id is the older attempt.
 */
export function resolveMain(agents: Agent[], nowMs = Date.now()): Agent | undefined {
  const active = agents
    .filter((agent) => agent.kind === "main" && mainActive(agent, nowMs))
    .sort((a, b) => b.id - a.id);
  return active.find((agent) => agent.tmux_target) ?? active[0];
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
