import fs from "node:fs";
import path from "node:path";
import { claudeBin, promptsDir } from "../config.js";
import { createAgent, getAgent, updateAgent, type Agent } from "../db/agents.js";
import { logEvent } from "../db/events.js";
import { claimTask, getTask, updateTask, type Task } from "../db/tasks.js";
import { killWindow, newWindow, windowExists } from "./tmux.js";
import { createWorktree, removeWorktree } from "./worktree.js";

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

function buildPrompt(task: Task, branch: string): string {
  const lines = [
    task.prompt,
    "",
    "---",
    `You are worker agent for task #${task.id} ("${task.title}") on the commandcenter platform.`,
    `You are in a dedicated git worktree on branch \`${branch}\`; the main checkout is untouched.`,
    "Commit your work to this branch with conventional commit messages as you go.",
  ];
  if (task.verify_cmd) {
    lines.push(
      `Before considering the task complete, verify with: \`${task.verify_cmd}\` and make it pass.`,
    );
  }
  lines.push(
    "When you are done, stop and summarize what you did and how you verified it.",
  );
  return lines.join("\n");
}

export function spawnWorker(
  taskId: number,
  modelOverride?: string,
): { agent: Agent; task: Task } {
  const task = getTask(taskId);
  if (!task) throw new Error(`task ${taskId} not found`);

  if (task.status === "queued") {
    if (!claimTask(taskId)) throw new Error(`task ${taskId} claim lost`);
  } else if (task.status !== "claimed") {
    throw new Error(
      `task ${taskId} is ${task.status}; only queued/claimed tasks can be spawned`,
    );
  }
  if (task.agent_id) {
    const existing = getAgent(task.agent_id);
    if (existing && existing.state !== "dead") {
      throw new Error(
        `task ${taskId} already has live agent ${existing.id} (${existing.state})`,
      );
    }
  }

  const model = modelOverride ?? task.model ?? undefined;
  const { dir, branch } = createWorktree(task.repo, taskId);

  fs.mkdirSync(promptsDir(), { recursive: true });
  const promptFile = path.join(promptsDir(), `task-${taskId}.md`);
  fs.writeFileSync(promptFile, buildPrompt(task, branch));

  const cmd = [
    shellQuote(claudeBin()),
    ...(model ? ["--model", shellQuote(model)] : []),
    "--permission-mode",
    "acceptEdits",
    `"$(cat ${shellQuote(promptFile)})"`,
  ].join(" ");

  const target = newWindow(`t${taskId}`, dir, cmd);
  const agent = createAgent({
    kind: "worker",
    model: model ?? null!,
    state: "working",
    task_id: taskId,
    tmux_target: target,
  });
  updateTask(taskId, {
    status: "in_progress",
    agent_id: agent.id,
    worktree: dir,
    branch,
    model: model ?? task.model,
  });
  logEvent("agent.spawned", {
    agentId: agent.id,
    taskId,
    payload: { target, model, worktree: dir },
  });
  return { agent: getAgent(agent.id)!, task: getTask(taskId)! };
}

export function killAgent(
  agentId: number,
  opts?: { requeue?: boolean; rmWorktree?: boolean },
): Agent {
  const agent = getAgent(agentId);
  if (!agent) throw new Error(`agent ${agentId} not found`);
  if (agent.state === "dead") return agent;

  if (agent.tmux_target && windowExists(agent.tmux_target)) {
    killWindow(agent.tmux_target);
  }
  updateAgent(agentId, { state: "dead" });

  const task = agent.task_id ? getTask(agent.task_id) : undefined;
  if (task) {
    if (opts?.rmWorktree && task.worktree) {
      removeWorktree(task.repo, task.worktree);
      updateTask(task.id, { worktree: null });
    }
    if (opts?.requeue) {
      updateTask(task.id, { status: "queued", agent_id: null });
    }
  }
  logEvent("agent.killed", {
    agentId,
    taskId: agent.task_id ?? undefined,
    payload: opts,
  });
  return getAgent(agentId)!;
}
