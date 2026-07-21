#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import {
  baseUrl,
  claudeBin,
  codexBin,
  codexHome,
  codexProfile,
  configuredRepoRoots,
  pkgRoot,
  tmuxSession,
} from "../config.js";
import { buildDreamPrompt } from "../prompts/dreamer.js";
import type { Agent } from "../db/agents.js";
import type { Event } from "../db/events.js";
import type { Task } from "../db/tasks.js";
import { gitToplevel } from "../daemon/worktree.js";
import { writeCodexConfig } from "../daemon/genconfig.js";
import { countRepositoriesUnder } from "../daemon/workspaces.js";
import { classifyGhStatus } from "./doctor.js";
import { api } from "./client.js";

const program = new Command()
  .name("agp")
  .description("commandcenter CLI — task queue + Claude Code or Codex workers");

function table(rows: string[][], headers: string[]): string {
  const all = [headers, ...rows];
  const widths = headers.map((_, i) =>
    Math.max(...all.map((r) => (r[i] ?? "").length)),
  );
  return all
    .map((r) => r.map((c, i) => (c ?? "").padEnd(widths[i])).join("  "))
    .join("\n");
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ---- task commands ----

const task = program.command("task").description("manage the task queue");

task
  .command("add <title>")
  .description("add a task to the queue")
  .option("-p, --prompt <prompt>", "task prompt (defaults to title)")
  .option("-f, --prompt-file <file>", "read prompt from a file")
  .option("-r, --repo <path>", "target repo (default: current git repo)")
  .option(
    "-w, --workspace <kind>",
    "workspace kind: repo|portfolio|scratch",
    "repo",
  )
  .option("--repo-root <path>", "configured root for a portfolio task")
  .option("-m, --model <model>", "provider-specific worker model slug")
  .option("-e, --effort <effort>", "Codex reasoning effort (default: high)")
  .option("--provider <provider>", "worker provider (claude|codex)")
  .option("-P, --priority <n>", "0 (highest) - 4", "2")
  .option("-b, --blocked-by <taskId>", "task that must be done first")
  .option("-v, --verify <cmd>", "verification command run in the worktree")
  .action(async (title: string, opts) => {
    const workspace = String(opts.workspace);
    if (!["repo", "portfolio", "scratch"].includes(workspace)) {
      throw new Error("workspace must be repo, portfolio, or scratch");
    }
    const repo = workspace === "repo"
      ? (opts.repo ?? gitToplevel(process.cwd()))
      : undefined;
    const prompt = opts.promptFile
      ? fs.readFileSync(opts.promptFile, "utf8")
      : (opts.prompt ?? title);
    const t = await api<Task>("POST", "/api/tasks", {
      title,
      prompt,
      workspace_kind: workspace,
      ...(repo ? { repo } : {}),
      ...(workspace === "portfolio"
        ? { repo_root: opts.repoRoot ?? opts.repo }
        : {}),
      model: opts.model,
      reasoning_effort: opts.effort,
      worker_provider: opts.provider,
      priority: Number(opts.priority),
      blocked_by: opts.blockedBy ? Number(opts.blockedBy) : undefined,
      verify_cmd: opts.verify,
    });
    console.log(`task #${t.id} queued for Claude main: ${t.title}`);
  });

task
  .command("ls")
  .description("list tasks")
  .option("-s, --status <status>", "filter by status")
  .option("--ready", "only queued tasks with no open blockers")
  .action(async (opts) => {
    const qs = opts.ready
      ? "?ready=true"
      : opts.status
        ? `?status=${opts.status}`
        : "";
    const tasks = await api<Task[]>("GET", `/api/tasks${qs}`);
    if (tasks.length === 0) return console.log("no tasks");
    console.log(
      table(
        tasks.map((t) => [
          `#${t.id}`,
          t.status,
          `p${t.priority}`,
          t.worker_provider,
          t.model ?? "-",
          t.reasoning_effort ?? "-",
          t.agent_id ? `a${t.agent_id}` : "-",
          truncate(t.title, 60),
        ]),
        ["id", "status", "pri", "provider", "model", "effort", "agent", "title"],
      ),
    );
  });

task
  .command("show <id>")
  .description("show full task detail")
  .action(async (id: string) => {
    const t = await api<Task>("GET", `/api/tasks/${id}`);
    console.log(JSON.stringify(t, null, 2));
  });

task
  .command("update <id>")
  .description("update task fields")
  .option("-s, --status <status>")
  .option("-P, --priority <n>")
  .option("-m, --model <model>")
  .option("-e, --effort <effort>", "Codex reasoning effort")
  .option("--provider <provider>", "worker provider (claude|codex)")
  .option("--result <summary>")
  .action(async (id: string, opts) => {
    const t = await api<Task>("PATCH", `/api/tasks/${id}`, {
      status: opts.status,
      priority: opts.priority !== undefined ? Number(opts.priority) : undefined,
      model: opts.model,
      reasoning_effort: opts.effort,
      worker_provider: opts.provider,
      result_summary: opts.result,
    });
    console.log(`task #${t.id}: ${t.status}`);
  });

task
  .command("claim <id>")
  .description("atomically claim a queued task")
  .action(async (id: string) => {
    const t = await api<Task>("POST", `/api/tasks/${id}/claim`);
    console.log(`task #${t.id} claimed`);
  });

task
  .command("cancel <id>")
  .description("close a task from any state (kills its live worker/reviewer)")
  .option("--rm-worktree", "also remove the worktree (uncommitted work is lost)")
  .action(async (id: string, opts) => {
    const r = await api<{
      task: Task;
      killed_agents: number[];
      open_dependents: Task[];
    }>("POST", `/api/tasks/${id}/cancel`, { rm_worktree: opts.rmWorktree });
    const killed = r.killed_agents.length
      ? ` (killed ${r.killed_agents.map((a) => `a${a}`).join(", ")})`
      : "";
    console.log(`task #${r.task.id} cancelled${killed}`);
    for (const d of r.open_dependents) {
      console.log(
        `warning: task #${d.id} ("${d.title}") is blocked_by #${r.task.id} and will never become ready — re-point or cancel it`,
      );
    }
  });

task
  .command("diff <id>")
  .description("show the diff on a task's branch")
  .option("--stat", "stat + commits only")
  .action(async (id: string, opts) => {
    const d = await api<{ commits: string; stat: string; diff: string; truncated: boolean }>(
      "GET",
      `/api/tasks/${id}/diff`,
    );
    console.log(d.commits ? `${d.commits}\n\n${d.stat}` : "(no commits on branch)");
    if (!opts.stat && d.diff) {
      console.log(`\n${d.diff}`);
      if (d.truncated) console.log("[diff truncated]");
    }
  });

// ---- review ----

program
  .command("review <taskId>")
  .description("spawn an independent adversarial reviewer for a task in review")
  .option(
    "-m, --model <model>",
    "reviewer model override (a slug matching the reviewer provider; else CC_REVIEWER_MODEL / the Claude task model / opus for Claude)",
  )
  .option(
    "-p, --provider <provider>",
    "reviewer provider (claude|codex) for cross-model review; defaults to Claude or the CC_REVIEWER_PROVIDER / variety policy",
  )
  .option("-e, --effort <effort>", "Codex reviewer reasoning effort")
  .action(async (taskId: string, opts) => {
    const { agent: a } = await api<{ agent: Agent }>(
      "POST",
      `/api/tasks/${taskId}/reviewer`,
      { model: opts.model, provider: opts.provider, reasoning_effort: opts.effort },
    );
    console.log(
      `reviewer a${a.id} spawned in ${a.tmux_target} (${a.provider}${a.model ? ` ${a.model}` : ""})`,
    );
    console.log(`watch with: agp agent peek ${a.id}`);
  });

// ---- agent commands ----

const agent = program.command("agent").description("manage worker agents");

agent
  .command("spawn")
  .description("spawn a Claude Code or Codex worker (resumes a same-provider session)")
  .requiredOption("-t, --task <id>", "task id")
  .option("--provider <provider>", "worker provider (claude|codex)")
  .option("-m, --model <model>", "override the task's model")
  .option("-e, --effort <effort>", "override the task's Codex reasoning effort")
  .option("--fresh", "force a fresh session instead of resuming")
  .action(async (opts) => {
    const { agent: a, task: t } = await api<{ agent: Agent; task: Task }>(
      "POST",
      "/api/agents",
      {
        task_id: Number(opts.task),
        provider: opts.provider,
        model: opts.model,
        reasoning_effort: opts.effort,
        fresh: opts.fresh,
      },
    );
    console.log(
      `agent a${a.id} spawned for task #${t.id} in ${a.tmux_target} (worktree: ${t.worktree})`,
    );
    console.log(`attach with: agp attach ${a.id}`);
  });

agent
  .command("ls")
  .description("list agents")
  .option("-a, --all", "include dead agents")
  .action(async (opts) => {
    const agents = await api<Agent[]>(
      "GET",
      `/api/agents${opts.all ? "" : "?live=true"}`,
    );
    if (agents.length === 0) return console.log("no agents");
    console.log(
      table(
        agents.map((a) => [
          `a${a.id}`,
          a.kind,
          a.provider,
          a.state,
          a.model ?? "-",
          a.reasoning_effort ?? "-",
          a.task_id ? `#${a.task_id}` : "-",
          a.tmux_target ?? "-",
        ]),
        ["id", "kind", "provider", "state", "model", "effort", "task", "tmux"],
      ),
    );
  });

agent
  .command("kill <id>")
  .description("kill an agent's tmux window")
  .option("--requeue", "put its task back in the queue")
  .option("--rm-worktree", "also remove the task's git worktree")
  .action(async (id: string, opts) => {
    const a = await api<Agent>("POST", `/api/agents/${id}/kill`, {
      requeue: opts.requeue,
      rm_worktree: opts.rmWorktree,
    });
    console.log(`agent a${a.id} dead`);
  });

agent
  .command("peek <id>")
  .description("print the agent's visible terminal output")
  .option("-n, --lines <n>", "history lines", "50")
  .action(async (id: string, opts) => {
    const res = await api<{ content: string }>(
      "GET",
      `/api/agents/${id}/peek?lines=${opts.lines}`,
    );
    console.log(res.content);
  });

agent
  .command("send <id> <text...>")
  .description("send a message into an agent's interactive session")
  .action(async (id: string, words: string[]) => {
    await api("POST", `/api/agents/${id}/send`, { text: words.join(" ") });
    console.log(`sent to a${id}`);
  });

agent
  .command("session <id>")
  .description("show the recorded provider session and manual resume command")
  .action(async (id: string) => {
    const session = await api<{
      provider: string;
      session_id: string;
      transcript_path: string | null;
      cwd: string | null;
      resume_command: string;
    }>("GET", `/api/agents/${id}/session`);
    console.log(`provider: ${session.provider}`);
    console.log(`session:  ${session.session_id}`);
    if (session.transcript_path) console.log(`transcript: ${session.transcript_path}`);
    if (session.cwd) console.log(`cwd:       ${session.cwd}`);
    console.log(`resume:    ${session.resume_command}`);
  });

// ---- cron ----

interface CronJob {
  id: number;
  name: string;
  schedule: string;
  title: string;
  repo: string;
  worker_provider: "claude" | "codex";
  model: string | null;
  reasoning_effort: string | null;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
}

const cron = program.command("cron").description("recurring task templates");

async function resolveCron(idOrName: string): Promise<CronJob> {
  const crons = await api<CronJob[]>("GET", "/api/crons");
  const found = crons.find(
    (x) => String(x.id) === idOrName || x.name === idOrName,
  );
  if (!found) {
    console.error(`error: no cron "${idOrName}"`);
    process.exit(1);
  }
  return found;
}

cron
  .command("add <name>")
  .description("create a recurring task template")
  .requiredOption("-s, --schedule <cron>", 'cron expression, e.g. "0 3 * * *"')
  .option("-p, --prompt <prompt>", "task prompt")
  .option("-f, --prompt-file <file>", "read prompt from a file")
  .option("-r, --repo <path>", "target repo (default: current git repo)")
  .option("--title <title>", "task title (default: cron name)")
  .option("-m, --model <model>")
  .option("-e, --effort <effort>", "Codex reasoning effort (default: high)")
  .option("--provider <provider>", "worker provider (claude|codex)")
  .option("-P, --priority <n>", "0-4", "2")
  .option("-v, --verify <cmd>")
  .action(async (name: string, opts) => {
    const prompt = opts.promptFile
      ? fs.readFileSync(opts.promptFile, "utf8")
      : opts.prompt;
    if (!prompt) {
      console.error("error: provide --prompt or --prompt-file");
      process.exit(1);
    }
    const c = await api<CronJob>("POST", "/api/crons", {
      name,
      schedule: opts.schedule,
      prompt,
      repo: opts.repo ?? gitToplevel(process.cwd()),
      title: opts.title,
      model: opts.model,
      reasoning_effort: opts.effort,
      worker_provider: opts.provider,
      priority: Number(opts.priority),
      verify_cmd: opts.verify,
    });
    console.log(`cron #${c.id} "${c.name}" — next run ${c.next_run_at}`);
  });

cron
  .command("ls")
  .description("list crons")
  .action(async () => {
    const crons = await api<CronJob[]>("GET", "/api/crons");
    if (crons.length === 0) return console.log("no crons");
    console.log(
      table(
        crons.map((x) => [
          `#${x.id}`,
          x.enabled ? "on" : "off",
          x.name,
          x.schedule,
          x.worker_provider,
          x.model ?? "-",
          x.reasoning_effort ?? "-",
          x.next_run_at?.slice(0, 16) ?? "-",
          x.last_run_at?.slice(0, 16) ?? "never",
        ]),
        ["id", "en", "name", "schedule", "provider", "model", "effort", "next", "last"],
      ),
    );
  });

cron
  .command("rm <idOrName>")
  .description("delete a cron")
  .action(async (idOrName: string) => {
    const c = await resolveCron(idOrName);
    await api("DELETE", `/api/crons/${c.id}`);
    console.log(`cron "${c.name}" deleted`);
  });

for (const [cmd, enabled] of [
  ["enable", true],
  ["disable", false],
] as const) {
  cron
    .command(`${cmd} <idOrName>`)
    .description(`${cmd} a cron`)
    .action(async (idOrName: string) => {
      const c = await resolveCron(idOrName);
      await api("PATCH", `/api/crons/${c.id}`, { enabled });
      console.log(`cron "${c.name}" ${cmd}d`);
    });
}

cron
  .command("run <idOrName>")
  .description("enqueue this cron's task now")
  .action(async (idOrName: string) => {
    const c = await resolveCron(idOrName);
    const task = await api<{ id: number }>("POST", `/api/crons/${c.id}/run`);
    console.log(`cron "${c.name}" fired -> task #${task.id} queued`);
  });

// ---- dream ----

const dream = program.command("dream").description("nightly reflection run");

dream
  .command("setup")
  .description("create the dreaming cron (DISABLED — enable with: agp cron enable dreaming)")
  .option("-s, --schedule <cron>", "when to dream", "0 4 * * *")
  .option("-m, --model <model>", "reflection model", "opus")
  .option("-r, --repo <path>", "repo for the dream worktree + improvement tasks (default: commandcenter)")
  .action(async (opts) => {
    const c = await api<CronJob>("POST", "/api/crons", {
      name: "dreaming",
      title: "Dreaming run — nightly reflection",
      schedule: opts.schedule,
      prompt: buildDreamPrompt(),
      repo: opts.repo ?? pkgRoot().replace(/\/$/, ""),
      worker_provider: "claude",
      model: opts.model,
      priority: 3,
      enabled: false,
    });
    console.log(`dreaming cron #${c.id} created (disabled), schedule "${c.schedule}"`);
    console.log("test it:   agp cron run dreaming   (enqueues one dream task now)");
    console.log("enable it: agp cron enable dreaming");
  });

// ---- memory ----

interface Memory {
  id: number;
  text: string;
  tags: string | null;
  task_id: number | null;
  created_at: string;
}

const memory = program.command("memory").description("platform memory");

function printMemories(mems: Memory[]): void {
  if (mems.length === 0) return console.log("no memories");
  for (const m of mems) {
    const tags = m.tags ? ` [${m.tags}]` : "";
    console.log(`#${m.id}${tags} (${m.created_at.slice(0, 10)})\n  ${m.text}`);
  }
}

memory
  .command("ls")
  .description("recent memories")
  .option("-n, --limit <n>", "how many", "20")
  .action(async (opts) => {
    printMemories(await api<Memory[]>("GET", `/api/memories?limit=${opts.limit}`));
  });

memory
  .command("search <query...>")
  .description("full-text search memories")
  .action(async (words: string[]) => {
    printMemories(
      await api<Memory[]>(
        "GET",
        `/api/memories?q=${encodeURIComponent(words.join(" "))}`,
      ),
    );
  });

memory
  .command("add <text>")
  .description("store a memory")
  .option("-t, --tags <tags>", "comma-separated tags")
  .action(async (text: string, opts) => {
    const m = await api<Memory>("POST", "/api/memories", {
      text,
      tags: opts.tags,
    });
    console.log(`memory #${m.id} stored`);
  });

memory
  .command("rm <id>")
  .description("delete a memory")
  .action(async (id: string) => {
    await api("DELETE", `/api/memories/${id}`);
    console.log(`memory #${id} deleted`);
  });

// ---- scheduler ----

interface SchedulerInfo {
  config: {
    enabled: boolean;
    max_concurrent: number;
    daily_spawn_limit: number;
    stall_minutes: number;
    active_hours: { start: number; end: number } | null;
    auto_review: boolean;
    escalate_minutes: number;
    reap_after_minutes: number;
  };
  status: { live_workers: number; spawns_today: number };
}

const scheduler = program
  .command("scheduler")
  .description("autonomous scheduler control");

async function printSchedulerStatus(): Promise<void> {
  const { config, status } = await api<SchedulerInfo>("GET", "/api/scheduler");
  const hours = config.active_hours
    ? `${config.active_hours.start}:00-${config.active_hours.end}:00`
    : "always";
  console.log(
    `scheduler: ${config.enabled ? "ON" : "OFF"} · workers ${status.live_workers}/${config.max_concurrent} · spawns today ${status.spawns_today}/${config.daily_spawn_limit} · window ${hours} · stall ${config.stall_minutes}m · auto-review ${config.auto_review ? "on" : "off"} · escalate ${config.escalate_minutes}m · reap ${config.reap_after_minutes}m`,
  );
}

scheduler
  .command("status", { isDefault: true })
  .description("show scheduler state")
  .action(printSchedulerStatus);

scheduler
  .command("on")
  .description("enable autonomous spawning")
  .action(async () => {
    await api("PATCH", "/api/scheduler", { enabled: true });
    await printSchedulerStatus();
  });

scheduler
  .command("off")
  .description("disable autonomous spawning (kill switch)")
  .action(async () => {
    await api("PATCH", "/api/scheduler", { enabled: false });
    await printSchedulerStatus();
  });

scheduler
  .command("set")
  .description("update scheduler settings")
  .option("--max <n>", "max concurrent workers")
  .option("--limit <n>", "daily autonomous spawn budget")
  .option("--stall <minutes>", "stall detection threshold")
  .option("--hours <range>", '"22-6" for overnight, or "always"')
  .option("--auto-review <on|off>", "auto-review tasks when they reach review")
  .option("--escalate <minutes>", "minutes a waiting worker gets before the human is paged")
  .option("--reap <minutes>", "minutes a finished worker sits idle before it's reaped")
  .action(async (opts) => {
    const patch: Record<string, unknown> = {};
    if (opts.max) patch.max_concurrent = Number(opts.max);
    if (opts.autoReview) patch.auto_review = opts.autoReview === "on";
    if (opts.escalate) patch.escalate_minutes = Number(opts.escalate);
    if (opts.reap) patch.reap_after_minutes = Number(opts.reap);
    if (opts.limit) patch.daily_spawn_limit = Number(opts.limit);
    if (opts.stall) patch.stall_minutes = Number(opts.stall);
    if (opts.hours === "always") patch.active_hours = null;
    else if (opts.hours) {
      const m = /^(\d{1,2})-(\d{1,2})$/.exec(opts.hours);
      if (!m) {
        console.error('error: --hours must be "H-H" (e.g. 22-6) or "always"');
        process.exit(1);
      }
      patch.active_hours = { start: Number(m[1]), end: Number(m[2]) };
    }
    await api("PATCH", "/api/scheduler", patch);
    await printSchedulerStatus();
  });

// ---- Codex worker runtime ----

const codex = program
  .command("codex")
  .description("configure and diagnose the isolated Codex worker runtime");

codex
  .command("setup")
  .description("write Command Center's dedicated Codex profile and lifecycle hooks")
  .action(() => {
    let files: ReturnType<typeof writeCodexConfig>;
    try {
      files = writeCodexConfig();
    } catch (error) {
      console.error(
        `Codex setup failed: ${error instanceof Error ? error.message : "invalid configuration"}`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(`Codex profile written: ${files.profileFile}`);
    console.log(`Codex hooks written:   ${files.hooksFile}`);
    console.log(`Codex rules written:   ${files.rulesFile}`);
    if (files.inheritedMcpNames.length > 0) {
      console.log(
        `Inherited MCP servers:  ${files.inheritedMcpNames.join(", ")}`,
      );
    }
    const escapedHome = files.home.replaceAll("'", `'\\''`);
    console.log("Authenticate this isolated Codex home once (it does not copy your normal credentials):");
    console.log(`  CODEX_HOME='${escapedHome}' ${codexBin()} login`);
    console.log("Review and trust these static hooks once:");
    console.log(
      `  CODEX_HOME='${escapedHome}' ${codexBin()} --profile ${files.profile}`,
    );
    console.log("Then run /hooks in Codex, inspect the hook command, and mark it trusted.");
    console.log("Finish with: agp codex doctor");
  });

codex
  .command("doctor")
  .description("check the Codex binary, build artifacts, and generated profile")
  .action(() => {
    const checks: Array<[string, boolean, string]> = [];
    const version = spawnSync(codexBin(), ["--version"], { encoding: "utf8" });
    checks.push([
      "Codex CLI",
      version.status === 0,
      version.status === 0
        ? (version.stdout || version.stderr).trim()
        : `not runnable: ${codexBin()}`,
    ]);
    const home = codexHome();
    const profileFile = `${home}/${codexProfile()}.config.toml`;
    const hooksFile = `${home}/hooks.json`;
    const rulesFile = `${home}/rules/commandcenter.rules`;
    const runtimeEnv = { ...process.env, CODEX_HOME: home };
    const mcpEntry = path.join(pkgRoot(), "dist", "mcp", "index.js");
    const hookEntry = path.join(pkgRoot(), "dist", "scripts", "codex-hook.js");
    checks.push(["profile", fs.existsSync(profileFile), profileFile]);
    checks.push(["hooks", fs.existsSync(hooksFile), hooksFile]);
    checks.push(["push/merge rules", fs.existsSync(rulesFile), rulesFile]);
    checks.push(["cc MCP build", fs.existsSync(mcpEntry), mcpEntry]);
    checks.push(["hook bridge build", fs.existsSync(hookEntry), hookEntry]);
    if (fs.existsSync(hookEntry)) {
      const runHook = (hook_event_name: string, command: string) =>
        spawnSync(process.execPath, [hookEntry], {
          encoding: "utf8",
          input: JSON.stringify({
            hook_event_name,
            tool_name: "Bash",
            tool_input: { command },
          }),
          env: {
            ...process.env,
            CC_AGENT_ID: "",
            CC_TASK_ID: "7",
            CC_WORKSPACE_KIND: "repo",
          },
          timeout: 5_000,
        });
      const hookCheck = runHook(
        "PermissionRequest",
        "git push -u origin agent/task-7",
      );
      const preToolCheck = runHook("PreToolUse", "env git push origin main");
      let hookValid = false;
      try {
        const output = JSON.parse(hookCheck.stdout) as {
          hookSpecificOutput?: { decision?: { behavior?: string } };
        };
        const preToolOutput = JSON.parse(preToolCheck.stdout) as {
          hookSpecificOutput?: { permissionDecision?: string };
        };
        hookValid =
          hookCheck.status === 0 &&
          output.hookSpecificOutput?.decision?.behavior === "allow" &&
          preToolCheck.status === 0 &&
          preToolOutput.hookSpecificOutput?.permissionDecision === "deny";
      } catch {
        hookValid = false;
      }
      checks.push([
        "hook bridge self-test",
        hookValid,
        hookValid ? "policy and JSON contract valid" : "hook bridge output invalid",
      ]);
    }
    if (fs.existsSync(rulesFile)) {
      const pushPolicy = spawnSync(
        codexBin(),
        [
          "execpolicy",
          "check",
          "--rules",
          rulesFile,
          "git",
          "push",
          "origin",
          "agent/task-7",
        ],
        { encoding: "utf8", env: runtimeEnv },
      );
      checks.push([
        "push rule parse",
        pushPolicy.status === 0 && pushPolicy.stdout.includes('"decision":"prompt"'),
        pushPolicy.status === 0 ? "canonical pushes require policy review" : "rules invalid",
      ]);
    }
    const auth = spawnSync(codexBin(), ["login", "status"], {
      encoding: "utf8",
      env: runtimeEnv,
    });
    checks.push([
      "isolated login",
      auth.status === 0,
      (auth.stdout || auth.stderr).trim() || "not logged in",
    ]);
    if (fs.existsSync(profileFile)) {
      const parsed = spawnSync(
        codexBin(),
        ["--profile", codexProfile(), "debug", "prompt-input", "doctor"],
        { encoding: "utf8", env: runtimeEnv },
      );
      checks.push([
        "profile parse",
        parsed.status === 0,
        parsed.status === 0 ? "valid" : (parsed.stderr || parsed.stdout).trim(),
      ]);
    }

    for (const [name, ok, detail] of checks) {
      console.log(`${ok ? "ok" : "FAIL"}  ${name}: ${detail}`);
    }
    if (checks.some(([, ok]) => !ok)) {
      console.error(
        "Run npm run build, agp codex setup, complete the isolated login/hook trust, and retry.",
      );
      process.exitCode = 1;
    } else {
      console.log("Hook trust is intentionally user-reviewed; verify it with /hooks.");
    }
  });

// ---- doctor (preflight) ----

program
  .command("doctor")
  .description("check prerequisites and configuration for running commandcenter")
  .action(async () => {
    // [name, ok, detail, optional?] — optional checks report status but never
    // set a non-zero exit code (Codex is opt-in; the daemon may not be up yet).
    const checks: Array<[string, boolean, string, boolean?]> = [];

    const nodeMajor = Number(process.versions.node.split(".")[0]);
    checks.push([
      "Node.js >= 22",
      nodeMajor >= 22,
      `v${process.versions.node}`,
    ]);

    const probe = (bin: string, args: string[]): [boolean, string] => {
      const r = spawnSync(bin, args, { encoding: "utf8" });
      if (r.error || r.status !== 0) {
        return [false, `not runnable: ${bin}`];
      }
      return [true, (r.stdout || r.stderr).trim().split("\n")[0]];
    };

    const [tmuxOk, tmuxDetail] = probe("tmux", ["-V"]);
    checks.push([
      "tmux",
      tmuxOk,
      tmuxOk ? tmuxDetail : "not found — install with `brew install tmux` (macOS) or `apt install tmux`",
    ]);

    checks.push(["git", ...probe("git", ["--version"])]);

    const gh = spawnSync("gh", ["auth", "status"], { encoding: "utf8" });
    checks.push(["GitHub CLI (authenticated)", ...classifyGhStatus(gh)]);

    checks.push(["Claude Code", ...probe(claudeBin(), ["--version"])]);

    const [codexOk, codexDetail] = probe(codexBin(), ["--version"]);
    checks.push([
      "Codex CLI (optional)",
      codexOk,
      codexOk ? codexDetail : "not installed — only needed for Codex workers",
      true,
    ]);

    const roots = configuredRepoRoots();
    if (roots.length === 0) {
      checks.push([
        "CC_REPO_ROOTS",
        false,
        'not set — the repository picker will be empty; e.g. export CC_REPO_ROOTS="$HOME/projects"',
      ]);
    } else {
      for (const root of roots) {
        let ok = false;
        let optional: boolean | undefined;
        let detail = root;
        try {
          if (fs.statSync(root).isDirectory()) {
            // Count git roots exactly as the daemon's picker discovers them.
            const repos = countRepositoriesUnder(root);
            if (repos > 0) {
              ok = true;
              detail = `${root} (${repos} git repo${repos === 1 ? "" : "s"} found)`;
            } else {
              // A valid but empty root isn't a failure, but the picker will be
              // empty — surface it as a warning rather than a passing check.
              optional = true;
              detail = `${root} (0 git repos found — the repository picker will be empty)`;
            }
          } else {
            detail = `${root} — not a directory`;
          }
        } catch {
          detail = `${root} — does not exist`;
        }
        checks.push(["CC_REPO_ROOTS", ok, detail, optional]);
      }
    }

    let daemonUp = false;
    try {
      // Bound the probe so a wedged daemon can't hang doctor indefinitely;
      // a timeout/abort is reported the same as unreachable.
      const res = await fetch(`${baseUrl()}/healthz`, {
        signal: AbortSignal.timeout(2000),
      });
      daemonUp = res.ok;
    } catch {
      daemonUp = false;
    }
    checks.push([
      "daemon",
      daemonUp,
      daemonUp
        ? `reachable at ${baseUrl()}`
        : `not running at ${baseUrl()} — start it with \`agentd\` (this is expected before first boot)`,
      true,
    ]);

    for (const [name, ok, detail, optional] of checks) {
      const mark = ok ? "ok  " : optional ? "warn" : "FAIL";
      console.log(`${mark}  ${name}: ${detail}`);
    }
    const requiredFailed = checks.some(([, ok, , optional]) => !ok && !optional);
    if (requiredFailed) {
      console.error(
        "\nSome required checks failed. Install/configure the items marked FAIL above, then re-run `agp doctor`.",
      );
      process.exitCode = 1;
    } else {
      console.log("\nAll required checks passed.");
    }
  });

// ---- upgrade ----

program
  .command("upgrade")
  .description("rebuild and restart the daemon in place (fixes stale-daemon warnings)")
  .option("--main", "also respawn the main agent so it picks up new MCP tools")
  .action(async (opts) => {
    console.log("building…");
    const build = spawnSync("npm", ["run", "build:all"], {
      cwd: pkgRoot(),
      stdio: "inherit",
    });
    if (build.status !== 0) process.exit(build.status ?? 1);

    const list = spawnSync(
      "tmux",
      ["list-windows", "-t", tmuxSession(), "-F", "#{window_name}\t#{session_name}:#{window_id}"],
      { encoding: "utf8" },
    );
    const row = (list.stdout ?? "")
      .split("\n")
      .find((l) => l.startsWith("agentd\t"));
    if (!row) {
      console.log(
        "no tmux window named 'agentd' found — restart the daemon however you run it, then check: agp scheduler status",
      );
      return;
    }
    const target = row.split("\t")[1];
    console.log(`respawning daemon window ${target}…`);
    spawnSync("tmux", ["respawn-window", "-k", "-t", target]);

    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const v = await api<{ stale: boolean; started_at: string }>("GET", "/api/version");
        console.log(`daemon back up (started ${v.started_at}, stale: ${v.stale})`);
        if (opts.main) {
          const agents = await api<Agent[]>("GET", "/api/agents?live=true");
          const main = agents.find((a) => a.kind === "main");
          if (main) await api("POST", `/api/agents/${main.id}/kill`, {});
          const a = await api<Agent>("POST", "/api/main", {});
          console.log(`main agent a${a.id} respawned in ${a.tmux_target}`);
        }
        return;
      } catch {
        /* daemon not up yet */
      }
    }
    console.error("daemon did not come back within 15s — check the agentd window");
    process.exit(1);
  });

// ---- main agent ----

program
  .command("main")
  .description("spawn the orchestrator main agent")
  .option("-m, --model <model>", "model (default: fable, or CC_MAIN_MODEL)")
  .action(async (opts) => {
    const a = await api<Agent>("POST", "/api/main", { model: opts.model });
    console.log(`main agent a${a.id} spawned in ${a.tmux_target} (${a.model})`);
    console.log(`attach with: agp attach ${a.id}`);
  });

// ---- attach / events ----

program
  .command("attach <agentId>")
  .description("attach to an agent's tmux window (interactive)")
  .action(async (agentId: string) => {
    const a = await api<Agent>("GET", `/api/agents/${agentId}`);
    if (!a.tmux_target) {
      console.error("agent has no tmux window");
      process.exit(1);
    }
    const inTmux = !!process.env.TMUX;
    const args = inTmux
      ? ["switch-client", "-t", a.tmux_target]
      : ["attach", "-t", tmuxSession()];
    if (!inTmux) {
      // select the right window before attaching
      spawnSync("tmux", ["select-window", "-t", a.tmux_target]);
    }
    const res = spawnSync("tmux", args, { stdio: "inherit" });
    process.exit(res.status ?? 0);
  });

program
  .command("events")
  .description("recent platform events")
  .option("-n, --limit <n>", "how many", "30")
  .action(async (opts) => {
    const events = await api<Event[]>(
      "GET",
      `/api/events?limit=${opts.limit}`,
    );
    for (const e of events.reverse()) {
      const who = e.agent_id ? `a${e.agent_id}` : "-";
      const what = e.task_id ? `#${e.task_id}` : "-";
      console.log(
        `${e.ts}  ${e.kind.padEnd(14)} agent=${who} task=${what} ${e.payload ?? ""}`,
      );
    }
  });

program.parseAsync();
