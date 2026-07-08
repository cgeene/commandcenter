import { execFile } from "node:child_process";
import { getAgent, listAgents, updateAgent, type Agent } from "../db/agents.js";
import {
  countAgentEvents,
  countTaskEvents,
  latestTaskEventId,
  logEvent,
} from "../db/events.js";
import { getTask, updateTask, type Task } from "../db/tasks.js";
import { getSchedulerConfig } from "../db/settings.js";
import { notify } from "./notify.js";
import { resumeAgent } from "./resume.js";
import { maybeAutoReview } from "./review.js";
import { killAgent } from "./spawn.js";
import { detectTransientApiError } from "./stall.js";
import { sessionTokens } from "./transcript.js";
import { capturePane, windowExists } from "./tmux.js";

export interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  message?: string;
  [key: string]: unknown;
}

const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_VERIFY_NUDGES = 2;
const MAX_AUTO_NUDGES = 2;
const PANE_TAIL_LINES = 60;

/** Consecutive transient-API-error nudges sent per agent, in-memory only —
 *  losing this on daemon restart just means one extra escalation, which is
 *  the safe direction to fail in. */
const autoNudgeCounts = new Map<number, number>();

/** A human or the orchestrator delivered real input — whatever stall streak
 *  was in progress is over. */
export function resetAutoNudgeCount(agentId: number): void {
  autoNudgeCounts.delete(agentId);
}

/** Test-only: agent ids reset to 1 on every fresh in-memory test db, but
 *  this map does not — clear it between tests to avoid cross-test bleed. */
export function __clearAutoNudgeCountsForTests(): void {
  autoNudgeCounts.clear();
}

interface StallCheck {
  nudged: boolean;
  error: string | null;
}

/**
 * Capture the agent's pane and, if it ends on the harness's own transient
 * API-error line, send a silent "please continue" through the same delivery
 * path send_to_worker uses instead of surfacing this as waiting_input. Caps
 * at MAX_AUTO_NUDGES consecutive attempts per agent — beyond that the caller
 * falls through to its normal escalation path, with `error` available to
 * fold into that notification's text.
 */
async function tryAutoNudge(agent: Agent): Promise<StallCheck> {
  if (agent.kind === "main" || !agent.tmux_target || !windowExists(agent.tmux_target)) {
    return { nudged: false, error: null };
  }

  const error = detectTransientApiError(capturePane(agent.tmux_target, PANE_TAIL_LINES));
  if (!error) {
    resetAutoNudgeCount(agent.id);
    return { nudged: false, error: null };
  }

  const count = autoNudgeCounts.get(agent.id) ?? 0;
  if (count >= MAX_AUTO_NUDGES) return { nudged: false, error };

  const outcome = await resumeAgent(agent.id, "please continue");
  if (outcome !== "sent") return { nudged: false, error };

  autoNudgeCounts.set(agent.id, count + 1);
  logEvent("agent.auto_nudged", {
    agentId: agent.id,
    taskId: agent.task_id ?? undefined,
    payload: { error, attempt: count + 1 },
  });
  return { nudged: true, error };
}

function now(): string {
  return new Date().toISOString();
}

function getEscalateMinutes(): number {
  return getSchedulerConfig().escalate_minutes;
}

/**
 * Claude Code hook events are the platform's source of truth for agent state:
 * SessionStart registers the session, Notification means the agent is waiting
 * on a human, Stop means the turn ended — for a worker with an in-progress
 * task, that's the "I think I'm done" signal that triggers verification.
 */
