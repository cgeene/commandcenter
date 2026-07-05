import { getAgent, updateAgent } from "../db/agents.js";
import { logEvent } from "../db/events.js";
import { sendText, windowExists } from "./tmux.js";

export type ResumeOutcome = "sent" | "not_live" | "waiting_input";

/**
 * The one way to inject text into an agent's interactive session.
 *
 * Owns the whole resume transition so call sites can't drift:
 * - liveness check (not dead, window still exists);
 * - the waiting_input guard — text typed into a pending permission menu is
 *   interpreted as an answer to that menu, so unsolicited messages (PR
 *   feedback, reviewer notes) are refused; callers pass `interrupt` only
 *   when the text IS the answer to what the agent asked;
 * - send-before-commit ordering: nothing is persisted until the text is in
 *   the pane, so a failed send reports "not_live" and the caller can fall
 *   back (requeue, retry next pass) instead of losing the message;
 * - the state flip. No Claude Code hook fires when a resumed session picks
 *   work back up — Notification is the only thing that sets waiting_input
 *   and only Stop clears it — so delivered input is the one signal that the
 *   agent is working again. last_event_at is bumped so the stall watchdog
 *   doesn't count the silence before the resume against the fresh turn.
 */
export async function resumeAgent(
  agentId: number,
  text: string,
  opts?: { interrupt?: boolean },
): Promise<ResumeOutcome> {
  const agent = getAgent(agentId);
  if (
    !agent ||
    agent.state === "dead" ||
    !agent.tmux_target ||
    !windowExists(agent.tmux_target)
  ) {
    return "not_live";
  }
  if (agent.state === "waiting_input" && !opts?.interrupt) return "waiting_input";

  try {
    await sendText(agent.tmux_target, text);
  } catch (err) {
    // window died between the check and the send
    logEvent("agent.send_failed", {
      agentId,
      taskId: agent.task_id ?? undefined,
      payload: { error: err instanceof Error ? err.message : String(err) },
    });
    return "not_live";
  }

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
