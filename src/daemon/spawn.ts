import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  baseUrl,
  claudeBin,
  codexBin,
  codexHome,
  codexProfile,
  promptsDir,
  reviewerModel,
} from "../config.js";
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
import { parseAgentProvider, type AgentProvider } from "../providers.js";
import {
  writeCodexConfig,
  writeMcpConfigFile,
  writeSettingsFile,
} from "./genconfig.js";
import { readOnlyProfileAllow } from "./permissions.js";
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
    "Research deliverables: if this task's output is research, discovery, investigation, or analysis findings (docs, not code), save them to the internal doc store via save_doc(project, title, content) — pick a stable project name for the topic — NOT committed to the repo or opened as a PR. Committing findings into a repo/PR pollutes it with non-code artifacts; the doc store is the home for them. Only put docs in a git repo when THIS task's prompt explicitly says the human wants them there. Code changes still go through branches/PRs as normal.",
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
  if (task.open_pr === 0) {
    lines.push(
      `When done and you have commits: commit to your branch and push it (\`git push -u origin ${branch}\`). Do NOT open a PR — the branch itself is the deliverable for this task. Note the branch name and head commit (\`git rev-parse HEAD\`) in your result_summary.`,
      "When done: set result_summary via update_my_task with a short summary of what you did and how you verified it, then stop.",
    );
  } else {
    lines.push(
      `When done and you have commits: push your branch (\`git push -u origin ${branch}\`) and open a PR with \`gh pr create\` against the repo's default branch — title in conventional-commit style, body covering what/why/how you verified, ending with "commandcenter task #${task.id}". The human reviews PRs in GitHub, not transcripts. Never push any other branch, never merge, never touch an existing PR that isn't yours. If the repo has no GitHub remote, the push fails, or you made no commits, skip the PR and say so in result_summary.`,
      "When done: set result_summary via update_my_task with a short summary of what you did and how you verified it (include pr_url if you opened a PR), then stop.",
    );
  }
  const memories = memorySectionFor(`${task.title} ${task.prompt}`, 5, {
    taskId: task.id,
    repo: task.repo,
  });
  if (memories) lines.push(memories);
  return lines.join("\n");
}

/** Continuation message for `claude --resume` — the resumed session holds
 *  the conversation, but the task prompt is restated: the orchestrator's
 *  "requeue with a better prompt" flow edits task.prompt between sessions,
 *  and a resume that omits it would silently redo the wrong work. */
function buildResumePrompt(task: Task): string {
  const lines = [
    `You are being resumed on task #${task.id} ("${task.title}") — your previous session ended before the task was finished, or the task came back to you.`,
    "Check where you left off (`git status` / `git log` in this worktree), then finish the task.",
    "",
    "## The task (re-read it — it may have been revised since your last session)",
    task.prompt,
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
    task.open_pr === 0
      ? "Everything from your original instructions still applies: verify your work, commit and push your branch — Do NOT open a PR, the branch itself is the deliverable — then set result_summary via update_my_task and stop."
      : "Everything from your original instructions still applies: verify your work, push your branch and open/update the PR if you have commits, then set result_summary via update_my_task and stop.",
  );
  return lines.join("\n");
}

/** Workers may publish their own branch + PR without a permission stall —
 *  but only their own branch; anything else still prompts. Exact commands,
 *  no trailing glob: `${branch}*` would also match a refspec push onto the
 *  remote's main (`git push origin ${branch}:main`) and sibling branches
 *  by prefix (task-1* matches task-10..task-19). The read-only profile is
 *  a base layer underneath — anything outside it still prompts normally. */
function buildWorkerAllow(branch: string): string[] {
  return [
    ...readOnlyProfileAllow(),
    `Bash(git push -u origin ${branch})`,
    `Bash(git push origin ${branch})`,
    "Bash(gh pr create*)",
    "Bash(gh pr view*)",
  ];
}

/** Reviewers are read-only by design (Edit/Write/commit/push are denied
 *  below), so the shared read-only profile applies unconditionally. */
function buildReviewerAllow(task: Task): string[] {
  return [
    "Read",
    "Grep",
    "Glob",
    ...readOnlyProfileAllow(),
    "Bash(git status*)",
    ...(task.verify_cmd ? [`Bash(${task.verify_cmd})`] : []),
  ];
}

/** Test-only exports: prompt construction is behavior worth pinning. */
export const _buildWorkerPromptForTest = buildWorkerPrompt;
export const _buildResumePromptForTest = buildResumePrompt;
export const _buildWorkerAllowForTest = buildWorkerAllow;
export const _buildReviewerAllowForTest = buildReviewerAllow;

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

