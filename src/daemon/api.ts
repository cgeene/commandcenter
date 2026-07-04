import { Hono } from "hono";
import { z } from "zod";
import { TASK_STATUSES, type TaskStatus } from "../db/db.js";
import { getAgent, listAgents, updateAgent } from "../db/agents.js";
import {
  createCron,
  deleteCron,
  getCron,
  listCrons,
  updateCron,
} from "../db/crons.js";
import { countEventsToday, listEvents, logEvent } from "../db/events.js";
import {
  addMemory,
  deleteMemory,
  listMemories,
  markRecalled,
  searchMemories,
  similarMemories,
} from "../db/memories.js";
import { getSchedulerConfig, setSchedulerConfig } from "../db/settings.js";
import {
  claimTask,
  createTask,
  getTask,
  listTasks,
  readyTasks,
  updateTask,
} from "../db/tasks.js";
import { handleHookEvent, type HookPayload } from "./hooks.js";
import { handleVerdict, taskDiff } from "./review.js";
import {
  cancelTask,
  killAgent,
  spawnMain,
  spawnReviewer,
  spawnWorker,
} from "./spawn.js";
import { capturePane, sendText, windowExists } from "./tmux.js";

const newTaskSchema = z.object({
  title: z.string().min(1),
  prompt: z.string().min(1),
  repo: z.string().min(1),
  priority: z.number().int().min(0).max(4).optional(),
  model: z.string().optional(),
  blocked_by: z.number().int().optional(),
  verify_cmd: z.string().optional(),
});

const updateTaskSchema = z.object({
  title: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  status: z.enum(TASK_STATUSES as [TaskStatus, ...TaskStatus[]]).optional(),
  priority: z.number().int().min(0).max(4).optional(),
  model: z.string().nullable().optional(),
  blocked_by: z.number().int().nullable().optional(),
  verify_cmd: z.string().nullable().optional(),
  result_summary: z.string().nullable().optional(),
  pr_url: z.string().url().nullable().optional(),
});

const spawnSchema = z.object({
  task_id: z.number().int(),
  model: z.string().optional(),
  fresh: z.boolean().optional(),
});

