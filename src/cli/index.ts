#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { Command } from "commander";
import { tmuxSession } from "../config.js";
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
