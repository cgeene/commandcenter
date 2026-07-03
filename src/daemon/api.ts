import { Hono } from "hono";
import { z } from "zod";
import { TASK_STATUSES, type TaskStatus } from "../db/db.js";
import { getAgent, listAgents } from "../db/agents.js";
import { listEvents, logEvent } from "../db/events.js";
import {
  claimTask,
  createTask,
  getTask,
  listTasks,
  readyTasks,
  updateTask,
} from "../db/tasks.js";
import { handleHookEvent, type HookPayload } from "./hooks.js";
import { killAgent, spawnMain, spawnWorker } from "./spawn.js";
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
});

const spawnSchema = z.object({
  task_id: z.number().int(),
  model: z.string().optional(),
});

export function buildApp(): Hono {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true }));

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
    const result = spawnWorker(body.task_id, body.model);
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
    logEvent("agent.sent", { agentId: agent.id, taskId: agent.task_id ?? undefined });
    return c.json({ ok: true });
  });

  app.post("/api/main", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { model?: string };
    return c.json(spawnMain(body.model), 201);
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

  app.onError((err, c) => {
    if (err instanceof z.ZodError) {
      return c.json({ error: "validation", issues: err.issues }, 400);
    }
    return c.json({ error: err.message }, 500);
  });

  return app;
}
