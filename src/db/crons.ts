import { Cron as CronExpr } from "croner";
import { getDb } from "./db.js";
import { parseAgentProvider, type AgentProvider } from "../providers.js";

export interface CronJob {
  id: number;
  name: string;
  schedule: string;
  title: string;
  prompt: string;
  repo: string;
  worker_provider: AgentProvider;
  model: string | null;
  priority: number;
  verify_cmd: string | null;
  enabled: number; // sqlite boolean
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
}

/** Throws on an invalid cron expression; returns the next fire time. */
export function nextRun(schedule: string, from: Date): string {
  const next = new CronExpr(schedule).nextRun(from);
  if (!next) throw new Error(`schedule "${schedule}" never fires`);
  return next.toISOString();
}

export function createCron(c: {
  name: string;
  schedule: string;
  prompt: string;
  repo: string;
  title?: string;
  worker_provider?: AgentProvider;
  model?: string;
  priority?: number;
  verify_cmd?: string;
  enabled?: boolean;
}): CronJob {
  const next = nextRun(c.schedule, new Date()); // validates too
  const info = getDb()
    .prepare(
      `INSERT INTO crons (name, schedule, title, prompt, repo, worker_provider, model, priority, verify_cmd, enabled, next_run_at)
       VALUES (@name, @schedule, @title, @prompt, @repo, @worker_provider, @model, @priority, @verify_cmd, @enabled, @next_run_at)`,
    )
    .run({
      name: c.name,
      schedule: c.schedule,
      title: c.title ?? c.name,
      prompt: c.prompt,
      repo: c.repo,
      worker_provider: parseAgentProvider(c.worker_provider, "claude"),
      model: c.model ?? null,
      priority: c.priority ?? 2,
      verify_cmd: c.verify_cmd ?? null,
      enabled: c.enabled === false ? 0 : 1,
      next_run_at: next,
    });
  return getCron(Number(info.lastInsertRowid))!;
}

export function getCron(id: number): CronJob | undefined {
  return getDb().prepare("SELECT * FROM crons WHERE id = ?").get(id) as
    | CronJob
    | undefined;
}

export function getCronByName(name: string): CronJob | undefined {
  return getDb().prepare("SELECT * FROM crons WHERE name = ?").get(name) as
    | CronJob
    | undefined;
}

export function listCrons(): CronJob[] {
  return getDb().prepare("SELECT * FROM crons ORDER BY id ASC").all() as CronJob[];
}

export function deleteCron(id: number): boolean {
  return getDb().prepare("DELETE FROM crons WHERE id = ?").run(id).changes === 1;
}

const UPDATABLE = new Set([
  "schedule",
  "title",
  "prompt",
  "repo",
  "worker_provider",
  "model",
  "priority",
  "verify_cmd",
  "enabled",
  "last_run_at",
  "next_run_at",
]);

export function updateCron(
  id: number,
  fields: Partial<Omit<CronJob, "id" | "name" | "created_at">>,
): CronJob | undefined {
  const patch: Record<string, unknown> = Object.fromEntries(
    Object.entries(fields).filter(([k]) => UPDATABLE.has(k)),
  );
  if (patch.schedule) {
    // validate + recompute so a bad expression can't be saved
    patch.next_run_at = nextRun(patch.schedule as string, new Date());
  } else if (patch.enabled === 1 || patch.enabled === true) {
    // re-enabling: schedule from now, not from a stale next_run_at
    const cron = getCron(id);
    if (cron) patch.next_run_at = nextRun(cron.schedule, new Date());
  }
  if (patch.worker_provider !== undefined) {
    patch.worker_provider = parseAgentProvider(patch.worker_provider);
  }
  if (patch.enabled !== undefined) patch.enabled = patch.enabled ? 1 : 0;
  const keys = Object.keys(patch);
  if (keys.length === 0) return getCron(id);
  const sets = keys.map((k) => `${k} = @${k}`).join(", ");
  getDb()
    .prepare(`UPDATE crons SET ${sets} WHERE id = @id`)
    .run({ id, ...patch });
  return getCron(id);
}

export function dueCrons(now: Date): CronJob[] {
  return getDb()
    .prepare(
      "SELECT * FROM crons WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY id ASC",
    )
    .all(now.toISOString()) as CronJob[];
}

/** Open (not done/failed) tasks previously enqueued by this cron. */
export function openTasksFor(cronId: number): number {
  const row = getDb()
    .prepare(
      "SELECT COUNT(*) AS n FROM tasks WHERE cron_id = ? AND status NOT IN ('done','failed')",
    )
    .get(cronId) as { n: number };
  return row.n;
}
