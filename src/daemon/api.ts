import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  baseUrl,
  claudeBin,
  codexBin,
  codexHome,
  codexProfile,
  dataDir,
} from "../config.js";
import { TASK_STATUSES, type TaskStatus } from "../db/db.js";
import { getAgent, listAgents } from "../db/agents.js";
import {
  createCron,
  deleteCron,
  getCron,
  listCrons,
  updateCron,
} from "../db/crons.js";
import { countEventsToday, listEvents, logEvent } from "../db/events.js";
import { humanizeEvent } from "./humanize.js";
import {
  addMemory,
  deleteMemory,
  listMemories,
  markRecalled,
  searchMemories,
  similarMemories,
} from "../db/memories.js";
import {
  getDoc,
  getDocAttachment,
  listDocs,
  saveDoc,
  searchDocs,
} from "../db/docs.js";
import {
  getAgentSettings,
  getNotificationSettings,
  getSchedulerConfig,
  getWorkspaceSettings,
  resolveMainModel,
  resolveMainWorkspaceDir,
  resolveNtfyToken,
  resolveNtfyUrl,
  resolveReviewerProviderPin,
  resolveReviewerVariety,
  resolveWorkerProvider,
  resolveWorktreesDir,
  setAgentSettings,
  setNotificationSettings,
  setSchedulerConfig,
  setWorkspaceSettings,
} from "../db/settings.js";
import { dismissAttention } from "../db/attention.js";
import {
  claimTask,
  childTasks,
  createTask,
  DISPATCH_MODES,
  getTask,
  listTasks,
  readyTasks,
  updateTask,
  WORKSPACE_KINDS,
  type Task,
} from "../db/tasks.js";
import { handleHookEvent, resetAutoNudgeCount, type HookPayload } from "./hooks.js";
import { handleVerdict, taskDiff } from "./review.js";
import {
  cancelTask,
  killAgent,
  spawnMain,
  spawnReviewer,
  spawnWorker,
} from "./spawn.js";
import { resumeAgent, submitPending } from "./resume.js";
import { capturePane, clearInputLine, windowExists } from "./tmux.js";
import { parsePane } from "./pane.js";
import { AGENT_PROVIDERS } from "../providers.js";
import {
  DEFAULT_CODEX_REASONING_EFFORT,
  REASONING_EFFORTS,
} from "../reasoning.js";
import { CLAUDE_MODEL_SLUGS, providerModels } from "./provider-models.js";
import { delegateTaskToMain } from "./orchestration.js";
import {
  allocateScratchWorkspace,
  removeScratchWorkspace,
  repositoryRoots,
  resolveAllowedRepository,
  resolvePortfolioChildRepository,
  resolvePortfolioRoot,
  validateScratchWorkspace,
  WorkspaceValidationError,
  workspaceCatalog,
} from "./workspaces.js";

const providerSchema = z.enum(AGENT_PROVIDERS);
const reasoningEffortSchema = z.enum(REASONING_EFFORTS);
const workspaceKindSchema = z.enum(WORKSPACE_KINDS);
const dispatchModeSchema = z.enum(DISPATCH_MODES);
const modelIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(/^[a-z0-9._:/@-]+$/i, "invalid model identifier");
const hookPayloadSchema = z
  .object({
    hook_event_name: z.string().min(1).max(64).optional(),
    session_id: z.string().min(1).max(128).optional(),
    transcript_path: z.string().min(1).max(4096).nullable().optional(),
    notification_type: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z_]+$/)
      .optional(),
    tool_name: z.string().min(1).max(256).optional(),
    tool_input: z.record(z.string(), z.unknown()).optional(),
    message: z.string().max(20_000).optional(),
  })
  .passthrough();

const newTaskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  prompt: z.string().min(1).max(100_000),
  repo: z.string().min(1).max(4096).optional(),
  repo_root: z.string().min(1).max(4096).optional(),
  workspace_kind: workspaceKindSchema.optional(),
  parent_task_id: z.number().int().positive().optional(),
  priority: z.number().int().min(0).max(4).optional(),
  worker_provider: providerSchema.optional(),
  model: modelIdentifierSchema.optional(),
  reasoning_effort: reasoningEffortSchema.optional(),
  blocked_by: z.number().int().positive().optional(),
  verify_cmd: z.string().max(4096).optional(),
  open_pr: z.boolean().optional(),
});

const updateTaskSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  prompt: z.string().min(1).max(100_000).optional(),
  repo: z.string().min(1).max(4096).optional(),
  status: z.enum(TASK_STATUSES as [TaskStatus, ...TaskStatus[]]).optional(),
  priority: z.number().int().min(0).max(4).optional(),
  worker_provider: providerSchema.optional(),
  model: modelIdentifierSchema.nullable().optional(),
  reasoning_effort: reasoningEffortSchema.nullable().optional(),
  blocked_by: z.number().int().positive().nullable().optional(),
  verify_cmd: z.string().max(4096).nullable().optional(),
  result_summary: z.string().max(100_000).nullable().optional(),
  pr_url: z.string().url().nullable().optional(),
  open_pr: z.boolean().optional(),
});

const spawnSchema = z.object({
  task_id: z.number().int(),
  provider: providerSchema.optional(),
  model: z.string().optional(),
  reasoning_effort: reasoningEffortSchema.optional(),
  fresh: z.boolean().optional(),
});