export async function handleHookEvent(
  agentId: number,
  body: HookPayload,
): Promise<void> {
  const agent = getAgent(agentId);
  if (!agent || agent.state === "dead") return;

  const event = body.hook_event_name ?? "unknown";
  updateAgent(agentId, {
    last_event_at: now(),
    ...(body.session_id ? { session_id: body.session_id } : {}),
  });
  logEvent(`hook.${event.toLowerCase()}`, {
    agentId,
    taskId: agent.task_id ?? undefined,
    payload: body.message ? { message: body.message } : undefined,
  });

  switch (event) {
    case "SessionStart":
      if (agent.state === "spawning") updateAgent(agentId, { state: "working" });
      // Worker sessions only — a reviewer shares the task_id, and recording
      // its session here would make the next respawn `--resume` the
      // adversarial reviewer's conversation instead of the worker's.
      if (agent.kind === "worker" && agent.task_id && body.session_id) {
        updateTask(agent.task_id, { session_id: body.session_id });
      }
      break;

    case "Notification": {
      const msg = body.message ?? "waiting for input";
      const who = `a${agentId}${agent.task_id ? ` (task #${agent.task_id})` : ""}`;

      // The main agent asking for input IS the escalation — page the human.
      if (agent.kind === "main") {
        updateAgent(agentId, { state: "waiting_input" });
        notify(`${who} needs input`, msg, { priority: "high", tags: "warning" });
        break;
      }

      const wasAlreadyWaiting = agent.state === "waiting_input";
      let stallError: string | null = null;
      if (!wasAlreadyWaiting) {
        const stall = await tryAutoNudge(agent);
        // Recovered on its own — never mark waiting_input or start the
        // escalation timer for this occurrence.
        if (stall.nudged) break;
        stallError = stall.error;
      }

      updateAgent(agentId, { state: "waiting_input" });
      // Repeat notification for the same wait: already delegated or paged.
      if (wasAlreadyWaiting) break;

      const fullMsg = stallError
        ? `${msg}\n\n(auto-recovery gave up after ${MAX_AUTO_NUDGES} attempts — last seen: ${stallError})`
        : msg;

      // First try the main agent. Only a main that is working/idle — text
      // injected into a main sitting on its own permission menu would be
      // interpreted as an answer to that menu.
      const main = listAgents({ live: true }).find(
        (a) =>
          a.kind === "main" &&
          ["working", "idle"].includes(a.state) &&
          a.tmux_target !== null &&
          windowExists(a.tmux_target),
      );
      const delegated =
        main &&
        (await resumeAgent(
          main.id,
          `[commandcenter] ${agent.kind} ${who} is waiting for input: "${fullMsg}". peek_worker(${agentId}) to see exactly what it's asking, then try to unblock it yourself via send_to_worker (for a numbered menu send just the digit). Escalate to the human ONLY if it genuinely needs them: credentials, a judgment call that's theirs, or approval for something destructive/outside the worktree. If unresolved after ${getEscalateMinutes()}m the human is paged automatically.`,
        )) === "sent";
      if (delegated) {
        logEvent("waiting.delegated", {
          agentId,
          taskId: agent.task_id ?? undefined,
          payload: { to: main!.id, message: fullMsg },
        });
      } else {
        notify(`${who} needs input`, fullMsg, { priority: "high", tags: "warning" });
      }
      break;
    }

    case "Stop": {
      updateAgent(agentId, { state: "idle" });
      recordTokens(agent, body.session_id);
      if (agent.kind === "reviewer") {
        await reviewerStopped(agent);
        break;
      }
      if (agent.kind !== "worker" || !agent.task_id) break;
      const task = getTask(agent.task_id);
      // "review" is included so a worker moving its own status there via
      // update_my_task cannot bypass the verify gate.
      if (task && ["in_progress", "review"].includes(task.status)) {
        await transitionOnStop(task, agent);
      }
      break;
    }
  }
}

/** Refresh the task's token tally from its worker's transcript. Worker
 *  sessions only — a reviewer shares the task_id and would clobber the
 *  worker's numbers with its own session total. */
function recordTokens(agent: Agent, sessionId?: string): void {
  if (agent.kind !== "worker" || !agent.task_id) return;
  const sid = sessionId ?? agent.session_id;
  if (!sid) return;
  try {
    const t = sessionTokens(sid);
    if (t?.total) updateTask(agent.task_id, { tokens_used: t.total });
  } catch {
    /* transcript unreadable — not worth failing a hook over */
  }
}

/** A reviewer's turn ended. If it submitted a verdict its job is done —
 *  reap the window and its throwaway worktree. If not, check whether a
 *  transient API error stalled it before flagging it for the human — a
 *  zombie reviewer left waiting on an empty prompt otherwise pages someone
 *  for pure Anthropic-side flakiness. */
async function reviewerStopped(agent: Agent): Promise<void> {
  const submitted =
    countAgentEvents(agent.id, ["review.approved", "review.rejected"]) > 0;
  if (submitted) {
    killAgent(agent.id, { rmWorktree: true });
    return;
  }
  const stall = await tryAutoNudge(agent);
  if (stall.nudged) return;

  const prior = countAgentEvents(agent.id, ["reviewer.stopped_incomplete"]);
  logEvent("reviewer.stopped_incomplete", {
    agentId: agent.id,
    taskId: agent.task_id ?? undefined,
  });
  if (prior === 0) {
    notify(
      `reviewer a${agent.id} stopped without a verdict`,
      stall.error
        ? `task #${agent.task_id} — auto-recovery gave up after ${MAX_AUTO_NUDGES} attempts (last seen: ${stall.error}); peek to see why, or kill it and re-spawn a reviewer`
        : `task #${agent.task_id} — peek to see why, or kill it and re-spawn a reviewer`,
      { priority: "high", tags: "warning" },
    );
  }
}

/** Worker finished a turn on an in-progress task: verify, then move to
 *  review — or push the failure back into the worker's session. */
async function transitionOnStop(task: Task, agent: Agent): Promise<void> {
  const wasReview = task.status === "review";

  if (!task.verify_cmd || !task.worktree) {
    if (wasReview) {
      // Worker moved itself to review; nothing mechanical to run.
      maybeAutoReview(task.id);
      return;
    }
    // No verification gate, so the deliverable is the gate: a worker is only
    // done when it set result_summary (or moved the status itself). A Stop
    // without one is a worker pausing/asking — flagging that as "review"
    // pings the human about work that doesn't exist yet.
    const fresh = getTask(task.id);
    if (fresh?.result_summary) {
      resetAutoNudgeCount(agent.id);
      updateTask(task.id, { status: "review" });
      logEvent("task.review", { taskId: task.id, agentId: agent.id });
      notify(
        `task #${task.id} ready for review`,
        fresh.pr_url ? `${task.title}\n${fresh.pr_url}` : task.title,
        { tags: "eyes" },
      );
      maybeAutoReview(task.id);
    } else {
      const stall = await tryAutoNudge(agent);
      if (stall.nudged) return;

      const prior = countTaskEvents(task.id, "task.stopped_incomplete");
      logEvent("task.stopped_incomplete", { taskId: task.id, agentId: agent.id });
      if (prior === 0) {
        notify(
          `a${agent.id} stopped without completing #${task.id}`,
          stall.error
            ? `${task.title} — no result set; auto-recovery gave up after ${MAX_AUTO_NUDGES} attempts (last seen: ${stall.error}); peek, steer, or requeue`
            : `${task.title} — no result set; peek, steer, or requeue`,
          { priority: "high", tags: "warning" },
        );
      }
    }
    return;
  }

  // Already in review AND already verified since work last resumed — an
  // extra Stop, e.g. after the human messaged the idle worker. Nothing to
  // re-run. Every review -> work transition logs a resume marker
  // (task.reopened / task.requeued / agent.spawned), so a pass that predates
  // the latest one never suppresses a re-verify of the new work. Event ids
  // order reliably where same-second timestamps cannot.
  if (wasReview) {
    const pass = latestTaskEventId(task.id, ["verify.passed"]);
    const resumed = latestTaskEventId(task.id, [
      "task.reopened",
      "task.requeued",
      "agent.spawned",
    ]);
    if (pass && (!resumed || pass > resumed)) return;
  }

  const result = await runVerify(task.verify_cmd, task.worktree);

  // Verification can take minutes — if the task was cancelled (or otherwise
  // moved on) while it ran, the stale result must not resurrect it.
  const current = getTask(task.id);
  if (!current || !["in_progress", "review"].includes(current.status)) return;

  if (result.ok) {
    resetAutoNudgeCount(agent.id);
    updateTask(task.id, { status: "review" });
    logEvent("verify.passed", { taskId: task.id, agentId: agent.id });
    notify(
      `task #${task.id} ready for review`,
      `${task.title} — verify passed${current.pr_url ? `\n${current.pr_url}` : ""}`,
      { tags: "eyes,white_check_mark" },
    );
    maybeAutoReview(task.id);
    return;
  }

  const priorFails = countTaskEvents(task.id, "verify.failed");
  logEvent("verify.failed", {
    taskId: task.id,
    agentId: agent.id,
    payload: { output: result.output.slice(-2000) },
  });

  const nudged =
    priorFails < MAX_VERIFY_NUDGES &&
    (await resumeAgent(
      agent.id,
      `Verification failed (\`${task.verify_cmd}\`). Fix the issues and finish the task. Output tail:\n${result.output.slice(-1500)}`,
    )) === "sent";

  if (nudged) {
    if (wasReview) {
      updateTask(task.id, { status: "in_progress" });
      logEvent("task.reopened", {
        taskId: task.id,
        payload: { reason: "verify failed" },
      });
    }
  } else {
    updateTask(task.id, { status: "blocked" });
    logEvent("task.blocked", {
      taskId: task.id,
      agentId: agent.id,
      payload: { reason: "verification failed repeatedly" },
    });
    notify(
      `task #${task.id} blocked`,
      `${task.title} — verification failed repeatedly`,
      { priority: "high", tags: "rotating_light" },
    );
  }
}

function runVerify(
  cmd: string,
  cwd: string,
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      "sh",
      ["-c", cmd],
      { cwd, timeout: VERIFY_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({ ok: !err, output: `${stdout}\n${stderr}`.trim() });
      },
    );
  });
}

