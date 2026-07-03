import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeBin, promptsDir } from "../config.js";
import {
  createAgent,
  getAgent,
  listAgents,
  updateAgent,
  type Agent,
} from "../db/agents.js";
import { logEvent } from "../db/events.js";
import { memorySectionFor } from "../db/memories.js";
import { claimTask, getTask, updateTask, type Task } from "../db/tasks.js";
import { ORCHESTRATOR_PROMPT } from "../prompts/orchestrator.js";
import { writeMcpConfigFile, writeSettingsFile } from "./genconfig.js";
import { killWindow, newWindow, windowExists } from "./tmux.js";
import { createWorktree, removeWorktree } from "./worktree.js";

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

function buildWorkerPrompt(task: Task, branch: string): string {
  const lines = [
    task.prompt,
    "",
    "---",
    `You are a worker agent for task #${task.id} ("${task.title}") on the commandcenter platform.`,
    `You are in a dedicated git worktree on branch \`${branch}\`; the main checkout is untouched.`,
    "Commit your work to this branch with conventional commit messages as you go.",
    "You have the \"cc\" MCP tools: update_my_task (set result_summary, or status blocked/review), report_blocked if you cannot proceed, add_task to file follow-up work you notice but shouldn't do now.",
    "Memory: recall(query) searches lessons from past work; remember(text, tags) stores durable ones. If you hit a repo quirk, build gotcha, or workflow insight that would help future workers, remember it (one fact per call).",
  ];
  if (task.verify_cmd) {
    lines.push(
      `Before finishing, verify with: \`${task.verify_cmd}\` and make it pass. The platform re-runs this after you stop.`,
    );
  }
  lines.push(
    "When done: set result_summary via update_my_task with a short summary of what you did and how you verified it, then stop.",
  );
  const memories = memorySectionFor(`${task.title} ${task.prompt} ${task.repo}`);
  if (memories) lines.push(memories);
  return lines.join("\n");
}

function buildClaudeCmd(opts: {
  model?: string;
  settingsFile: string;
  mcpFile: string;
  promptFile: string;
}): string {
  // The prompt positional MUST come before the flags: --mcp-config is
  // variadic (space-separated configs), so a trailing positional gets
  // swallowed as a "config file" and claude dies with ENAMETOOLONG.
  return [
    shellQuote(claudeBin()),
    `"$(cat ${shellQuote(opts.promptFile)})"`,
    ...(opts.model ? ["--model", shellQuote(opts.model)] : []),
    "--permission-mode",
    "acceptEdits",
    "--settings",
    shellQuote(opts.settingsFile),
    "--mcp-config",
    shellQuote(opts.mcpFile),
  ].join(" ");
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

  // Agent row first: its id is baked into the generated hook + MCP configs.
  const agent = createAgent({
    kind: "worker",
    model,
    state: "spawning",
    task_id: taskId,
  });

  const tag = `task-${taskId}`;
  const settingsFile = writeSettingsFile(tag, agent.id);
  const mcpFile = writeMcpConfigFile(tag, {
    CC_ROLE: "worker",
    CC_AGENT_ID: String(agent.id),
    CC_TASK_ID: String(taskId),
  });

  fs.mkdirSync(promptsDir(), { recursive: true });
  const promptFile = path.join(promptsDir(), `${tag}.md`);
  fs.writeFileSync(promptFile, buildWorkerPrompt(task, branch));

  const target = newWindow(
    `t${taskId}`,
    dir,
    buildClaudeCmd({ model, settingsFile, mcpFile, promptFile }),
  );
  updateAgent(agent.id, { tmux_target: target, state: "working" });
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

export function spawnMain(model?: string): Agent {
  const existing = listAgents({ live: true }).find((a) => a.kind === "main");
  if (existing) {
    throw new Error(
      `main agent a${existing.id} already live (${existing.state}) — attach or kill it first`,
    );
  }

  const resolvedModel = model ?? process.env.CC_MAIN_MODEL ?? "opus";
  const agent = createAgent({
    kind: "main",
    model: resolvedModel,
    state: "spawning",
  });

  const settingsFile = writeSettingsFile("main", agent.id);
  const mcpFile = writeMcpConfigFile("main", {
    CC_ROLE: "main",
    CC_AGENT_ID: String(agent.id),
  });

  fs.mkdirSync(promptsDir(), { recursive: true });
  const promptFile = path.join(promptsDir(), "main.md");
  fs.writeFileSync(promptFile, ORCHESTRATOR_PROMPT);

  const target = newWindow(
    "main",
    os.homedir(),
    buildClaudeCmd({ model: resolvedModel, settingsFile, mcpFile, promptFile }),
  );
  updateAgent(agent.id, { tmux_target: target, state: "working" });
  logEvent("agent.spawned", {
    agentId: agent.id,
    payload: { target, model: resolvedModel, kind: "main" },
  });
  return getAgent(agent.id)!;
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
