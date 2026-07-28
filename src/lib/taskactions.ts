/**
 * Pure helpers for the task drawer's action buttons and the outcome note the
 * "Notify Claude Main" click leaves behind. Node-import free so both the test
 * suite and the web bundle can use them (same contract as src/lib/board.ts).
 */

/** The minimal task shape the drawer's actions need. Both the daemon and web
 *  `Task` types satisfy it structurally. */
export interface ActionTask {
  status: string;
  dispatch_mode: "direct" | "orchestrated";
  workspace_kind?: "repo" | "portfolio" | "scratch";
}

/**
 * Whether to offer "▶ Spawn Worker".
 *
 * Orchestrated tasks normally wait for Claude main to triage them, but the
 * human outranks the orchestrator: a queued orchestrated task can be spawned
 * straight from the dashboard (POST /api/agents), which is what the button
 * does. Portfolio parents are never spawnable — they exist only to be split
 * into per-repository children.
 *
 * blocked_by is deliberately not consulted: a task waiting on a blocker stays
 * "queued", and the human overriding that (as direct mode has always allowed)
 * is a legitimate call. The triage ping is the thing that must respect the
 * queue order, not a hand-started worker.
 */
export function canSpawnWorker(task: ActionTask): boolean {
  if (task.workspace_kind === "portfolio") return false;
  // Direct-mode tasks may also be spawned once the scheduler has claimed them;
  // an orchestrated task past "queued" is already main's business.
  return task.dispatch_mode === "direct"
    ? ["queued", "claimed"].includes(task.status)
    : task.status === "queued";
}

/** Whether to offer "Notify Claude Main" — only while triage is still owed. */
export function canNotifyMain(task: ActionTask): boolean {
  return task.status === "queued" && task.dispatch_mode === "orchestrated";
}

/** Tone of a delegate outcome: success = arrived, info = accepted for later. */
export type NoteTone = "ok" | "info";

/**
 * Human-readable outcome of POST /api/tasks/:id/delegate, matched to the
 * response's `status`. A queued ping is a success for the click but NOT a
 * delivery, so it reads as information rather than confirmation.
 */
export function delegateOutcomeNote(status: string | undefined): {
  tone: NoteTone;
  message: string;
} {
  switch (status) {
    case "queued":
      return {
        tone: "info",
        message:
          "Claude Main's prompt is busy — the triage ping is queued and will be delivered as soon as its composer is clear.",
      };
    case "already_queued":
      return {
        tone: "info",
        message:
          "A triage ping for this task is already queued for Claude Main; it will be delivered as soon as its composer is clear.",
      };
    default:
      return { tone: "ok", message: "Sent to Claude Main." };
  }
}
