import { execFile } from "node:child_process";
import { getAgent, listAgents, updateAgent, type Agent } from "../db/agents.js";
import { countAgentEvents, countTaskEvents, logEvent } from "../db/events.js";
import { getTask, updateTask, type Task } from "../db/tasks.js";
import { getSchedulerConfig } from "../db/settings.js";
import { notify } from "./notify.js";
import { maybeAutoReview } from "./review.js";
import { killAgent } from "./spawn.js";
import { sessionTokens } from "./transcript.js";
import { sendText, windowExists } from "./tmux.js";

export interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  message?: string;
  [key: string]: unknown;
}

const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_VERIFY_NUDGES = 2;

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
      if (agent.task_id && body.session_id) {
        updateTask(agent.task_id, { session_id: body.session_id });
      }
      break;

    case "Notification": {
      const wasAlreadyWaiting = agent.state === "waiting_input";
      updateAgent(agentId, { state: "waiting_input" });
      const msg = body.message ?? "waiting for input";
      const who = `a${agentId}${agent.task_id ? ` (task #${agent.task_id})` : ""}`;

      // The main agent asking for input IS the escalation — page the human.
      if (agent.kind === "main") {
        notify(`${who} needs input`, msg, { priority: "high", tags: "warning" });
        break;
      }
      // Repeat notification for the same wait: already delegated or paged.
      if (wasAlreadyWaiting) break;

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
      if (main) {
        logEvent("waiting.delegated", {
          agentId,
          taskId: agent.task_id ?? undefined,
          payload: { to: main.id, message: msg },
        });
        await sendText(
          main.tmux_target!,
          `[commandcenter] ${agent.kind} ${who} is waiting for input: "${msg}". peek_worker(${agentId}) to see exactly what it's asking, then try to unblock it yourself via send_to_worker (for a numbered menu send just the digit). Escalate to the human ONLY if it genuinely needs them: credentials, a judgment call that's theirs, or approval for something destructive/outside the worktree. If unresolved after ${getEscalateMinutes()}m the human is paged automatically.`,
        );
      } else {
        notify(`${who} needs input`, msg, { priority: "high", tags: "warning" });
      }
      break;
    }

    case "Stop": {
      updateAgent(agentId, { state: "idle" });
      recordTokens(agent, body.session_id);
      if (agent.kind === "reviewer") {
        reviewerStopped(agent);
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
 *  reap the window and its throwaway worktree. If not, it lost the thread:
 *  flag it for the human instead of leaving a zombie reviewer around. */
function reviewerStopped(agent: Agent): void {
  const submitted =
    countAgentEvents(agent.id, ["review.approved", "review.rejected"]) > 0;
  if (submitted) {
    killAgent(agent.id, { rmWorktree: true });
    return;
  }
  const prior = countAgentEvents(agent.id, ["reviewer.stopped_incomplete"]);
  logEvent("reviewer.stopped_incomplete", {
    agentId: agent.id,
    taskId: agent.task_id ?? undefined,
  });
  if (prior === 0) {
    notify(
      `reviewer a${agent.id} stopped without a verdict`,
      `task #${agent.task_id} — peek to see why, or kill it and re-spawn a reviewer`,
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
      updateTask(task.id, { status: "review" });
      logEvent("task.review", { taskId: task.id, agentId: agent.id });
      notify(
        `task #${task.id} ready for review`,
        fresh.pr_url ? `${task.title}\n${fresh.pr_url}` : task.title,
        { tags: "eyes" },
      );
      maybeAutoReview(task.id);
    } else {
      const prior = countTaskEvents(task.id, "task.stopped_incomplete");
      logEvent("task.stopped_incomplete", { taskId: task.id, agentId: agent.id });
      if (prior === 0) {
        notify(
          `a${agent.id} stopped without completing #${task.id}`,
          `${task.title} — no result set; peek, steer, or requeue`,
          { priority: "high", tags: "warning" },
        );
      }
    }
    return;
  }

  // Already in review AND already verified this cycle (each rejection cycle
  // demands one fresh verify.passed) — an extra Stop, e.g. after the human
  // messaged the idle worker. Nothing to re-run.
  if (wasReview && countTaskEvents(task.id, "verify.passed") > task.review_cycles) {
    return;
  }

  const result = await runVerify(task.verify_cmd, task.worktree);

  // Verification can take minutes — if the task was cancelled (or otherwise
  // moved on) while it ran, the stale result must not resurrect it.
  const current = getTask(task.id);
  if (!current || !["in_progress", "review"].includes(current.status)) return;

  if (result.ok) {
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

  const canNudge =
    priorFails < MAX_VERIFY_NUDGES &&
    agent.tmux_target !== null &&
    windowExists(agent.tmux_target);

  if (canNudge) {
    if (wasReview) updateTask(task.id, { status: "in_progress" });
    updateAgent(agent.id, { state: "working" });
    await sendText(
      agent.tmux_target!,
      `Verification failed (\`${task.verify_cmd}\`). Fix the issues and finish the task. Output tail:\n${result.output.slice(-1500)}`,
    );
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

