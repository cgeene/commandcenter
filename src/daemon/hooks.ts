import { execFile } from "node:child_process";
import { getAgent, updateAgent, type Agent } from "../db/agents.js";
import { getDb } from "../db/db.js";
import { logEvent } from "../db/events.js";
import { getTask, updateTask, type Task } from "../db/tasks.js";
import { notify } from "./notify.js";
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

    case "Notification":
      updateAgent(agentId, { state: "waiting_input" });
      notify(
        `a${agentId}${agent.task_id ? ` (task #${agent.task_id})` : ""} needs input`,
        body.message ?? "waiting for input",
        { priority: "high", tags: "warning" },
      );
      break;

    case "Stop": {
      updateAgent(agentId, { state: "idle" });
      if (agent.kind !== "worker" || !agent.task_id) break;
      const task = getTask(agent.task_id);
      if (task && task.status === "in_progress") {
        await transitionOnStop(task, agent);
      }
      break;
    }
  }
}

/** Worker finished a turn on an in-progress task: verify, then move to
 *  review — or push the failure back into the worker's session. */
async function transitionOnStop(task: Task, agent: Agent): Promise<void> {
  if (!task.verify_cmd || !task.worktree) {
    updateTask(task.id, { status: "review" });
    logEvent("task.review", { taskId: task.id, agentId: agent.id });
    notify(`task #${task.id} ready for review`, task.title, { tags: "eyes" });
    return;
  }

  const result = await runVerify(task.verify_cmd, task.worktree);
  if (result.ok) {
    updateTask(task.id, { status: "review" });
    logEvent("verify.passed", { taskId: task.id, agentId: agent.id });
    notify(`task #${task.id} ready for review`, `${task.title} — verify passed`, {
      tags: "eyes,white_check_mark",
    });
    return;
  }

  const priorFails = countEvents(task.id, "verify.failed");
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

function countEvents(taskId: number, kind: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = ?")
    .get(taskId, kind) as { n: number };
  return row.n;
}
