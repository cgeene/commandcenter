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
import {
  claimTask,
  getTask,
  openDependents,
  updateTask,
  type Task,
} from "../db/tasks.js";
import { ORCHESTRATOR_PROMPT } from "../prompts/orchestrator.js";
import { buildReviewerPrompt } from "../prompts/reviewer.js";
import { writeMcpConfigFile, writeSettingsFile } from "./genconfig.js";
import { findTranscript } from "./transcript.js";
import { killWindow, newWindow, windowExists } from "./tmux.js";
import {
  createReviewWorktree,
  createWorktree,
  removeWorktree,
  reviewWorktreeDir,
} from "./worktree.js";

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
    "Scope: work ONLY inside this worktree. If you discover the task's real work belongs in a DIFFERENT repo, do not edit that repo — call report_blocked naming the correct repo path so the task can be re-dispatched there with proper isolation.",
    "Your task counts as complete only once you set result_summary. Stopping without it flags the task as incomplete, not done.",
  ];
  if (task.review_cycles > 0 && task.review_notes) {
    lines.push(
      "",
      "## Review feedback on the previous attempt",
      "An independent reviewer REJECTED the previous attempt at this task (the branch already contains that work). Address every point below before finishing:",
      task.review_notes,
    );
  }
  if (task.verify_cmd) {
    lines.push(
      `Before finishing, verify with: \`${task.verify_cmd}\` and make it pass. The platform re-runs this after you stop.`,
    );
  }
  lines.push(
    `When done and you have commits: push your branch (\`git push -u origin ${branch}\`) and open a PR with \`gh pr create\` against the repo's default branch — title in conventional-commit style, body covering what/why/how you verified, ending with "commandcenter task #${task.id}". The human reviews PRs in GitHub, not transcripts. Never push any other branch, never merge, never touch an existing PR that isn't yours. If the repo has no GitHub remote, the push fails, or you made no commits, skip the PR and say so in result_summary.`,
    "When done: set result_summary via update_my_task with a short summary of what you did and how you verified it (include pr_url if you opened a PR), then stop.",
  );
  const memories = memorySectionFor(`${task.title} ${task.prompt}`, 5, {
    taskId: task.id,
    repo: task.repo,
  });
  if (memories) lines.push(memories);
  return lines.join("\n");
}

/** Short continuation message for `claude --resume` — the resumed session
 *  already holds the full task context; don't repeat it, just re-anchor. */
function buildResumePrompt(task: Task): string {
  const lines = [
    `You are being resumed on task #${task.id} ("${task.title}") — your previous session ended before the task was finished, or the task came back to you.`,
    "Check where you left off (`git status` / `git log` in this worktree), then finish the task.",
  ];
  if (task.review_notes) {
    lines.push(
      "",
      "## Outstanding feedback to address first",
      task.review_notes,
    );
  }
  lines.push(
    "",
    "Everything from your original instructions still applies: verify your work, push your branch and open/update the PR if you have commits, then set result_summary via update_my_task and stop.",
  );
  return lines.join("\n");
}

/** Test-only exports: prompt construction is behavior worth pinning. */
export const _buildWorkerPromptForTest = buildWorkerPrompt;
export const _buildResumePromptForTest = buildResumePrompt;

function buildClaudeCmd(opts: {
  model?: string;
  settingsFile: string;
  mcpFile: string;
  promptFile: string;
  resumeSession?: string;
}): string {
  // The prompt positional MUST come before the flags: --mcp-config is
  // variadic (space-separated configs), so a trailing positional gets
  // swallowed as a "config file" and claude dies with ENAMETOOLONG.
  return [
    shellQuote(claudeBin()),
    ...(opts.resumeSession ? ["--resume", shellQuote(opts.resumeSession)] : []),
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
  opts?: { fresh?: boolean },
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
  // Workers may publish their own branch + PR without a permission stall —
  // but only their own branch; anything else still prompts.
  const settingsFile = writeSettingsFile(tag, agent.id, {
    allow: [
      `Bash(git push -u origin ${branch}*)`,
      `Bash(git push origin ${branch}*)`,
      "Bash(gh pr create*)",
      "Bash(gh pr view*)",
    ],
  });
  const mcpFile = writeMcpConfigFile(tag, {
    CC_ROLE: "worker",
    CC_AGENT_ID: String(agent.id),
    CC_TASK_ID: String(taskId),
  });

  // A prior session with a surviving transcript means the worker can pick
  // up exactly where it stopped instead of re-learning the task from zero.
  const resumeSession =
    !opts?.fresh && task.session_id && findTranscript(task.session_id)
      ? task.session_id
      : undefined;

  fs.mkdirSync(promptsDir(), { recursive: true });
  const promptFile = path.join(promptsDir(), `${tag}.md`);
  fs.writeFileSync(
    promptFile,
    resumeSession ? buildResumePrompt(task) : buildWorkerPrompt(task, branch),
  );

  const target = newWindow(
    `t${taskId}`,
    dir,
    buildClaudeCmd({ model, settingsFile, mcpFile, promptFile, resumeSession }),
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
    payload: { target, model, worktree: dir, resumed: Boolean(resumeSession) },
  });
  return { agent: getAgent(agent.id)!, task: getTask(taskId)! };
}

