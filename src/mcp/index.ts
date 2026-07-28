#!/usr/bin/env node
/**
 * "cc" MCP server — how agents touch the platform. Runs as a stdio subprocess
 * of each Claude or Codex session; all state changes go through the daemon's REST API
 * so SQLite keeps a single writer.
 *
 * Roles (CC_ROLE env): "main" gets the full orchestration toolset,
 * "worker" gets a restricted subset scoped to its own task (CC_TASK_ID),
 * "reviewer" gets read-only task access plus submit_review.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { REASONING_EFFORTS } from "../reasoning.js";
import {
  PUBLICATION_FIELDS,
  compactTask,
  echoedFields,
  shapeTask,
  shapeTaskList,
  shapeTaskPayload,
} from "./compact.js";
import { taskReadPath } from "./triage.js";

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

/** How hard the adversarial reviewer works. The orchestrator sets this at
 *  triage from what the task IS — never from what the diff turns out to be. */
const REVIEW_MODE_SCHEMA = z
  .enum(["full", "light"])
  .optional()
  .describe(
    "how hard the adversarial reviewer works (default 'full'). 'light' = a diff-scoped read with no independent re-verification: use ONLY for documentation, threshold, and runbook changes, UI-only changes confined to web/src, and test-only changes. 'full' stays MANDATORY for daemon logic, policy/permissions, migrations, and prod-mutating work, however small. When in doubt, leave it 'full'.",
  );

// Read tools default to a compact projection; these opt back into more.
const verboseArg = z
  .boolean()
  .optional()
  .describe("return the full task record (prompt, untruncated result_summary, review notes)");
const fieldsArg = z
  .array(z.string())
  .max(60)
  .optional()
  .describe("exact task fields to return; wins over verbose. `id` is always included");

const server = new McpServer({ name: "cc", version: "0.2.0" });

// ---- shared tools ----

server.registerTool(
  "add_task",
  {
    description:
      "Add a main-orchestrated task to the queue. For portfolio decomposition, create repo children with parent_task_id. Workers: use this only to file follow-up work you should not do yourself. Returns the compact task record (the prompt you just supplied is not echoed back).",
    inputSchema: {
      title: z.string(),
      prompt: z.string(),
      repo: z
        .string()
        .optional()
        .describe("absolute repo path; workers default to their own task's repo"),
      repo_root: z
        .string()
        .optional()
        .describe("configured repository root for an all-repositories task"),
      workspace_kind: z
        .enum(["repo", "portfolio", "scratch"])
        .optional()
        .describe("repo (default), portfolio/all repositories, or non-Git scratch"),
      parent_task_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("portfolio parent task when creating a per-repository child"),
      model: z.string().optional(),
      reasoning_effort: z
        .enum(REASONING_EFFORTS)
        .optional()
        .describe("Codex reasoning effort; defaults to high"),
      worker_provider: z.enum(["claude", "codex"]).optional(),
      priority: z.number().int().min(0).max(4).optional(),
      blocked_by: z.number().int().optional(),
      verify_cmd: z.string().optional(),
      open_pr: z
        .boolean()
        .optional()
        .describe(
          "false = branch-only: the worker commits and pushes but must NOT open a PR (default true)",
        ),
      review_mode: REVIEW_MODE_SCHEMA,
    },
  },
  async (args) => {
    let repo = args.repo;
    let workspaceKind = args.workspace_kind;
    if (!workspaceKind && !repo && MY_TASK_ID) {
      const mine = await call<{ repo: string; workspace_kind: string }>(
        "GET",
        `/api/tasks/${MY_TASK_ID}`,
      );
      workspaceKind = mine.workspace_kind === "scratch" ? "scratch" : "repo";
      if (workspaceKind === "repo") repo = mine.repo;
    }
    workspaceKind ??= "repo";
    if (!repo && MY_TASK_ID && workspaceKind === "repo") {
      const mine = await call<{ repo: string; workspace_kind: string }>(
        "GET",
        `/api/tasks/${MY_TASK_ID}`,
      );
      if (mine.workspace_kind === "repo") repo = mine.repo;
    }
    if (workspaceKind === "repo" && !repo) throw new Error("repo is required");
    return asText(
      compactTask(
        await call("POST", "/api/tasks", {
          ...args,
          repo,
          workspace_kind: workspaceKind ?? "repo",
          agent_id: process.env.CC_AGENT_ID ? Number(process.env.CC_AGENT_ID) : undefined,
        }),
      ),
    );
  },
);

