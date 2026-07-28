import { getAgent, updateAgent } from "../db/agents.js";
import { logEvent } from "../db/events.js";
import { sendEnter, sendText } from "./tmux.js";
import type { TmuxFailureCode } from "./tmux.js";

export type ResumeOutcome =
  | "sent"
  | "not_live"
  | "waiting_input"
  | "deferred"
  | "delivery_failed";

/**
 * Last-moment checks around the keystrokes themselves, for callers that must
 * not disturb whatever is already in the pane.
 *
 * Reading the pane and typing into it are two separate tmux round trips, so a
 * caller that checks "is this composer empty?" and then calls resumeAgent has
 * left a window in which a human keystroke can land. These hooks close it:
 * `beforeType` runs immediately before the send-keys, after every other check
 * resumeAgent makes, and `beforeSubmit` runs once the text is in the pane but
 * before Enter. Either returning false yields the "deferred" outcome — with
 * `beforeType` nothing was typed at all, and with `beforeSubmit` the text is
 * left in the composer unsent rather than being submitted on top of a draft.
 */
export interface SendGuard {
  beforeType?: () => boolean;
  beforeSubmit?: () => boolean;
}

function deliveryFailureReason(error: unknown): TmuxFailureCode {
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  return [
    "timeout",
    "session_absent",
    "target_missing",
    "no_client",
    "failed",
  ].includes(String(code))
    ? (code as TmuxFailureCode)
    : "failed";
}

function failedDeliveryOutcome(error: unknown): ResumeOutcome {
  const reason = deliveryFailureReason(error);
  return reason === "session_absent" || reason === "target_missing"
    ? "not_live"
    : "delivery_failed";
}

/**
 * The one way to inject text into an agent's interactive session.
 *
 * Owns the whole resume transition so call sites can't drift:
 * - liveness check (not dead, target recorded). The bounded send itself is
 *   the authoritative window check; a separate synchronous preflight can
 *   race and can misclassify an observation timeout as a vanished worker;
 * - the waiting_input guard — text typed into a pending permission menu is
 *   interpreted as an answer to that menu, so unsolicited messages (PR
 *   feedback, reviewer notes) are refused; callers pass `interrupt` only
 *   when the text IS the answer to what the agent asked;
 * - send-before-commit ordering: nothing is persisted until the text is in
 *   the pane, so a failed send reports either a vanished target or a
 *   controlled delivery failure instead of losing the message;
 * - the state flip. No provider hook fires when a resumed session picks
 *   work back up — Notification is the only thing that sets waiting_input
 *   and only Stop clears it — so delivered input is the one signal that the
 *   agent is working again. last_event_at is bumped so the stall watchdog
 *   doesn't count the silence before the resume against the fresh turn.
 */
export async function resumeAgent(
  agentId: number,
  text: string,
  opts?: { interrupt?: boolean; guard?: SendGuard },
): Promise<ResumeOutcome> {
  const agent = getAgent(agentId);
  if (
    !agent ||
    agent.state === "dead" ||
    !agent.tmux_target
  ) {
    return "not_live";
  }
  if (agent.state === "waiting_input" && !opts?.interrupt) return "waiting_input";
  // Deliberately the last thing before the keystrokes, so a guard sees the pane
  // as close to "now" as tmux allows.
  if (opts?.guard?.beforeType && !opts.guard.beforeType()) return "deferred";

  const beforeSubmit = opts?.guard?.beforeSubmit;
  let submitted: boolean;
  try {
    submitted = beforeSubmit
      ? await sendText(agent.tmux_target, text, { beforeSubmit })
      : await sendText(agent.tmux_target, text);
  } catch (err) {
    const reason = deliveryFailureReason(err);
    logEvent("agent.send_failed", {
      agentId,
      taskId: agent.task_id ?? undefined,
      payload: { reason },
    });
    return failedDeliveryOutcome(err);
  }

  // Typed but held back by beforeSubmit: the text sits in the composer unsent,
  // so nothing was delivered and no state transition has happened.
  if (submitted === false) return "deferred";

  // Re-read: sendText awaits ≥300ms and hooks share the event loop, so a
  // Stop/Notification/kill may have landed since the snapshot. Never
  // resurrect a dead agent, and never mask a wait that started in flight.
  const fresh = getAgent(agentId);
  if (!fresh || fresh.state === "dead") return "sent";
  if (fresh.state === "waiting_input" && agent.state !== "waiting_input") {
    return "sent";
  }
  updateAgent(agentId, {
    state: "working",
    last_event_at: new Date().toISOString(),
  });
  return "sent";
}

/**
 * Submit whatever text is already sitting in the agent's input line, without
 * retyping it — the "submit it" action on an unsubmitted-input banner. Just
 * presses Enter; sendText's literal-text + Enter dance would duplicate the
 * text that's already there.
 */
export async function submitPending(agentId: number): Promise<ResumeOutcome> {
  const agent = getAgent(agentId);
  if (
    !agent ||
    agent.state === "dead" ||
    !agent.tmux_target
  ) {
    return "not_live";
  }

  try {
    await sendEnter(agent.tmux_target);
  } catch (err) {
    const reason = deliveryFailureReason(err);
    logEvent("agent.send_failed", {
      agentId,
      taskId: agent.task_id ?? undefined,
      payload: { reason },
    });
    return failedDeliveryOutcome(err);
  }

  const fresh = getAgent(agentId);
  if (!fresh || fresh.state === "dead") return "sent";
  updateAgent(agentId, {
    state: "working",
    last_event_at: new Date().toISOString(),
  });
  return "sent";
}
