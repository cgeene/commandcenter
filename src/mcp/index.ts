#!/usr/bin/env node
/**
 * "cc" MCP server — how agents touch the platform. Runs as a stdio subprocess
 * of each claude session; all state changes go through the daemon's REST API
 * so SQLite keeps a single writer.
 *
 * Roles (CC_ROLE env): "main" gets the full orchestration toolset,
 * "worker" gets a restricted subset scoped to its own task (CC_TASK_ID),
 * "reviewer" gets read-only task access plus submit_review.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const ROLE =
  process.env.CC_ROLE === "main" || process.env.CC_ROLE === "reviewer"
    ? process.env.CC_ROLE
    : "worker";
const BASE_URL = process.env.CC_URL ?? "http://127.0.0.1:4711";
const MY_TASK_ID = process.env.CC_TASK_ID
  ? Number(process.env.CC_TASK_ID)
  : undefined;

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers:
      body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  }
  return data;
}

function asText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

const server = new McpServer({ name: "cc", version: "0.2.0" });

// ---- shared tools ----

server.registerTool(
  "add_task",
  {
    description:
      "Add a task to the queue. Workers: use this to file follow-up work you notice but should not do yourself.",
    inputSchema: {
      title: z.string(),
      prompt: z.string(),
      repo: z
        .string()
        .optional()
        .describe("absolute repo path; workers default to their own task's repo"),
      model: z.string().optional(),
      priority: z.number().int().min(0).max(4).optional(),
      blocked_by: z.number().int().optional(),
      verify_cmd: z.string().optional(),
    },
  },
  async (args) => {
    let repo = args.repo;
    if (!repo && MY_TASK_ID) {
      const mine = await call<{ repo: string }>("GET", `/api/tasks/${MY_TASK_ID}`);
      repo = mine.repo;
    }
    if (!repo) throw new Error("repo is required");
    return asText(await call("POST", "/api/tasks", { ...args, repo }));
  },
);

server.registerTool(
  "remember",
  {
    description:
      "Store a durable lesson in platform memory (repo quirks, build gotchas, workflow insights). One fact per call. Relevant memories are auto-injected into future workers' prompts, so write them to be useful standalone.",
    inputSchema: {
      text: z.string().max(2000).describe("the lesson, standalone and specific"),
      tags: z.string().optional().describe("comma-separated, e.g. 'repo:functions,build'"),
    },
  },
  async ({ text, tags }) =>
    asText(
      await call("POST", "/api/memories", {
        text,
        tags,
        task_id: MY_TASK_ID,
        agent_id: process.env.CC_AGENT_ID ? Number(process.env.CC_AGENT_ID) : undefined,
      }),
    ),
);

server.registerTool(
  "recall",
  {
    description:
      "Full-text search platform memory for lessons from past work. Use before diving into unfamiliar repos or debugging something that may have happened before.",
    inputSchema: {
      query: z.string(),
      limit: z.number().int().min(1).max(50).optional(),
    },
  },
  async ({ query, limit }) =>
    asText(
      await call(
        "GET",
        `/api/memories?q=${encodeURIComponent(query)}&limit=${limit ?? 10}`,
      ),
    ),
);

server.registerTool(
  "activity_summary",
  {
    description:
      "Digest of platform activity for the last N hours: tasks touched (with verify failures and results), current open queue, event counts, friction (stalls, vanished workers, repeated verify failures, cron skips), memories added, spawn counts. Read-only.",
    inputSchema: {
      hours: z.number().int().min(1).max(336).optional().describe("default 24"),
    },
  },
  async ({ hours }) => asText(await call("GET", `/api/summary?hours=${hours ?? 24}`)),
);

// ---- worker + reviewer tools ----

if (ROLE === "worker" || ROLE === "reviewer") {
  server.registerTool(
    "get_my_task",
    { description: "Fetch your own task record (status, prompt, verify command, branch).", inputSchema: {} },
    async () => asText(await call("GET", `/api/tasks/${MY_TASK_ID}`)),
  );
}

// ---- reviewer tools ----

if (ROLE === "reviewer") {
  server.registerTool(
    "get_task_diff",
    {
      description:
        "Full diff of the task's branch against its merge-base (commits, stat, patch). This is the work you are reviewing.",
      inputSchema: {},
    },
    async () => asText(await call("GET", `/api/tasks/${MY_TASK_ID}/diff`)),
  );

  server.registerTool(
    "submit_review",
    {
      description:
        "Submit your review verdict — call exactly once, then stop. reject requires specific, actionable notes (they are sent verbatim to the worker as its fix list); approve requires a justification citing the evidence you checked.",
      inputSchema: {
        verdict: z.enum(["approve", "reject"]),
        notes: z.string().min(1).max(4000),
      },
    },
    async ({ verdict, notes }) =>
      asText(
        await call("POST", `/api/tasks/${MY_TASK_ID}/verdict`, {
          agent_id: process.env.CC_AGENT_ID ? Number(process.env.CC_AGENT_ID) : undefined,
          verdict,
          notes,
        }),
      ),
  );
}

// ---- worker tools ----

if (ROLE === "worker") {
  server.registerTool(
    "update_my_task",
    {
      description:
        "Update your own task: set result_summary when done, or move status to blocked/review.",
      inputSchema: {
        status: z.enum(["blocked", "review"]).optional(),
        result_summary: z.string().optional(),
      },
    },
    async (args) => asText(await call("PATCH", `/api/tasks/${MY_TASK_ID}`, args)),
  );

  server.registerTool(
    "report_blocked",
    {
      description:
        "Mark your task blocked with a reason when you cannot proceed (missing access, unclear requirements, broken environment).",
      inputSchema: { reason: z.string() },
    },
    async ({ reason }) =>
      asText(
        await call("PATCH", `/api/tasks/${MY_TASK_ID}`, {
          status: "blocked",
          result_summary: `BLOCKED: ${reason}`,
        }),
      ),
  );
}

// ---- main-agent tools ----

if (ROLE === "main") {
  server.registerTool(
    "list_tasks",
    {
      description: "List tasks. ready=true → queued tasks with no open blockers.",
      inputSchema: {
        status: z.string().optional(),
        ready: z.boolean().optional(),
      },
    },
    async ({ status, ready }) => {
      const qs = ready ? "?ready=true" : status ? `?status=${status}` : "";
      return asText(await call("GET", `/api/tasks${qs}`));
    },
  );

  server.registerTool(
    "get_task",
    { description: "Fetch one task by id.", inputSchema: { id: z.number().int() } },
    async ({ id }) => asText(await call("GET", `/api/tasks/${id}`)),
  );

  server.registerTool(
    "update_task",
    {
      description: "Update a task (status, priority, model, prompt, result_summary...).",
      inputSchema: {
        id: z.number().int(),
        status: z
          .enum(["queued", "claimed", "in_progress", "blocked", "review", "done", "failed"])
          .optional()
          .describe("to close a task from any state, use cancel_task instead — it also kills live agents"),
        priority: z.number().int().min(0).max(4).optional(),
        model: z.string().optional(),
        prompt: z.string().optional(),
        verify_cmd: z.string().optional(),
        result_summary: z.string().optional(),
      },
    },
    async ({ id, ...fields }) => asText(await call("PATCH", `/api/tasks/${id}`, fields)),
  );

  server.registerTool(
    "cancel_task",
    {
      description:
        "Close a task from ANY state: kills its live worker/reviewer and marks it cancelled (terminal, idempotent). Returns any open tasks still blocked on it — those need re-pointing or cancelling too.",
      inputSchema: {
        task_id: z.number().int(),
        rm_worktree: z
          .boolean()
          .optional()
          .describe("also remove the task's worktree (uncommitted work is lost; the branch survives)"),
      },
    },
    async ({ task_id, rm_worktree }) =>
      asText(await call("POST", `/api/tasks/${task_id}/cancel`, { rm_worktree })),
  );

  server.registerTool(
    "claim_task",
    {
      description: "Atomically claim a queued task without spawning a worker yet.",
      inputSchema: { id: z.number().int() },
    },
    async ({ id }) => asText(await call("POST", `/api/tasks/${id}/claim`)),
  );

  server.registerTool(
    "spawn_worker",
    {
      description:
        "Spawn a Claude Code worker for a task in its own git worktree + tmux window. Model defaults to the task's model.",
      inputSchema: {
        task_id: z.number().int(),
        model: z.string().optional().describe("haiku | sonnet | opus | ..."),
      },
    },
    async (args) => asText(await call("POST", "/api/agents", args)),
  );

  server.registerTool(
    "list_agents",
    {
      description: "List agents. Default live only; all=true includes dead ones.",
      inputSchema: { all: z.boolean().optional() },
    },
    async ({ all }) => asText(await call("GET", `/api/agents${all ? "" : "?live=true"}`)),
  );

  server.registerTool(
    "peek_worker",
    {
      description: "Read the visible terminal output of an agent's tmux window.",
      inputSchema: {
        agent_id: z.number().int(),
        lines: z.number().int().optional(),
      },
    },
    async ({ agent_id, lines }) =>
      asText(await call("GET", `/api/agents/${agent_id}/peek?lines=${lines ?? 50}`)),
  );

  server.registerTool(
    "send_to_worker",
    {
      description:
        "Send a message into a worker's interactive session (feedback, guidance, answers to its questions).",
      inputSchema: { agent_id: z.number().int(), text: z.string() },
    },
    async ({ agent_id, text }) =>
      asText(await call("POST", `/api/agents/${agent_id}/send`, { text })),
  );

  server.registerTool(
    "kill_worker",
    {
      description: "Kill an agent's tmux window. requeue puts its task back in the queue.",
      inputSchema: {
        agent_id: z.number().int(),
        requeue: z.boolean().optional(),
        rm_worktree: z.boolean().optional(),
      },
    },
    async ({ agent_id, ...rest }) =>
      asText(await call("POST", `/api/agents/${agent_id}/kill`, rest)),
  );

  server.registerTool(
    "get_task_diff",
    {
      description:
        "Diff of a task's branch against its merge-base (commits, stat, patch). Use this to proof a worker's actual changes — never trust its self-report alone.",
      inputSchema: { task_id: z.number().int() },
    },
    async ({ task_id }) => asText(await call("GET", `/api/tasks/${task_id}/diff`)),
  );

  server.registerTool(
    "read_worker_transcript",
    {
      description:
        "Read an agent's session transcript (simplified chat view, last `limit` entries). Use to audit what a worker actually did versus what it claims.",
      inputSchema: {
        agent_id: z.number().int(),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    async ({ agent_id, limit }) =>
      asText(
        await call("GET", `/api/agents/${agent_id}/transcript?limit=${limit ?? 200}`),
      ),
  );

  server.registerTool(
    "spawn_reviewer",
    {
      description:
        "Spawn an independent adversarial reviewer for a task in review. It gets the task prompt + diff in a fresh context (never the worker's conversation), tries to reject the work, and submits approve/reject with notes. Rejection feedback flows back to the worker automatically; 2 rejected cycles block the task for the human.",
      inputSchema: {
        task_id: z.number().int(),
        model: z.string().optional(),
      },
    },
    async ({ task_id, model }) =>
      asText(await call("POST", `/api/tasks/${task_id}/reviewer`, { model })),
  );

  server.registerTool(
    "forget",
    {
      description: "Delete a memory by id (wrong, stale, or superseded).",
      inputSchema: { id: z.number().int() },
    },
    async ({ id }) => asText(await call("DELETE", `/api/memories/${id}`)),
  );

  server.registerTool(
    "recent_events",
    {
      description: "Recent platform events (spawns, status changes, verify results, hooks).",
      inputSchema: { limit: z.number().int().optional() },
    },
    async ({ limit }) => asText(await call("GET", `/api/events?limit=${limit ?? 30}`)),
  );
}

await server.connect(new StdioServerTransport());
