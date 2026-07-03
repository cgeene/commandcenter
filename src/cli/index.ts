#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { Command } from "commander";
import { pkgRoot, tmuxSession } from "../config.js";
import { buildDreamPrompt } from "../prompts/dreamer.js";
import type { Agent } from "../db/agents.js";
import type { Event } from "../db/events.js";
import type { Task } from "../db/tasks.js";
import { gitToplevel } from "../daemon/worktree.js";
import { api } from "./client.js";

const program = new Command()
  .name("agp")
  .description("commandcenter CLI — task queue + Claude Code workers");

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
  .option("-m, --model <model>", "model for the worker (sonnet|opus|haiku|...)")
  .option("-P, --priority <n>", "0 (highest) - 4", "2")
  .option("-b, --blocked-by <taskId>", "task that must be done first")
  .option("-v, --verify <cmd>", "verification command run in the worktree")
  .action(async (title: string, opts) => {
    const repo = opts.repo ?? gitToplevel(process.cwd());
    const prompt = opts.promptFile
      ? fs.readFileSync(opts.promptFile, "utf8")
      : (opts.prompt ?? title);
    const t = await api<Task>("POST", "/api/tasks", {
      title,
      prompt,
      repo,
      model: opts.model,
      priority: Number(opts.priority),
      blocked_by: opts.blockedBy ? Number(opts.blockedBy) : undefined,
      verify_cmd: opts.verify,
    });
    console.log(`task #${t.id} queued: ${t.title}`);
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
          t.model ?? "-",
          t.agent_id ? `a${t.agent_id}` : "-",
          truncate(t.title, 60),
        ]),
        ["id", "status", "pri", "model", "agent", "title"],
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
  .option("--result <summary>")
  .action(async (id: string, opts) => {
    const t = await api<Task>("PATCH", `/api/tasks/${id}`, {
      status: opts.status,
      priority: opts.priority !== undefined ? Number(opts.priority) : undefined,
      model: opts.model,
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
  .option("-m, --model <model>", "reviewer model (default: the task's model)")
  .action(async (taskId: string, opts) => {
    const { agent: a } = await api<{ agent: Agent }>(
      "POST",
      `/api/tasks/${taskId}/reviewer`,
      { model: opts.model },
    );
    console.log(`reviewer a${a.id} spawned in ${a.tmux_target}${a.model ? ` (${a.model})` : ""}`);
    console.log(`watch with: agp agent peek ${a.id}`);
  });

// ---- agent commands ----

const agent = program.command("agent").description("manage worker agents");

agent
  .command("spawn")
  .description("spawn a Claude Code worker for a task")
  .requiredOption("-t, --task <id>", "task id")
  .option("-m, --model <model>", "override the task's model")
  .action(async (opts) => {
    const { agent: a, task: t } = await api<{ agent: Agent; task: Task }>(
      "POST",
      "/api/agents",
      { task_id: Number(opts.task), model: opts.model },
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
          a.state,
          a.model ?? "-",
          a.task_id ? `#${a.task_id}` : "-",
          a.tmux_target ?? "-",
        ]),
        ["id", "kind", "state", "model", "task", "tmux"],
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

// ---- cron ----

interface CronJob {
  id: number;
  name: string;
  schedule: string;
  title: string;
  repo: string;
  model: string | null;
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
          x.model ?? "-",
          x.next_run_at?.slice(0, 16) ?? "-",
          x.last_run_at?.slice(0, 16) ?? "never",
        ]),
        ["id", "en", "name", "schedule", "model", "next", "last"],
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
    `scheduler: ${config.enabled ? "ON" : "OFF"} · workers ${status.live_workers}/${config.max_concurrent} · spawns today ${status.spawns_today}/${config.daily_spawn_limit} · window ${hours} · stall ${config.stall_minutes}m · auto-review ${config.auto_review ? "on" : "off"}`,
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
  .option("--auto-review <on|off>", "auto-review scheduler-spawned tasks")
  .action(async (opts) => {
    const patch: Record<string, unknown> = {};
    if (opts.max) patch.max_concurrent = Number(opts.max);
    if (opts.autoReview) patch.auto_review = opts.autoReview === "on";
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

// ---- main agent ----

program
  .command("main")
  .description("spawn the orchestrator main agent")
  .option("-m, --model <model>", "model (default: opus, or CC_MAIN_MODEL)")
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