server.registerTool(
  "remember",
  {
    description:
      "Store a durable lesson in platform memory (repo quirks, build gotchas, workflow insights). One fact per call. Relevant memories are auto-injected into future workers' prompts, so write them to be useful standalone. The result includes `similar` — existing memories that overlap heavily; if one already covers your lesson, mention the redundancy in your result_summary so it can be merged (only the main agent / human can delete).",
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
        `/api/memories?q=${encodeURIComponent(query)}&limit=${limit ?? 10}&track=1`,
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

// ---- internal doc store (all roles) ----
// Long-term storage for research/discovery/investigation findings. These live
// on the local filesystem + a searchable index — NOT in a git repo or a PR.

server.registerTool(
  "save_doc",
  {
    description:
      "Persist a research/discovery/investigation document to the internal doc store (local filesystem, NOT a git repo or PR). Use this for findings deliverables instead of committing markdown into a repo. Saving with a title that resolves to an existing slug (in the same project) updates it in place, bumps the version, and keeps the prior body as <slug>.v<N>.md. `attachments` are sidecar data files (e.g. a CSV) written next to the doc.",
    inputSchema: {
      project: z
        .string()
        .describe("stable topic/initiative name grouping related docs, e.g. 'cogs'"),
      title: z.string(),
      content: z.string().describe("the markdown body"),
      tags: z.string().optional().describe("comma-separated"),
      summary: z.string().optional().describe("one-line summary for listings/search"),
      attachments: z
        .array(z.object({ filename: z.string(), content: z.string() }))
        .optional()
        .describe("sidecar data files (e.g. CSV) stored alongside the doc"),
    },
  },
  async (args) =>
    asText(
      await call("POST", "/api/docs", {
        ...args,
        task_id: MY_TASK_ID,
        agent_id: process.env.CC_AGENT_ID ? Number(process.env.CC_AGENT_ID) : undefined,
      }),
    ),
);

server.registerTool(
  "get_doc",
  {
    description:
      "Fetch a stored doc (with its full body) by numeric id or by slug. Pass project when using a slug to disambiguate.",
    inputSchema: {
      key: z.string().describe("numeric doc id or slug"),
      project: z.string().optional(),
    },
  },
  async ({ key, project }) =>
    asText(
      await call(
        "GET",
        `/api/docs/${encodeURIComponent(key)}${project ? `?project=${encodeURIComponent(project)}` : ""}`,
      ),
    ),
);

server.registerTool(
  "list_docs",
  {
    description:
      "List stored docs (metadata only, no bodies), optionally filtered by project and/or tag.",
    inputSchema: {
      project: z.string().optional(),
      tag: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
  },
  async ({ project, tag, limit }) => {
    const qs = new URLSearchParams();
    if (project) qs.set("project", project);
    if (tag) qs.set("tag", tag);
    if (limit) qs.set("limit", String(limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return asText(await call("GET", `/api/docs${suffix}`));
  },
);

server.registerTool(
  "search_docs",
  {
    description:
      "Full-text search the internal doc store (title, tags, summary, and body). Optionally scope to a project.",
    inputSchema: {
      query: z.string(),
      project: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
  },
  async ({ query, project, limit }) => {
    const qs = new URLSearchParams({ q: query });
    if (project) qs.set("project", project);
    if (limit) qs.set("limit", String(limit));
    return asText(await call("GET", `/api/docs?${qs.toString()}`));
  },
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
        compactTask(
          await call("POST", `/api/tasks/${MY_TASK_ID}/verdict`, {
            agent_id: process.env.CC_AGENT_ID ? Number(process.env.CC_AGENT_ID) : undefined,
            verdict,
            notes,
          }),
        ),
      ),
  );
}

// ---- worker tools ----

if (ROLE === "worker") {
  server.registerTool(
    "update_my_task",
    {
      description:
        "Update your own task: set result_summary when done, pr_url after opening a PR, or move status to blocked/review. Returns the compact task record; use get_my_task if you need the full one back.",
      inputSchema: {
        status: z.enum(["blocked", "review"]).optional(),
        result_summary: z.string().optional(),
        pr_url: z.string().url().optional().describe("the PR you opened for this task"),
      },
    },
    async (args) =>
      asText(compactTask(await call("PATCH", `/api/tasks/${MY_TASK_ID}`, args))),
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
        compactTask(
          await call("PATCH", `/api/tasks/${MY_TASK_ID}`, {
            status: "blocked",
            result_summary: `BLOCKED: ${reason}`,
          }),
        ),
      ),
  );
}

// ---- main-agent tools ----

if (ROLE === "main") {
  server.registerTool(
    "list_tasks",
    {
      description:
        "List tasks. ready=true → queued tasks with no open blockers. Rows are minimal by default (id, title, status, priority, agent_id, blocked_by, pr_state, review_verdict, updated_at) — pass fields for other columns, or verbose=true for full records (expensive: every prompt and result summary).",
      inputSchema: {
        status: z.string().optional(),
        ready: z.boolean().optional(),
        dispatch_mode: z.enum(["direct", "orchestrated"]).optional(),
        verbose: verboseArg,
        fields: fieldsArg,
      },
    },
    async ({ status, ready, dispatch_mode, verbose, fields }) => {
      const params = new URLSearchParams();
      if (ready) params.set("ready", "true");
      else if (status) params.set("status", status);
      if (dispatch_mode) params.set("dispatch_mode", dispatch_mode);
      const qs = params.size > 0 ? `?${params.toString()}` : "";
      return asText(shapeTaskList(await call("GET", `/api/tasks${qs}`), { verbose, fields }));
    },
  );

  server.registerTool(
    "list_repositories",
    {
      description:
        "List the server-validated repository catalog and configured roots. Use this to scope all-repositories tasks before creating isolated child tasks.",
      inputSchema: {
        query: z.string().max(200).optional(),
      },
    },
    async ({ query }) => {
      const catalog = await call<{
        roots: unknown[];
        repositories: Array<{ name: string; relative_path: string; path: string }>;
      }>("GET", "/api/workspaces");
      const needle = query?.trim().toLowerCase();
      return asText({
        ...catalog,
        repositories: needle
          ? catalog.repositories.filter((repo) =>
              `${repo.name} ${repo.relative_path}`.toLowerCase().includes(needle),
            )
          : catalog.repositories,
      });
    },
  );

  server.registerTool(
    "get_task",
    {
      description:
        "Fetch one task by id. Compact by default: core fields plus a truncated result_summary, without the prompt or review notes. TRIAGE REQUIRES get_task(id, verbose: true) — that is the only way to read the task's full prompt, and it also acknowledges the task's triage ping so Command Center stops re-delivering it (an edit to its prompt/repo, or a re-queue, flags it for triage again). fields returns an exact subset.",
      inputSchema: { id: z.number().int(), verbose: verboseArg, fields: fieldsArg },
    },
    // A full read carries ?triage_ack=1: this tool is main-role only, and
    // reading the whole record IS the triage action — see taskReadPath.
    async ({ id, verbose, fields }) =>
      asText(
        shapeTask(await call("GET", taskReadPath(id, { verbose, fields })), {
          verbose,
          fields,
        }),
      ),
  );

  server.registerTool(
    "update_task",
    {
      description:
        "Update a task (status, priority, worker provider, model, reasoning effort, review mode, prompt, result_summary...). Returns the compact task record plus whichever fields you changed — the values you just sent are otherwise not echoed back; use get_task(id, verbose: true) if you need to re-read the whole thing.",
      inputSchema: {
        id: z.number().int(),
        status: z
          .enum(["queued", "claimed", "in_progress", "blocked", "review", "done", "failed"])
          .optional()
          .describe("to close a task from any state, use cancel_task instead — it also kills live agents"),
        priority: z.number().int().min(0).max(4).optional(),
        model: z.string().optional(),
        reasoning_effort: z
          .enum(REASONING_EFFORTS)
          .optional()
          .describe("Codex-only reasoning effort"),
        worker_provider: z.enum(["claude", "codex"]).optional(),
        repo: z
          .string()
          .optional()
          .describe("new allow-listed Git root; kill the prior worker first"),
        prompt: z.string().optional(),
        verify_cmd: z.string().optional(),
        result_summary: z.string().optional(),
        open_pr: z
          .boolean()
          .optional()
          .describe(
            "false = branch-only: the worker commits and pushes but must NOT open a PR",
          ),
        review_mode: REVIEW_MODE_SCHEMA,
      },
    },
    // Echo the compact record PLUS whatever this call changed, so a field
    // outside the core (verify_cmd, …) is still visible as the confirmation
    // that the update landed — the same mechanism confirm_human_publication
    // uses for the publication columns. echoedFields keeps the bulk (the
    // prompt the caller just sent) out of the echo.
    async ({ id, ...fields }) =>
      asText(
        compactTask(
          await call("PATCH", `/api/tasks/${id}`, fields),
          echoedFields(Object.keys(fields)),
        ),
      ),
  );

  server.registerTool(
    "cancel_task",
    {
      description:
        "Close a task from ANY state: kills its live worker/reviewer and marks it cancelled (terminal, idempotent). Returns the compact task plus any open tasks still blocked on it (as minimal rows) — those need re-pointing or cancelling too.",
      inputSchema: {
        task_id: z.number().int(),
        rm_worktree: z
          .boolean()
          .optional()
          .describe("also remove the task's worktree (uncommitted work is lost; the branch survives)"),
        discard_unpublished: z
          .boolean()
          .optional()
          .describe(
            "required with rm_worktree to intentionally destroy reviewer-approved Human-publishes work",
          ),
      },
    },
    async ({ task_id, rm_worktree, discard_unpublished }) =>
      asText(
        shapeTaskPayload(
          await call("POST", `/api/tasks/${task_id}/cancel`, {
            rm_worktree,
            discard_unpublished,
          }),
        ),
      ),
  );

  server.registerTool(
    "resume_task",
    {
      description:
        "Reopen an archived done/cancelled task IN PLACE. Reuses the same task, provider session (when its transcript still exists), workspace/unfinished branch, and history; it does not create a duplicate. Completion/review state is safely reset. After this succeeds, inspect the returned task and spawn_worker for repo/scratch tasks.",
      inputSchema: {
        task_id: z.number().int().positive(),
        instructions: z
          .string()
          .max(20_000)
          .optional()
          .describe("the human's changed or additional requirements"),
      },
    },
    async ({ task_id, instructions }) =>
      asText(
        await call("POST", `/api/tasks/${task_id}/resume`, {
          instructions,
          agent_id: process.env.CC_AGENT_ID
            ? Number(process.env.CC_AGENT_ID)
            : undefined,
        }),
      ),
  );

  server.registerTool(
    "resume_worker",
    {
      description:
        "Resume the stopped worker of a reviewer-approved task IN PLACE. Use when the human wants more work on an active task that is still in review after its worker stopped or was reaped. This invalidates the old approval, preserves the same task/worktree/history, and immediately spawns a managed worker using the same provider session when available. Do not call spawn_worker directly on a task in review.",
      inputSchema: {
        task_id: z.number().int().positive(),
        instructions: z
          .string()
          .max(20_000)
          .optional()
          .describe("the human's changed, additional, or follow-up requirements"),
        fresh: z
          .boolean()
          .optional()
          .describe("force a fresh provider session instead of resuming the saved one"),
      },
    },
    async ({ task_id, instructions, fresh }) =>
      asText(
        await call("POST", `/api/tasks/${task_id}/resume-worker`, {
          instructions,
          fresh,
          agent_id: process.env.CC_AGENT_ID
            ? Number(process.env.CC_AGENT_ID)
            : undefined,
        }),
      ),
  );

  server.registerTool(
    "confirm_human_publication",
    {
      description:
        "After the human reviews, commits, and publishes a Human-publishes task, verify that the committed tree exactly matches the reviewer-approved snapshot, mark its PR ready, and record it. This never commits, pushes, or creates a PR. Returns the compact task record plus publication_mode/publication_state.",
      inputSchema: {
        task_id: z.number().int().positive(),
        pr_url: z
          .string()
          .url()
          .max(2048)
          .optional()
          .describe("required when the task expects a pull request"),
      },
    },
    async ({ task_id, pr_url }) =>
      asText(
        // publication_* is omitted from the compact core, but it IS what this
        // call changes — echo it so the caller can see the new state.
        compactTask(
          await call("POST", `/api/tasks/${task_id}/publication`, {
            ...(pr_url ? { pr_url } : {}),
          }),
          PUBLICATION_FIELDS,
        ),
      ),
  );

  server.registerTool(
    "claim_task",
    {
      description:
        "Atomically claim a queued task without spawning a worker yet. Returns the compact task record.",
      inputSchema: { id: z.number().int() },
    },
    async ({ id }) => asText(compactTask(await call("POST", `/api/tasks/${id}/claim`))),
  );

  server.registerTool(
    "spawn_worker",
    {
      description:
        "Spawn a Claude Code or Codex worker in the task's isolated repository worktree or scratch workspace. Portfolio parents cannot be spawned. Provider, model, and Codex reasoning effort default to the task. A previous session resumes only when it belongs to the same provider (pass fresh=true to force a clean start).",
      inputSchema: {
        task_id: z.number().int(),
        provider: z.enum(["claude", "codex"]).optional(),
        model: z.string().optional().describe("provider-specific model slug"),
        reasoning_effort: z
          .enum(REASONING_EFFORTS)
          .optional()
          .describe("Codex-only reasoning effort; defaults to high"),
        fresh: z.boolean().optional().describe("force a fresh session instead of resuming"),
      },
    },
    async (args) => asText(shapeTaskPayload(await call("POST", "/api/agents", args))),
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
        "Read an agent's session transcript (simplified chat view, last `limit` entries). Use to audit what a worker actually did versus what it claims. Provider formats are parsed defensively and unknown records are skipped.",
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
        "Spawn an independent adversarial reviewer for a task in review. It gets the task prompt + diff in a fresh context (never the worker's conversation), tries to reject the work, and submits approve/reject with notes. Reviewer provider defaults to Claude; set provider to run a cross-model reviewer (e.g. a Codex reviewer on a Claude-authored diff, or vice-versa) — pass a model slug matching that provider. Existing Claude tasks preserve their reviewer model behavior; a Claude reviewer is never given a Codex model slug. Rejection feedback flows back automatically; 2 rejected cycles block the task for the human.",
      inputSchema: {
        task_id: z.number().int(),
        model: z.string().optional(),
        provider: z.enum(["claude", "codex"]).optional(),
        reasoning_effort: z.string().optional(),
      },
    },
    async ({ task_id, model, provider, reasoning_effort }) =>
      asText(
        shapeTaskPayload(
          await call("POST", `/api/tasks/${task_id}/reviewer`, {
            model,
            provider,
            reasoning_effort,
          }),
        ),
      ),
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
    "escalate",
    {
      description:
        "Page the human immediately (high-priority push). Use when a worker's block genuinely needs them — credentials, a judgment call that's theirs, destructive approval — or when something is wrong you cannot fix. Be specific: say which task/agent and exactly what you need from them.",
      inputSchema: {
        title: z.string().max(120),
        message: z.string().max(2000),
        task_id: z.number().int().optional(),
        agent_id: z.number().int().optional(),
      },
    },
    async (args) => asText(await call("POST", "/api/escalate", args)),
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