export function buildApp(): Hono {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.get("/api/providers", (c) =>
    c.json({
      default_worker_provider: resolveWorkerProvider(),
      main_provider: "claude" as const,
      default_main_model: resolveMainModel(),
    }),
  );

  app.get("/api/workspaces", (c) => c.json(workspaceCatalog()));

  app.get("/api/providers/:provider/models", async (c) => {
    const parsed = providerSchema.safeParse(c.req.param("provider"));
    if (!parsed.success) return c.json({ error: "invalid provider" }, 400);
    try {
      return c.json({ provider: parsed.data, models: await providerModels(parsed.data) });
    } catch {
      return c.json({ error: "model catalog unavailable" }, 503);
    }
  });

  app.get("/api/version", async (c) => {
    const { versionInfo } = await import("./version.js");
    return c.json(versionInfo());
  });

  app.get("/api/tasks", (c) => {
    const status = c.req.query("status") as TaskStatus | undefined;
    const dispatchResult = dispatchModeSchema.safeParse(c.req.query("dispatch_mode"));
    const dispatchMode = dispatchResult.success ? dispatchResult.data : undefined;
    if (c.req.query("dispatch_mode") && !dispatchResult.success) {
      return c.json({ error: "invalid dispatch mode" }, 400);
    }
    const tasks = c.req.query("ready") === "true"
      ? readyTasks(dispatchMode)
      : listTasks(status).filter(
          (task) => !dispatchMode || task.dispatch_mode === dispatchMode,
        );
    return c.json(tasks);
  });

  app.post("/api/tasks", async (c) => {
    const body = newTaskSchema.parse(await c.req.json());
    const explicitWorkspace = body.workspace_kind !== undefined;
    const workspaceKind = body.workspace_kind ?? "repo";
    if (workspaceKind === "repo" && !body.repo) {
      return c.json({ error: "repository is required" }, 400);
    }
    if (workspaceKind === "scratch" && (body.repo || body.repo_root)) {
      return c.json({ error: "scratch workspace paths are server-managed" }, 400);
    }
    if (workspaceKind === "portfolio" && body.repo && body.repo_root) {
      return c.json({ error: "select one repository root" }, 400);
    }
    if (workspaceKind === "repo" && body.repo_root) {
      return c.json({ error: "repo_root is only valid for all-repositories tasks" }, 400);
    }
    if (workspaceKind !== "repo" && body.open_pr === true) {
      return c.json({ error: "non-repository tasks cannot open pull requests" }, 400);
    }
    const parent = body.parent_task_id !== undefined
      ? getTask(body.parent_task_id)
      : undefined;
    if (body.parent_task_id !== undefined) {
      if (!parent || parent.workspace_kind !== "portfolio") {
        return c.json({ error: "parent task must be an all-repositories task" }, 400);
      }
      if (workspaceKind !== "repo") {
        return c.json({ error: "all-repositories children must be repository tasks" }, 400);
      }
    }
    const workerProvider =
      body.worker_provider ?? parent?.worker_provider ?? resolveWorkerProvider();
    const inheritedModel =
      parent?.worker_provider === workerProvider ? parent.model ?? undefined : undefined;
    const inheritedReasoningEffort =
      parent?.worker_provider === "codex" && workerProvider === "codex"
        ? parent.reasoning_effort ?? undefined
        : undefined;
    const model = body.model ?? inheritedModel;
    const reasoningEffort = body.reasoning_effort ?? inheritedReasoningEffort;
    if (workerProvider === "claude" && reasoningEffort !== undefined) {
      return c.json({ error: "reasoning effort is only supported for Codex workers" }, 400);
    }

    let allocatedScratch: string | undefined;
    let repo: string;
    let task: Task;
    try {
      if (workspaceKind === "scratch") {
        allocatedScratch = allocateScratchWorkspace();
        repo = allocatedScratch;
      } else if (workspaceKind === "portfolio") {
        repo = resolvePortfolioRoot(body.repo_root ?? body.repo);
      } else {
        // A configured root list is always enforced. When it is absent, keep
        // the historical absolute-path behavior so an existing/cloud install
        // can upgrade before opting into the catalog and portfolio workflow.
        if (repositoryRoots().length > 0) {
          repo = parent
            ? resolvePortfolioChildRepository(body.repo!, parent.repo)
            : resolveAllowedRepository(body.repo!);
        } else {
          if (!path.isAbsolute(body.repo!) || body.repo!.includes("\0")) {
            return c.json({ error: "repository must be an absolute path" }, 400);
          }
          repo = path.normalize(body.repo!);
        }
      }
      if (
        parent &&
        childTasks(parent.id).some((candidate) => candidate.repo === repo)
      ) {
        if (allocatedScratch) removeScratchWorkspace(allocatedScratch);
        return c.json(
          { error: "a child task already exists for this repository" },
          409,
        );
      }
      task = createTask({
        title: body.title,
        prompt: body.prompt,
        repo,
        workspace_kind: workspaceKind,
        // New explicit workspace submissions are always studied by Claude
        // main. Omitted workspace_kind is the compatibility path for older
        // clients and existing cloud workflows.
        dispatch_mode: explicitWorkspace ? "orchestrated" : "direct",
        parent_task_id: body.parent_task_id,
        priority: body.priority ?? parent?.priority,
        worker_provider: workerProvider,
        model,
        reasoning_effort: reasoningEffort,
        blocked_by: body.blocked_by,
        verify_cmd: body.verify_cmd,
        open_pr: workspaceKind === "repo" ? body.open_pr : false,
      });
    } catch (error) {
      if (allocatedScratch) {
        try {
          removeScratchWorkspace(allocatedScratch);
        } catch {
          // Best effort: retention cleanup will reap an orphan later.
        }
      }
      throw error;
    }
    logEvent("task.created", {
      taskId: task.id,
      payload: {
        workspace_kind: task.workspace_kind,
        dispatch_mode: task.dispatch_mode,
        parent_task_id: task.parent_task_id,
      },
    });
    if (task.dispatch_mode === "orchestrated" && task.parent_task_id === null) {
      try {
        await delegateTaskToMain(task.id);
      } catch {
        logEvent("task.awaiting_main", { taskId: task.id });
      }
    }
    return c.json(getTask(task.id), 201);
  });

  app.get("/api/tasks/:id", (c) => {
    const task = getTask(Number(c.req.param("id")));
    return task ? c.json(task) : c.json({ error: "not found" }, 404);
  });

  app.patch("/api/tasks/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!getTask(id)) return c.json({ error: "not found" }, 404);
    const body = updateTaskSchema.parse(await c.req.json());
    const before = getTask(id)!;
    const nextProvider = body.worker_provider ?? before.worker_provider;
    if (nextProvider === "claude" && body.reasoning_effort != null) {
      return c.json({ error: "reasoning effort is only supported for Codex workers" }, 400);
    }
    if (body.open_pr === true && before.workspace_kind !== "repo") {
      return c.json({ error: "non-repository tasks cannot open pull requests" }, 400);
    }
    if (body.repo !== undefined) {
      if (before.workspace_kind !== "repo") {
        return c.json({ error: "only repository tasks can change repositories" }, 400);
      }
      if (before.agent_id) {
        const active = getAgent(before.agent_id);
        if (active && active.state !== "dead") {
          return c.json({ error: "repository cannot change while the task has a live agent" }, 409);
        }
      }
    }
    if (
      body.worker_provider !== undefined &&
      body.worker_provider !== before.worker_provider &&
      before.agent_id
    ) {
      const active = getAgent(before.agent_id);
      if (active && active.state !== "dead") {
        return c.json(
          { error: "worker provider cannot change while the task has a live agent" },
          409,
        );
      }
    }
    // body.open_pr is a boolean (or absent); only present when the caller
    // sent it, so an explicit `undefined` never gets bound as a SQL param
    // (that binds NULL against a NOT NULL column — see the crons.enabled bug).
    const patch: Record<string, unknown> = { ...body };
    if (body.status === "queued" && before.workspace_kind === "scratch") {
      try {
        validateScratchWorkspace(before.repo);
      } catch (error) {
        if (!(error instanceof WorkspaceValidationError)) throw error;
        if (before.agent_id) {
          const active = getAgent(before.agent_id);
          if (active && active.state !== "dead") {
            return c.json(
              { error: "kill the live scratch worker before recreating its workspace" },
              409,
            );
          }
        }
        patch.repo = allocateScratchWorkspace();
        patch.worktree = null;
      }
    }
    if (body.repo !== undefined) {
      if (repositoryRoots().length > 0) {
        if (before.parent_task_id !== null) {
          const portfolioParent = getTask(before.parent_task_id);
          if (!portfolioParent || portfolioParent.workspace_kind !== "portfolio") {
            return c.json({ error: "portfolio parent is unavailable" }, 409);
          }
          const nextRepo = resolvePortfolioChildRepository(
            body.repo,
            portfolioParent.repo,
          );
          if (
            childTasks(portfolioParent.id).some(
              (candidate) => candidate.id !== before.id && candidate.repo === nextRepo,
            )
          ) {
            return c.json(
              { error: "a child task already exists for this repository" },
              409,
            );
          }
          patch.repo = nextRepo;
        } else {
          patch.repo = resolveAllowedRepository(body.repo);
        }
      } else {
        // A portfolio child was created under an explicit root boundary. If
        // that allow-list later disappears, fail closed instead of silently
        // degrading its update into the legacy arbitrary-path behavior.
        if (before.parent_task_id !== null) {
          return c.json(
            { error: "repository roots must be configured to move a portfolio child" },
            409,
          );
        }
        if (!path.isAbsolute(body.repo) || body.repo.includes("\0")) {
          return c.json({ error: "repository must be an absolute path" }, 400);
        }
        patch.repo = path.normalize(body.repo);
      }
    }
    if (
      body.worker_provider !== undefined &&
      body.worker_provider !== before.worker_provider &&
      body.model === undefined
    ) {
      patch.model = null;
    }
    if (body.reasoning_effort === null) {
      patch.reasoning_effort =
        nextProvider === "codex" ? DEFAULT_CODEX_REASONING_EFFORT : null;
    } else if (
      body.worker_provider !== undefined &&
      body.worker_provider !== before.worker_provider &&
      body.reasoning_effort === undefined
    ) {
      patch.reasoning_effort =
        nextProvider === "codex" ? DEFAULT_CODEX_REASONING_EFFORT : null;
    }
    if (body.open_pr !== undefined) patch.open_pr = body.open_pr ? 1 : 0;
    const task = updateTask(id, patch as Parameters<typeof updateTask>[1]);
    if (body.status && body.status !== before.status) {
      logEvent("task.status", {
        taskId: id,
        payload: { from: before.status, to: body.status },
      });
    }
    if (
      task?.status === "queued" &&
      task.dispatch_mode === "orchestrated" &&
      task.parent_task_id === null
    ) {
      try {
        await delegateTaskToMain(task.id);
      } catch {
        logEvent("task.awaiting_main", { taskId: task.id });
      }
    }
    return c.json(task);
  });

  app.post("/api/tasks/:id/delegate", async (c) => {
    const id = Number(c.req.param("id"));
    const task = getTask(id);
    if (!task) return c.json({ error: "not found" }, 404);
    if (task.dispatch_mode !== "orchestrated" || task.status !== "queued") {
      return c.json({ error: "task is not awaiting main-agent triage" }, 409);
    }
    if (!readyTasks("orchestrated").some((candidate) => candidate.id === task.id)) {
      return c.json({ error: "task blockers are not done" }, 409);
    }
    if (!(await delegateTaskToMain(id))) {
      return c.json({ error: "main agent is unavailable" }, 409);
    }
    return c.json({ ok: true });
  });

  app.get("/api/tasks/:id/diff", (c) => {
    const task = getTask(Number(c.req.param("id")));
    if (!task) return c.json({ error: "not found" }, 404);
    if (!task.branch) return c.json({ error: "task has no branch" }, 409);
    return c.json(taskDiff(task));
  });

  app.post("/api/tasks/:id/reviewer", async (c) => {
    const id = Number(c.req.param("id"));
    const body = z
      .object({
        model: modelIdentifierSchema.optional(),
        provider: providerSchema.optional(),
        reasoning_effort: reasoningEffortSchema.optional(),
      })
      .parse(await c.req.json().catch(() => ({})));
    return c.json(
      spawnReviewer(id, {
        model: body.model,
        provider: body.provider,
        reasoningEffort: body.reasoning_effort,
      }),
      201,
    );
  });

  app.post("/api/tasks/:id/verdict", async (c) => {
    const id = Number(c.req.param("id"));
    const body = z
      .object({
        agent_id: z.number().int(),
        verdict: z.enum(["approve", "reject"]),
        notes: z.string().min(1),
      })
      .parse(await c.req.json());
    const task = await handleVerdict(id, body.agent_id, body.verdict, body.notes);
    return c.json(task);
  });

  app.post("/api/tasks/:id/cancel", async (c) => {
    const id = Number(c.req.param("id"));
    const body = (await c.req.json().catch(() => ({}))) as {
      rm_worktree?: boolean;
    };
    return c.json(cancelTask(id, { rmWorktree: body.rm_worktree }));
  });

  app.post("/api/tasks/:id/claim", (c) => {
    const id = Number(c.req.param("id"));
    const task = claimTask(id);
    if (!task) return c.json({ error: "not claimable" }, 409);
    logEvent("task.claimed", { taskId: id });
    return c.json(task);
  });

  app.get("/api/agents", (c) =>
    c.json(listAgents({ live: c.req.query("live") === "true" })),
  );

  app.get("/api/agents/:id", (c) => {
    const agent = getAgent(Number(c.req.param("id")));
    return agent ? c.json(agent) : c.json({ error: "not found" }, 404);
  });

  app.post("/api/agents", async (c) => {
    const body = spawnSchema.parse(await c.req.json());
    const task = getTask(body.task_id);
    if (!task) return c.json({ error: "not found" }, 404);
    const provider = body.provider ?? task.worker_provider;
    if (provider === "claude" && body.reasoning_effort !== undefined) {
      return c.json({ error: "reasoning effort is only supported for Codex workers" }, 400);
    }
    const result = spawnWorker(body.task_id, body.model, {
      fresh: body.fresh,
      provider: body.provider,
      reasoningEffort: body.reasoning_effort,
    });
    return c.json(result, 201);
  });

  app.post("/api/agents/:id/kill", async (c) => {
    const id = Number(c.req.param("id"));
    // Defense-in-depth for the dashboard hiding the main agent's kill button:
    // killing the orchestrator from here is a footgun, so reject it server-side
    // too. Internal shutdown paths call killAgent() directly and are unaffected.
    if (getAgent(id)?.kind === "main") {
      return c.json({ error: "refusing to kill the main agent" }, 403);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      requeue?: boolean;
      rm_worktree?: boolean;
    };
    const agent = killAgent(id, {
      requeue: body.requeue,
      rmWorktree: body.rm_worktree,
    });
    return c.json(agent);
  });

  app.get("/api/agents/:id/peek", (c) => {
    const agent = getAgent(Number(c.req.param("id")));
    if (!agent) return c.json({ error: "not found" }, 404);
    if (!agent.tmux_target || !windowExists(agent.tmux_target)) {
      return c.json({ error: "no live tmux window" }, 409);
    }
    const lines = Number(c.req.query("lines") ?? 50);
    return c.json({ target: agent.tmux_target, content: capturePane(agent.tmux_target, lines) });
  });

  // Structured read of what a waiting_input agent's pane is showing — lets
  // the dashboard answer it without opening the terminal.
  app.get("/api/agents/:id/pane", (c) => {
    const agent = getAgent(Number(c.req.param("id")));
    if (!agent) return c.json({ error: "not found" }, 404);
    if (!agent.tmux_target || !windowExists(agent.tmux_target)) {
      return c.json({ error: "no live tmux window" }, 409);
    }
    const lines = Number(c.req.query("lines") ?? 60);
    // Styled capture so the parser can drop dim ghost-text (Claude) / rotating
    // suggestions (Codex); provider selects the right parsing path.
    const raw = capturePane(agent.tmux_target, lines, { escapes: true });
    return c.json({ target: agent.tmux_target, ...parsePane(raw, agent.provider) });
  });

  app.post("/api/agents/:id/send", async (c) => {
    const agent = getAgent(Number(c.req.param("id")));
    if (!agent) return c.json({ error: "not found" }, 404);
    const { text } = z.object({ text: z.string().min(1) }).parse(await c.req.json());
    // interrupt: a send to a waiting agent IS the answer to its question
    const outcome = await resumeAgent(agent.id, text, { interrupt: true });
    if (outcome !== "sent") return c.json({ error: "no live tmux window" }, 409);
    // A human or the orchestrator delivered real input — any transient-error
    // stall streak this agent was on is over.
    resetAutoNudgeCount(agent.id);
    logEvent("agent.sent", { agentId: agent.id, taskId: agent.task_id ?? undefined });
    return c.json({ ok: true });
  });

  // "submit it" on an unsubmitted-input banner: press Enter on whatever's
  // already typed, without retyping it (that would duplicate the text).
  app.post("/api/agents/:id/submit-input", async (c) => {
    const agent = getAgent(Number(c.req.param("id")));
    if (!agent) return c.json({ error: "not found" }, 404);
    const outcome = await submitPending(agent.id);
    if (outcome !== "sent") return c.json({ error: "no live tmux window" }, 409);
    resetAutoNudgeCount(agent.id);
    logEvent("agent.input_submitted", { agentId: agent.id, taskId: agent.task_id ?? undefined });
    return c.json({ ok: true });
  });

  // "clear it" on an unsubmitted-input banner: Ctrl-U, never a silent submit.
  app.post("/api/agents/:id/clear-input", (c) => {
    const agent = getAgent(Number(c.req.param("id")));
    if (!agent) return c.json({ error: "not found" }, 404);
    if (!agent.tmux_target || !windowExists(agent.tmux_target)) {
      return c.json({ error: "no live tmux window" }, 409);
    }
    clearInputLine(agent.tmux_target);
    logEvent("agent.input_cleared", { agentId: agent.id, taskId: agent.task_id ?? undefined });
    return c.json({ ok: true });
  });

  app.get("/api/agents/:id/transcript", async (c) => {
    const agent = getAgent(Number(c.req.param("id")));
    if (!agent) return c.json({ error: "not found" }, 404);
    if (!agent.session_id) {
      return c.json({ error: "agent has no recorded session yet" }, 409);
    }
    const limit = Number(c.req.query("limit") ?? 200);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      return c.json({ error: "limit must be an integer from 1 to 500" }, 400);
    }
    const { readProviderTranscript } = await import("./transcript.js");
    const entries = readProviderTranscript(
      agent.provider,
      agent.session_id,
      agent.transcript_path,
      limit,
    );
    if (!entries) return c.json({ error: "transcript not found" }, 404);
    return c.json({
      agent_id: agent.id,
      provider: agent.provider,
      session_id: agent.session_id,
      entries,
    });
  });

  app.get("/api/agents/:id/session", (c) => {
    const agent = getAgent(Number(c.req.param("id")));
    if (!agent) return c.json({ error: "not found" }, 404);
    if (!agent.session_id) {
      return c.json({ error: "agent has no recorded session yet" }, 409);
    }
    const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
    const taskIdEnv = agent.task_id
      ? ` CC_TASK_ID=${quote(String(agent.task_id))}`
      : "";
    const command =
      agent.provider === "codex"
        ? [
            `CC_URL=${quote(baseUrl())}`,
            `CC_ROLE=${quote(agent.kind)}`,
            `CC_AGENT_ID=${quote(String(agent.id))}${taskIdEnv}`,
            `CODEX_HOME=${quote(codexHome())}`,
            quote(codexBin()),
            "--profile",
            quote(codexProfile()),
            ...(agent.model ? ["--model", quote(agent.model)] : []),
            ...(agent.reasoning_effort
              ? [
                  "--config",
                  quote(`model_reasoning_effort="${agent.reasoning_effort}"`),
                ]
              : []),
            "resume",
            quote(agent.session_id),
          ].join(" ")
        : (() => {
            const tag =
              agent.kind === "main"
                ? "main"
                : `task-${agent.task_id}${agent.kind === "reviewer" ? "-review" : ""}`;
            const mcpFile = path.join(dataDir(), "mcp", `${tag}.json`);
            return [
              quote(claudeBin()),
              "--resume",
              quote(agent.session_id),
              ...(agent.runtime_config_path
                ? ["--settings", quote(agent.runtime_config_path)]
                : []),
              "--mcp-config",
              quote(mcpFile),
            ].join(" ");
          })();
    return c.json({
      agent_id: agent.id,
      provider: agent.provider,
      model: agent.model,
      reasoning_effort: agent.reasoning_effort,
      session_id: agent.session_id,
      transcript_path: agent.transcript_path,
      cwd: agent.task_id ? getTask(agent.task_id)?.worktree ?? null : null,
      resume_command: command,
    });
  });

  app.post("/api/main", async (c) => {
    const body = z
      .object({ model: modelIdentifierSchema.optional() })
      .parse(await c.req.json().catch(() => ({})));
    return c.json(spawnMain(body.model), 201);
  });

  // Main agent's line to the human: an immediate high-priority push.
  app.post("/api/escalate", async (c) => {
    const body = z
      .object({
        title: z.string().min(1).max(120),
        message: z.string().min(1).max(2000),
        task_id: z.number().int().optional(),
        agent_id: z.number().int().optional(),
      })
      .parse(await c.req.json());
    logEvent("main.escalated", {
      taskId: body.task_id,
      agentId: body.agent_id,
      payload: { title: body.title },
    });
    const { notify } = await import("./notify.js");
    notify(body.title, body.message, { priority: "high", tags: "sos" });
    return c.json({ ok: true });
  });

  // Provider lifecycle hooks POST their stdin JSON here (see genconfig.ts).
  // Respond immediately — verification can take minutes and the hook's curl
  // has a 5s timeout; the transition runs in the background.
  app.post("/api/hooks/agent/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id < 1) return c.json({ error: "invalid agent id" }, 400);
    const body = hookPayloadSchema.parse(await c.req.json().catch(() => ({}))) as HookPayload;
    void handleHookEvent(id, body).catch((err) =>
      logEvent("hook.error", { agentId: id, payload: { error: String(err) } }),
    );
    return c.json({ ok: true });
  });

  app.get("/api/events", (c) => {
    const events = listEvents(Number(c.req.query("limit") ?? 50));
    // ?narrated=true adds a human-readable one-liner per event for the
    // dashboard's narrated feed; raw callers get the events untouched.
    if (c.req.query("narrated") === "true") {
      return c.json(events.map((e) => ({ ...e, narrative: humanizeEvent(e) })));
    }
    return c.json(events);
  });

  // The pinned "Needs You" action queue — an ordered list of items only the
  // human can act on, derived live from tasks/agents/events.
  app.get("/api/attention", async (c) => {
    const { computeAttention } = await import("./attention.js");
    return c.json(await computeAttention());
  });

  app.post("/api/attention/:key/dismiss", (c) => {
    const key = c.req.param("key");
    if (!key) return c.json({ error: "missing key" }, 400);
    dismissAttention(key);
    logEvent("attention.dismissed", { payload: { key } });
    return c.json({ ok: true });
  });

  const newCronSchema = z.object({
    name: z.string().min(1).regex(/^[a-z0-9-_]+$/i, "name must be alphanumeric/dash"),
    schedule: z.string().min(1),
    prompt: z.string().min(1),
    repo: z.string().min(1),
    worker_provider: providerSchema.optional(),
    title: z.string().optional(),
    model: z.string().optional(),
    reasoning_effort: reasoningEffortSchema.optional(),
    priority: z.number().int().min(0).max(4).optional(),
    verify_cmd: z.string().optional(),
    enabled: z.boolean().optional(),
  });

  const cronPatchSchema = z.object({
    schedule: z.string().min(1).optional(),
    title: z.string().optional(),
    prompt: z.string().optional(),
    repo: z.string().optional(),
    worker_provider: providerSchema.optional(),
    model: z.string().nullable().optional(),
    reasoning_effort: reasoningEffortSchema.nullable().optional(),
    priority: z.number().int().min(0).max(4).optional(),
    verify_cmd: z.string().nullable().optional(),
    enabled: z.boolean().optional(),
  });

  app.get("/api/crons", (c) => c.json(listCrons()));

  app.post("/api/crons", async (c) => {
    const body = newCronSchema.parse(await c.req.json());
    const workerProvider = body.worker_provider ?? resolveWorkerProvider();
    if (workerProvider === "claude" && body.reasoning_effort !== undefined) {
      return c.json({ error: "reasoning effort is only supported for Codex workers" }, 400);
    }
    const cron = createCron({
      ...body,
      worker_provider: workerProvider,
    }); // throws on invalid schedule -> 500 w/ message
    logEvent("cron.created", { payload: { cron_id: cron.id, name: cron.name } });
    return c.json(cron, 201);
  });

  app.patch("/api/crons/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const before = getCron(id);
    if (!before) return c.json({ error: "not found" }, 404);
    const body = cronPatchSchema.parse(await c.req.json());
    const nextProvider = body.worker_provider ?? before.worker_provider;
    if (nextProvider === "claude" && body.reasoning_effort != null) {
      return c.json({ error: "reasoning effort is only supported for Codex workers" }, 400);
    }
    const cron = updateCron(id, {
      ...body,
      ...(body.worker_provider !== undefined &&
      body.worker_provider !== before.worker_provider &&
      body.model === undefined
        ? { model: null }
        : {}),
      ...(body.reasoning_effort === null ||
      (body.worker_provider !== undefined &&
        body.worker_provider !== before.worker_provider &&
        body.reasoning_effort === undefined)
        ? {
            reasoning_effort:
              nextProvider === "codex" ? DEFAULT_CODEX_REASONING_EFFORT : null,
          }
        : {}),
      enabled: body.enabled === undefined ? undefined : body.enabled ? 1 : 0,
    } as Parameters<typeof updateCron>[1]);
    logEvent("cron.updated", { payload: { cron_id: id, patch: body } });
    return c.json(cron);
  });

  app.delete("/api/crons/:id", (c) => {
    const id = Number(c.req.param("id"));
    if (!deleteCron(id)) return c.json({ error: "not found" }, 404);
    logEvent("cron.deleted", { payload: { cron_id: id } });
    return c.json({ ok: true });
  });

  app.post("/api/crons/:id/run", async (c) => {
    const cron = getCron(Number(c.req.param("id")));
    if (!cron) return c.json({ error: "not found" }, 404);
    const { createTask } = await import("../db/tasks.js");
    const task = createTask({
      title: cron.title,
      prompt: cron.prompt,
      repo: cron.repo,
      worker_provider: cron.worker_provider,
      model: cron.model ?? undefined,
      reasoning_effort: cron.reasoning_effort ?? undefined,
      priority: cron.priority,
      verify_cmd: cron.verify_cmd ?? undefined,
      cron_id: cron.id,
    });
    updateCron(cron.id, { last_run_at: new Date().toISOString() });
    logEvent("cron.fired", {
      taskId: task.id,
      payload: { cron_id: cron.id, name: cron.name, manual: true },
    });
    return c.json(task, 201);
  });

  app.get("/api/summary", async (c) => {
    const hours = Math.min(Number(c.req.query("hours") ?? 24), 24 * 14);
    const until = c.req.query("until") ?? new Date().toISOString();
    const since =
      c.req.query("since") ??
      new Date(Date.parse(until) - hours * 3600_000).toISOString();
    const { activitySummary } = await import("./summary.js");
    return c.json(activitySummary(since, until));
  });

  app.get("/api/memories", (c) => {
    const q = c.req.query("q");
    const limit = Number(c.req.query("limit") ?? 20);
    const hits = q ? searchMemories(q, limit) : listMemories(limit);
    // track=1 (agent recall) feeds the usage boost + the dreamer's pruning
    // data; human browsing from the dashboard/CLI must not pollute it.
    if (q && c.req.query("track") === "1" && hits.length > 0) {
      markRecalled(hits.map((m) => m.id));
      logEvent("memory.recalled", { payload: { ids: hits.map((m) => m.id), q } });
    }
    return c.json(hits);
  });

  app.post("/api/memories", async (c) => {
    const body = z
      .object({
        text: z.string().min(1).max(2000),
        tags: z.string().optional(),
        task_id: z.number().int().optional(),
        agent_id: z.number().int().optional(),
      })
      .parse(await c.req.json());
    const memory = addMemory(body);
    logEvent("memory.added", {
      taskId: body.task_id,
      agentId: body.agent_id,
      payload: { id: memory.id },
    });
    // near-duplicates ride along so the caller can merge instead of pile up
    const similar = similarMemories(body.text, memory.id).map((m) => ({
      id: m.id,
      text: m.text,
      tags: m.tags,
    }));
    return c.json({ ...memory, similar }, 201);
  });

  app.delete("/api/memories/:id", (c) => {
    const id = Number(c.req.param("id"));
    if (!deleteMemory(id)) return c.json({ error: "not found" }, 404);
    logEvent("memory.deleted", { payload: { id } });
    return c.json({ ok: true });
  });

  // ---- internal doc store ----

  const newDocSchema = z.object({
    project: z.string().min(1),
    title: z.string().min(1),
    content: z.string().min(1),
    tags: z.string().optional(),
    summary: z.string().optional(),
    task_id: z.number().int().optional(),
    agent_id: z.number().int().optional(),
    attachments: z
      .array(z.object({ filename: z.string().min(1), content: z.string() }))
      .optional(),
  });

  // List or (with ?q=) search docs. Metadata only — no bodies.
  app.get("/api/docs", (c) => {
    const q = c.req.query("q");
    const project = c.req.query("project") || undefined;
    const tag = c.req.query("tag") || undefined;
    const limit = Number(c.req.query("limit") ?? 20);
    if (q) return c.json(searchDocs(q, limit, project));
    return c.json(listDocs({ project, tag }));
  });

  // Fetch one doc (with its body) by numeric id or by slug (+ ?project=).
  app.get("/api/docs/:key", (c) => {
    const key = c.req.param("key");
    const project = c.req.query("project") || undefined;
    const doc = getDoc(/^\d+$/.test(key) ? Number(key) : key, project);
    return doc ? c.json(doc) : c.json({ error: "not found" }, 404);
  });

  // Download a doc's sidecar attachment (CSV etc.) as a raw file. Served as an
  // attachment so the browser downloads it rather than trying to render it.
  app.get("/api/docs/:key/attachments/:name", (c) => {
    const key = c.req.param("key");
    const name = c.req.param("name");
    const project = c.req.query("project") || undefined;
    const att = getDocAttachment(/^\d+$/.test(key) ? Number(key) : key, name, project);
    if (!att) return c.json({ error: "not found" }, 404);
    return c.body(new Uint8Array(att.content), 200, {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${att.filename.replace(/"/g, "")}"`,
    });
  });

  app.post("/api/docs", async (c) => {
    const body = newDocSchema.parse(await c.req.json());
    const { doc, created } = saveDoc(body);
    logEvent("doc.saved", {
      taskId: body.task_id,
      agentId: body.agent_id,
      payload: { id: doc.id, project: doc.project, slug: doc.slug, created, version: doc.version },
    });
    return c.json(doc, created ? 201 : 200);
  });

  const schedulerPatchSchema = z.object({
    enabled: z.boolean().optional(),
    max_concurrent: z.number().int().min(1).max(10).optional(),
    daily_spawn_limit: z.number().int().min(1).max(200).optional(),
    stall_minutes: z.number().int().min(2).max(240).optional(),
    active_hours: z
      .object({
        start: z.number().int().min(0).max(23),
        end: z.number().int().min(0).max(23),
      })
      .nullable()
      .optional(),
    auto_review: z.boolean().optional(),
    escalate_minutes: z.number().int().min(1).max(120).optional(),
    read_only_extra_allow: z.array(z.string()).optional(),
    attention_stale_minutes: z.number().int().min(1).max(240).optional(),
    reap_after_minutes: z.number().int().min(1).max(240).optional(),
  });

  app.get("/api/scheduler", (c) => {
    const liveWorkers = listAgents({ live: true }).filter(
      (a) => a.kind === "worker",
    ).length;
    return c.json({
      config: getSchedulerConfig(),
      status: {
        live_workers: liveWorkers,
        spawns_today:
          countEventsToday("scheduler.spawned") +
          countEventsToday("reviewer.auto_spawned"),
      },
    });
  });

  app.patch("/api/scheduler", async (c) => {
    const patch = schedulerPatchSchema.parse(await c.req.json());
    const config = setSchedulerConfig(patch);
    logEvent("scheduler.config", { payload: patch });
    return c.json({ config });
  });

  /* -------------------------------------------------------------- *
   * Runtime settings (agents / workspace / notifications).          *
   * Server-side validation is the trust boundary: paths must be     *
   * absolute + existing directories, models come from the allow-    *
   * list, providers from the fixed set. GET never returns a secret. *
   * -------------------------------------------------------------- */

  // An absolute path to an existing directory, or null to clear the override.
  // Blank/whitespace is normalized to null (clear). No emptiness rejection and
  // no deny-list — the workspace dir is a free CHOICE of cwd, by design.
  const dirOverrideSchema = z
    .string()
    .nullable()
    .optional()
    .transform((v) => {
      if (v == null) return v;
      const trimmed = v.trim();
      return trimmed.length === 0 ? null : trimmed;
    })
    .superRefine((v, ctx) => {
      if (v == null) return;
      if (!path.isAbsolute(v)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "path must be absolute" });
        return;
      }
      let isDir = false;
      try {
        isDir = fs.statSync(v).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "path must be an existing directory" });
      }
    });

  const providerOverrideSchema = z.enum(AGENT_PROVIDERS).nullable().optional();

  const agentSettingsPatchSchema = z.object({
    default_main_model: z
      .string()
      .nullable()
      .optional()
      .superRefine((v, ctx) => {
        if (v == null) return;
        if (!CLAUDE_MODEL_SLUGS.includes(v)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `model must be one of: ${CLAUDE_MODEL_SLUGS.join(", ")}`,
          });
        }
      }),
    default_worker_provider: providerOverrideSchema,
    default_reviewer_provider: providerOverrideSchema,
    reviewer_variety: z.boolean().nullable().optional(),
  });

  const workspaceSettingsPatchSchema = z.object({
    worktrees_dir: dirOverrideSchema,
    main_workspace_dir: dirOverrideSchema,
  });

  // ntfy URL must be an http(s) URL when set; blank/null clears it. The token
  // is write-only: set it with any non-blank string, clear it with ""/null.
  // It is NEVER echoed back (see GET /api/settings).
  const notificationSettingsPatchSchema = z.object({
    ntfy_url: z
      .string()
      .nullable()
      .optional()
      .transform((v) => {
        if (v == null) return v;
        const trimmed = v.trim();
        return trimmed.length === 0 ? null : trimmed;
      })
      .superRefine((v, ctx) => {
        if (v == null) return;
        try {
          const parsed = new URL(v);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: "URL must be http(s)" });
          }
        } catch {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid URL" });
        }
      }),
    ntfy_token: z
      .string()
      .nullable()
      .optional()
      .transform((v) => {
        if (v == null) return v;
        const trimmed = v.trim();
        return trimmed.length === 0 ? null : trimmed;
      }),
  });

  app.get("/api/settings", (c) => {
    const agents = getAgentSettings();
    const workspace = getWorkspaceSettings();
    const notifications = getNotificationSettings();
    return c.json({
      agents: {
        stored: agents,
        effective: {
          default_main_model: resolveMainModel(),
          default_worker_provider: resolveWorkerProvider(),
          default_reviewer_provider: resolveReviewerProviderPin() ?? null,
          reviewer_variety: resolveReviewerVariety(),
        },
      },
      workspace: {
        stored: workspace,
        effective: {
          worktrees_dir: resolveWorktreesDir(),
          main_workspace_dir: resolveMainWorkspaceDir(),
        },
      },
      notifications: {
        // Secret token is never serialized — only its presence.
        stored: { ntfy_url: notifications.ntfy_url },
        ntfy_token_set: Boolean(resolveNtfyToken()),
        effective: { ntfy_url: resolveNtfyUrl() ?? null },
      },
      model_choices: CLAUDE_MODEL_SLUGS,
      provider_choices: AGENT_PROVIDERS,
    });
  });

  app.patch("/api/settings/agents", async (c) => {
    const patch = agentSettingsPatchSchema.parse(await c.req.json());
    const agents = setAgentSettings(patch);
    logEvent("settings.config", { payload: { group: "agents", patch } });
    return c.json({ agents });
  });

  app.patch("/api/settings/workspace", async (c) => {
    const patch = workspaceSettingsPatchSchema.parse(await c.req.json());
    const workspace = setWorkspaceSettings(patch);
    logEvent("settings.config", { payload: { group: "workspace", patch } });
    return c.json({ workspace });
  });

  app.patch("/api/settings/notifications", async (c) => {
    const patch = notificationSettingsPatchSchema.parse(await c.req.json());
    setNotificationSettings(patch);
    // Never echo the token (or its replacement) back — return presence only,
    // mirroring GET so the client can update its masked field state.
    const notifications = getNotificationSettings();
    logEvent("settings.config", {
      payload: {
        group: "notifications",
        // Log intent without the secret value: whether the token was changed.
        patch: {
          ntfy_url: patch.ntfy_url ?? null,
          ntfy_token_changed: patch.ntfy_token !== undefined,
        },
      },
    });
    return c.json({
      notifications: {
        stored: { ntfy_url: notifications.ntfy_url },
        ntfy_token_set: Boolean(resolveNtfyToken()),
        effective: { ntfy_url: resolveNtfyUrl() ?? null },
      },
    });
  });

  app.get("/api/transcript/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    if (!/^[0-9a-f-]{8,64}$/i.test(sessionId)) {
      return c.json({ error: "invalid session id" }, 400);
    }
    const providerResult = providerSchema.safeParse(c.req.query("provider") ?? "claude");
    if (!providerResult.success) return c.json({ error: "invalid provider" }, 400);
    const { readProviderTranscript } = await import("./transcript.js");
    const entries = readProviderTranscript(providerResult.data, sessionId);
    if (!entries) return c.json({ error: "transcript not found" }, 404);
    return c.json({ provider: providerResult.data, session_id: sessionId, entries });
  });

  app.onError((err, c) => {
    if (err instanceof z.ZodError) {
      return c.json({ error: "validation", issues: err.issues }, 400);
    }
    if (err instanceof WorkspaceValidationError) {
      return c.json({ error: err.message }, 400);
    }
    // Do not expose stack traces, local paths, command output, or provider
    // details through the browser/API boundary.
    return c.json({ error: "internal error" }, 500);
  });

  return app;
}
