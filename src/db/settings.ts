import { getDb } from "./db.js";

export interface SchedulerConfig {
  /** Master switch — the dashboard kill switch flips this. */
  enabled: boolean;
  /** Max live workers the scheduler will maintain (manual spawns not counted against it, but they occupy slots). */
  max_concurrent: number;
  /** Autonomous spawns allowed per UTC day — the budget backstop. */
  daily_spawn_limit: number;
  /** Minutes without any hook event before a working agent is marked stalled. */
  stall_minutes: number;
  /** Only auto-spawn inside this window (hours, local time); null = always. start > end wraps overnight (e.g. 22 -> 6). */
  active_hours: { start: number; end: number } | null;
  /** Auto-spawn an adversarial reviewer when a task reaches review. */
  auto_review: boolean;
  /** Minutes a worker may sit in waiting_input (after the main agent was asked to unblock it) before the human is paged. */
  escalate_minutes: number;
  /** Extra read-only permission patterns appended to the baked-in READ_ONLY_PROFILE
   *  (src/daemon/permissions.ts) for worker/reviewer settings.json — lets new
   *  read-only MCP tools/commands get allowlisted without a code change. Never
   *  put state-changing patterns here; this list is applied unconditionally. */
  read_only_extra_allow: string[];
  /** Minutes an agent may sit in waiting_input before the "Needs You" panel flags it as stale. */
  attention_stale_minutes: number;
}

export const SCHEDULER_DEFAULTS: SchedulerConfig = {
  enabled: false,
  max_concurrent: 3,
  daily_spawn_limit: 20,
  stall_minutes: 15,
  active_hours: null,
  auto_review: true,
  escalate_minutes: 5,
  read_only_extra_allow: [],
  attention_stale_minutes: 10,
};

function getSetting(key: string): string | undefined {
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value;
}

function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
}

export function getSchedulerConfig(): SchedulerConfig {
  const raw = getSetting("scheduler");
  if (!raw) return { ...SCHEDULER_DEFAULTS };
  try {
    return { ...SCHEDULER_DEFAULTS, ...(JSON.parse(raw) as Partial<SchedulerConfig>) };
  } catch {
    return { ...SCHEDULER_DEFAULTS };
  }
}

export function setSchedulerConfig(
  patch: Partial<SchedulerConfig>,
): SchedulerConfig {
  const merged = { ...getSchedulerConfig(), ...patch };
  setSetting("scheduler", JSON.stringify(merged));
  return merged;
}
