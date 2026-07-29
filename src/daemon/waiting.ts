import { getAgent, updateAgent, type Agent } from "../db/agents.js";
import { latestAgentEvent, logEvent } from "../db/events.js";
import type { Task } from "../db/tasks.js";
import { parsePane } from "./pane.js";
import { capturePane } from "./tmux.js";

/** Hook event kinds that begin a waiting-for-input episode. Keep this shared
 * by hooks, escalation, and Needs You so provider-specific events cannot drift. */
export const WAIT_HOOK_EVENTS = [
  "hook.notification",
  "hook.permissionrequest",
  // Trust/startup prompts appear before provider hooks are available, so the
  // watchdog records the beginning of that wait itself.
  "agent.startup_permission",
] as const;

/**
 * Task statuses in which a WORKER's waiting-for-input ping is moot: "review" is
 * driven by the automatic review⇄fix loop (a rejection resumes or restarts the
 * worker, an approval completes and reaps it), and a done/cancelled task has
 * nothing left to do — its worker is only awaiting the reaper.
 *
 * `blocked` is absent on purpose: that status is a request for attention, not a
 * reason to withhold it. So is `in_progress` — a worker asking a real question
 * mid-work is the entire point of the mechanism.
 *
 * Read only through waitIsMoot, so the status policy and the kind scoping below
 * can never be applied one without the other.
 */
const IDLE_SUPPRESS_STATUSES: readonly string[] = ["review", "done", "cancelled"];

/**
 * True when nobody can usefully act on this agent's `waiting_input`, because its
 * task has moved past the point where an answer to the worker would change
 * anything.
 *
 * Every path that turns a wait into a ping has to ask this, not just the hook
 * that first sees the wait: a task can move into review while a ping already
 * sits in the delivery queue, and an escalation derived from an old wait event
 * outlives the transition entirely.
 *
 * Scoped to `kind === "worker"` deliberately. A REVIEWER's task is "review" by
 * definition, so a status test alone would silence every reviewer wait —
 * including the idle → waiting_input → page path that is the only thing standing
 * between a reviewer that stops without a verdict and a task stuck in review.
 */
export function waitIsMoot(agent: Agent, task: Task | undefined): boolean {
  if (agent.kind !== "worker") return false;
  if (!task) return false;
  return IDLE_SUPPRESS_STATUSES.includes(task.status);
}

const PANE_TAIL_LINES = 60;

/**
 * What put an agent into `waiting_input`.
 *
 * The state is overloaded: every provider Notification sets it and only Stop
 * clears it, so "finished its turn and idled" (Claude's idle_prompt, emitted
 * ~60s after a turn ends) and "sitting on a permission menu" arrive as the same
 * state. The discriminator is recorded in the hook payload's notification_type,
 * which is what this reads back.
 *
 * "unknown" is not "idle": a wait the watchdog re-derived from the pane after a
 * daemon restart has no hook behind it at all, so callers must fail closed.
 */
export type WaitCause = "idle" | "input" | "unknown";

function notificationType(payload: string | null | undefined): string | undefined {
  if (!payload) return undefined;
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const type = (parsed as { notification_type?: unknown }).notification_type;
    return typeof type === "string" ? type : undefined;
  } catch {
    return undefined;
  }
}

export function waitCause(agentId: number): WaitCause {
  const latest = latestAgentEvent(agentId, [
    "hook.notification",
    "hook.permissionrequest",
    "agent.startup_permission",
    "hook.stop",
  ]);
  if (!latest) return "unknown";
  if (latest.kind === "hook.stop") return "idle";
  if (latest.kind !== "hook.notification") return "input";
  return notificationType(latest.payload) === "idle_prompt" ? "idle" : "input";
}

/**
 * True when an agent's `waiting_input` is a finished-turn idle park rather than
 * a question waiting on an answer — i.e. text sent to it reaches the
 * conversation instead of answering a menu.
 *
 * Two independent signals must agree, because either alone can be wrong: the
 * hook history says what the provider reported, and the pane says what is on
 * screen right now (the watchdog can park an agent from a pane read with no
 * hook behind it, and a hook can predate a menu that appeared afterwards).
 *
 * Fails closed in every ambiguous direction — no hook evidence, an unreadable
 * pane, a composer that cannot be located, a permission/question box on screen,
 * or text already typed into the composer — so a caller keeps doing whatever it
 * already does for a real wait.
 */
export function idleParked(agent: Agent): boolean {
  if (agent.state !== "waiting_input") return false;
  if (waitCause(agent.id) !== "idle") return false;
  if (!agent.tmux_target) return false;
  try {
    // `escapes` is load-bearing, not decoration: Claude paints a DIM
    // autosuggestion into an idle composer, and parsePane can only tell that
    // ghost text from a human's real draft while the SGR codes are present (see
    // visibleNonGhost). Capture it unstyled and every idle composer showing a
    // suggestion reads as "a draft is waiting" — which fails this check closed
    // and silently costs the worker the in-place delivery this exists for.
    const pane = parsePane(
      capturePane(agent.tmux_target, PANE_TAIL_LINES, { escapes: true }),
      agent.provider,
    );
    if (!pane.composer_found) return false;
    return (
      !pane.pending_permission && !pane.pending_question && !pane.unsubmitted_input
    );
  } catch {
    return false;
  }
}

/**
 * Correct an agent whose `waiting_input` is a finished-turn idle park rather
 * than a real question, so unsolicited text (rejection notes, PR feedback) can
 * be delivered into its live session instead of costing it its worker.
 *
 * resumeAgent refuses any waiting_input agent by design — unsolicited text
 * typed into a pending permission menu is read as an answer to that menu — and
 * that guard must stay in place for every caller. What is fixed here is the
 * overloaded STATE: idleParked requires both the hook history and the pane to
 * agree that nothing is being asked, and anything ambiguous leaves the state
 * alone, so a genuine menu still takes whatever undelivered path the caller has.
 */
export function clearIdleWait(agentId: number): void {
  const agent = getAgent(agentId);
  if (!agent || !idleParked(agent)) return;
  updateAgent(agentId, { state: "idle" });
  logEvent("agent.idle_wait_cleared", {
    agentId,
    taskId: agent.task_id ?? undefined,
  });
}