export function buildApp(): Hono {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.get("/api/version", async (c) => {
    const { versionInfo } = await import("./version.js");
    return c.json(versionInfo());
  });

  app.get("/api/tasks", (c) => {
    const status = c.req.query("status") as TaskStatus | undefined;
    if (c.req.query("ready") === "true") return c.json(readyTasks());
    return c.json(listTasks(status));
  });

  app.post("/api/tasks", async (c) => {
    const body = newTaskSchema.parse(await c.req.json());
    const task = createTask(body);
    logEvent("task.created", { taskId: task.id });
    return c.json(task, 201);
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
    const task = updateTask(id, body as Parameters<typeof updateTask>[1]);
    if (body.status && body.status !== before.status) {
      logEvent("task.status", {
        taskId: id,
        payload: { from: before.status, to: body.status },
      });
    }
    return c.json(task);
  });

  app.get("/api/tasks/:id/diff", (c) => {
    const task = getTask(Number(c.req.param("id")));
    if (!task) return c.json({ error: "not found" }, 404);
    if (!task.branch) return c.json({ error: "task has no branch" }, 409);
    return c.json(taskDiff(task));
  });

  app.post("/api/tasks/:id/reviewer", async (c) => {
    const id = Number(c.req.param("id"));
    const body = (await c.req.json().catch(() => ({}))) as { model?: string };
    return c.json(spawnReviewer(id, body.model), 201);
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
    const result = spawnWorker(body.task_id, body.model, { fresh: body.fresh });
    return c.json(result, 201);
  });

  app.post("/api/agents/:id/kill", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      requeue?: boolean;
      rm_worktree?: boolean;
    };
    const agent = killAgent(Number(c.req.param("id")), {
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

  app.post("/api/agents/:id/send", async (c) => {
    const agent = getAgent(Number(c.req.param("id")));
    if (!agent) return c.json({ error: "not found" }, 404);
    if (!agent.tmux_target || !windowExists(agent.tmux_target)) {
      return c.json({ error: "no live tmux window" }, 409);
    }
    const { text } = z.object({ text: z.string().min(1) }).parse(await c.req.json());
    await sendText(agent.tmux_target, text);
    // No Claude Code hook fires when a resumed session picks work back up —
    // Notification is the only thing that sets waiting_input, so nothing
    // clears it until the agent's next Stop/Notification. Delivering input
    // is the one place we know for certain the agent is unblocked, so flip
    // it back to working here instead of leaving the dashboard stale.
    if (agent.state === "waiting_input") {
      updateAgent(agent.id, { state: "working" });
    }
    logEvent("agent.sent", { agentId: agent.id, taskId: agent.task_id ?? undefined });
    return c.json({ ok: true });
  });

  app.get("/api/agents/:id/transcript", async (c) => {
    const agent = getAgent(Number(c.req.param("id")));
    if (!agent) return c.json({ error: "not found" }, 404);
    if (!agent.session_id) {
      return c.json({ error: "agent has no recorded session yet" }, 409);
    }
    const limit = Number(c.req.query("limit") ?? 200);
    const { readTranscript } = await import("./transcript.js");
    const entries = readTranscript(agent.session_id, limit);
    if (!entries) return c.json({ error: "transcript not found" }, 404);
    return c.json({ agent_id: agent.id, session_id: agent.session_id, entries });
  });

  app.post("/api/main", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { model?: string };
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

  // Claude Code hooks POST their stdin JSON here (see genconfig.ts).
  // Respond immediately — verification can take minutes and the hook's curl
  // has a 5s timeout; the transition runs in the background.
  app.post("/api/hooks/agent/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const body = (await c.req.json().catch(() => ({}))) as HookPayload;
    void handleHookEvent(id, body).catch((err) =>
      logEvent("hook.error", { agentId: id, payload: { error: String(err) } }),
    );
    return c.json({ ok: true });
  });

  app.get("/api/events", (c) =>
    c.json(listEvents(Number(c.req.query("limit") ?? 50))),
  );

  const newCronSchema = z.object({
    name: z.string().min(1).regex(/^[a-z0-9-_]+$/i, "name must be alphanumeric/dash"),
    schedule: z.string().min(1),
    prompt: z.string().min(1),
    repo: z.string().min(1),
    title: z.string().optional(),
    model: z.string().optional(),
    priority: z.number().int().min(0).max(4).optional(),
    verify_cmd: z.string().optional(),
    enabled: z.boolean().optional(),
  });

  const cronPatchSchema = z.object({
    schedule: z.string().min(1).optional(),
    title: z.string().optional(),
    prompt: z.string().optional(),
    repo: z.string().optional(),
    model: z.string().nullable().optional(),
    priority: z.number().int().min(0).max(4).optional(),
    verify_cmd: z.string().nullable().optional(),
    enabled: z.boolean().optional(),
  });

  app.get("/api/crons", (c) => c.json(listCrons()));

  app.post("/api/crons", async (c) => {
    const body = newCronSchema.parse(await c.req.json());
    const cron = createCron(body); // throws on invalid schedule -> 500 w/ message
    logEvent("cron.created", { payload: { cron_id: cron.id, name: cron.name } });
    return c.json(cron, 201);
  });

  app.patch("/api/crons/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!getCron(id)) return c.json({ error: "not found" }, 404);
    const body = cronPatchSchema.parse(await c.req.json());
    const cron = updateCron(id, {
      ...body,
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
      model: cron.model ?? undefined,
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

  app.get("/api/transcript/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    if (!/^[0-9a-f-]{8,64}$/i.test(sessionId)) {
      return c.json({ error: "invalid session id" }, 400);
    }
    const { readTranscript } = await import("./transcript.js");
    const entries = readTranscript(sessionId);
    if (!entries) return c.json({ error: "transcript not found" }, 404);
    return c.json({ session_id: sessionId, entries });
  });

  app.onError((err, c) => {
    if (err instanceof z.ZodError) {
      return c.json({ error: "validation", issues: err.issues }, 400);
    }
    return c.json({ error: err.message }, 500);
  });

  return app;
}