/**
 * Spawn an adversarial reviewer for a task in `review`. Fresh context on
 * purpose — same inputs as the worker, none of its conversation. Own
 * detached worktree so it can run code without touching the worker's tree;
 * file-editing tools denied so it can only judge, not fix.
 */
export function spawnReviewer(
  taskId: number,
  modelOverride?: string,
): { agent: Agent; task: Task } {
  const task = getTask(taskId);
  if (!task) throw new Error(`task ${taskId} not found`);
  if (task.status !== "review") {
    throw new Error(`task ${taskId} is ${task.status}; only tasks in review can be reviewed`);
  }
  if (!task.branch) throw new Error(`task ${taskId} has no branch to review`);
  const existing = listAgents({ live: true }).find(
    (a) => a.kind === "reviewer" && a.task_id === taskId,
  );
  if (existing) {
    throw new Error(`task ${taskId} already has live reviewer a${existing.id}`);
  }

  const model = modelOverride ?? task.model ?? undefined;
  const dir = createReviewWorktree(task.repo, taskId, task.branch);
  const agent = createAgent({
    kind: "reviewer",
    model,
    state: "spawning",
    task_id: taskId,
  });

  const tag = `task-${taskId}-review`;
  const settingsFile = writeSettingsFile(tag, agent.id, {
    allow: [
      "Read",
      "Grep",
      "Glob",
      "Bash(git diff*)",
      "Bash(git log*)",
      "Bash(git show*)",
      "Bash(git status*)",
      ...(task.verify_cmd ? [`Bash(${task.verify_cmd})`] : []),
    ],
    deny: ["Edit", "Write", "NotebookEdit", "Bash(git commit*)", "Bash(git push*)"],
  });
  const mcpFile = writeMcpConfigFile(tag, {
    CC_ROLE: "reviewer",
    CC_AGENT_ID: String(agent.id),
    CC_TASK_ID: String(taskId),
  });

  fs.mkdirSync(promptsDir(), { recursive: true });
  const promptFile = path.join(promptsDir(), `${tag}.md`);
  fs.writeFileSync(promptFile, buildReviewerPrompt(task));

  const target = newWindow(
    `r${taskId}`,
    dir,
    buildClaudeCmd({ model, settingsFile, mcpFile, promptFile }),
  );
  updateAgent(agent.id, { tmux_target: target, state: "working" });
  logEvent("reviewer.spawned", {
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

/**
 * Terminal cancel from ANY state: kill the task's live worker and reviewer
 * (if any), then mark it cancelled. Idempotent. Returns the tasks still
 * blocked on this one — a cancelled blocker never becomes 'done', so the
 * caller should surface those to the human.
 */
export function cancelTask(
  taskId: number,
  opts?: { rmWorktree?: boolean },
): { task: Task; killed_agents: number[]; open_dependents: Task[] } {
  const task = getTask(taskId);
  if (!task) throw new Error(`task ${taskId} not found`);

  const killed: number[] = [];
  if (task.status !== "cancelled") {
    for (const a of listAgents({ live: true })) {
      if (a.task_id !== taskId || a.kind === "main") continue;
      // reviewer worktrees are throwaway — always reap them with the agent
      killAgent(a.id, { rmWorktree: a.kind === "reviewer" || opts?.rmWorktree });
      killed.push(a.id);
    }
    // killAgent(worker, rmWorktree) already cleared task.worktree; this
    // covers a leftover worktree with no live agent attached.
    if (opts?.rmWorktree) {
      const fresh = getTask(taskId)!;
      if (fresh.worktree) {
        removeWorktree(fresh.repo, fresh.worktree);
        updateTask(taskId, { worktree: null });
      }
    }
    updateTask(taskId, { status: "cancelled" });
    logEvent("task.cancelled", {
      taskId,
      payload: { from: task.status, killed_agents: killed },
    });
  }
  return {
    task: getTask(taskId)!,
    killed_agents: killed,
    open_dependents: openDependents(taskId),
  };
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
  if (task && agent.kind === "reviewer") {
    // A reviewer only ever owns its own detached worktree — never the
    // worker's tree, and killing it must not requeue the task.
    if (opts?.rmWorktree) {
      const dir = reviewWorktreeDir(task.repo, task.id);
      if (fs.existsSync(dir)) removeWorktree(task.repo, dir);
    }
  } else if (task) {
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