function buildCodexCmd(opts: {
  agentId: number;
  taskId: number;
  model?: string;
  promptFile: string;
  resumeSession?: string;
}): string {
  const env = [
    ["CODEX_HOME", codexHome()],
    ["CC_URL", baseUrl()],
    ["CC_ROLE", "worker"],
    ["CC_AGENT_ID", String(opts.agentId)],
    ["CC_TASK_ID", String(opts.taskId)],
  ]
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
  const common = [
    shellQuote(codexBin()),
    "--profile",
    shellQuote(codexProfile()),
    "--sandbox",
    "workspace-write",
    "--ask-for-approval",
    "on-request",
    ...(opts.model ? ["--model", shellQuote(opts.model)] : []),
  ];
  const invocation = opts.resumeSession
    ? [...common, "resume", shellQuote(opts.resumeSession)]
    : common;
  return `${env} ${invocation.join(" ")} "$(cat ${shellQuote(opts.promptFile)})"`;
}

export const _buildCodexCmdForTest = buildCodexCmd;

function resumableSession(
  task: Task,
  provider: AgentProvider,
  fresh = false,
): string | undefined {
  if (fresh || !task.session_id) return undefined;
  const sameProvider =
    task.session_provider === provider ||
    (task.session_provider === null && provider === "claude");
  if (!sameProvider) return undefined;
  if (provider === "claude" && !findTranscript(task.session_id)) return undefined;
  return task.session_id;
}

function resolveReviewerModel(override?: string): string {
  return override ?? reviewerModel();
}

export const _resumableSessionForTest = resumableSession;
export const _resolveReviewerModelForTest = resolveReviewerModel;

export function spawnWorker(
  taskId: number,
  modelOverride?: string,
  opts?: { fresh?: boolean; provider?: AgentProvider },
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

  const provider = parseAgentProvider(opts?.provider ?? task.worker_provider, "claude");
  const providerChanged = provider !== task.worker_provider;
  const model = modelOverride ?? (providerChanged ? undefined : task.model ?? undefined);
  const { dir, branch } = createWorktree(task.repo, taskId);

  // Agent row first: its id is baked into the generated hook + MCP configs.
  const agent = createAgent({
    kind: "worker",
    provider,
    model,
    state: "spawning",
    task_id: taskId,
  });

  const tag = `task-${taskId}`;
  let settingsFile: string | undefined;
  let mcpFile: string | undefined;
  let runtimeConfigPath: string | undefined;
  if (provider === "claude") {
    settingsFile = writeSettingsFile(tag, agent.id, {
      allow: buildWorkerAllow(branch),
    });
    mcpFile = writeMcpConfigFile(tag, {
      CC_ROLE: "worker",
      CC_AGENT_ID: String(agent.id),
      CC_TASK_ID: String(taskId),
    });
    runtimeConfigPath = settingsFile;
  } else {
    const config = writeCodexConfig();
    runtimeConfigPath = config.profileFile;
  }
  updateAgent(agent.id, { runtime_config_path: runtimeConfigPath });

  // A prior session with a surviving transcript means the worker can pick
  // up exactly where it stopped instead of re-learning the task from zero.
  const resumeSession = resumableSession(task, provider, opts?.fresh);

  fs.mkdirSync(promptsDir(), { recursive: true });
  const promptFile = path.join(promptsDir(), `${tag}.md`);
  fs.writeFileSync(
    promptFile,
    resumeSession ? buildResumePrompt(task) : buildWorkerPrompt(task, branch),
  );

  const command =
    provider === "codex"
      ? buildCodexCmd({
          agentId: agent.id,
          taskId,
          model,
          promptFile,
          resumeSession,
        })
      : buildClaudeCmd({
          model,
          settingsFile: settingsFile!,
          mcpFile: mcpFile!,
          promptFile,
          resumeSession,
        });
  const target = newWindow(`t${taskId}`, dir, command);
  updateAgent(agent.id, { tmux_target: target, state: "working" });
  updateTask(taskId, {
    status: "in_progress",
    agent_id: agent.id,
    worktree: dir,
    branch,
    worker_provider: provider,
    model: model ?? (providerChanged ? null : task.model),
  });
  logEvent("agent.spawned", {
    agentId: agent.id,
    taskId,
    payload: {
      target,
      provider,
      model,
      worktree: dir,
      resumed: Boolean(resumeSession),
    },
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

  const model = resolveReviewerModel(modelOverride);
  const dir = createReviewWorktree(task.repo, taskId, task.branch, task.open_pr !== 0);
  const agent = createAgent({
    kind: "reviewer",
    provider: "claude",
    model,
    state: "spawning",
    task_id: taskId,
  });

  const tag = `task-${taskId}-review`;
  const settingsFile = writeSettingsFile(tag, agent.id, {
    allow: buildReviewerAllow(task),
    deny: ["Edit", "Write", "NotebookEdit", "Bash(git commit*)", "Bash(git push*)"],
  });
  const mcpFile = writeMcpConfigFile(tag, {
    CC_ROLE: "reviewer",
    CC_AGENT_ID: String(agent.id),
    CC_TASK_ID: String(taskId),
  });
  updateAgent(agent.id, { runtime_config_path: settingsFile });

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
    provider: "claude",
    model: resolvedModel,
    state: "spawning",
  });

  const settingsFile = writeSettingsFile("main", agent.id);
  const mcpFile = writeMcpConfigFile("main", {
    CC_ROLE: "main",
    CC_AGENT_ID: String(agent.id),
  });
  updateAgent(agent.id, { runtime_config_path: settingsFile });

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
