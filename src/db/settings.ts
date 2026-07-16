import os from "node:os";
import { getDb } from "./db.js";
import {
  defaultMainModel,
  defaultReviewerProvider,
  defaultWorkerProvider,
  ntfyToken,
  ntfyUrl,
  reviewerVarietyEnabled,
  worktreesDir,
} from "../config.js";
import { type AgentProvider, isAgentProvider } from "../providers.js";

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
  /** Max automatic review⇄fix rounds before the loop escalates to the human.
   *  A round is one reviewer verdict; the loop re-reviews after every worker
   *  fix (and after a stale post-approval push) until a reviewer approves or
   *  review_cycles reaches this cap, at which point the task is blocked with a
   *  Needs-You item. */
  review_max_cycles: number;
  /** Minutes a worker may sit in waiting_input (after the main agent was asked to unblock it) before the human is paged. */
  escalate_minutes: number;
  /** Extra read-only permission patterns appended to the baked-in READ_ONLY_PROFILE
   *  (src/daemon/permissions.ts) for worker/reviewer settings.json — lets new
   *  read-only MCP tools/commands get allowlisted without a code change. Never
   *  put state-changing patterns here; this list is applied unconditionally. */
  read_only_extra_allow: string[];
  /** Minutes an agent may sit in waiting_input before the "Needs You" panel flags it as stale. */
  attention_stale_minutes: number;
  /** Minutes a worker on a TERMINAL task (done/cancelled/failed) may sit idle
   *  before the watchdog auto-reaps it (kills its tmux window, frees the
   *  max_concurrent slot). Grace covers a human reading the terminal right
   *  after completion. */
  reap_after_minutes: number;
}

export const SCHEDULER_DEFAULTS: SchedulerConfig = {
  enabled: false,
  max_concurrent: 3,
  daily_spawn_limit: 20,
  stall_minutes: 15,
  active_hours: null,
  auto_review: true,
  review_max_cycles: 4,
  escalate_minutes: 5,
  read_only_extra_allow: [],
  attention_stale_minutes: 10,
  reap_after_minutes: 10,
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

/* ------------------------------------------------------------------ *
 * Runtime settings that used to be env-only (src/config.ts).          *
 *                                                                     *
 * Each group stores ONLY explicit overrides; a null/absent field      *
 * means "no override — fall back to the env var, then the hardcoded    *
 * default". Resolution order is therefore: DB setting > env > default. *
 * The resolve* helpers below are the single read point for that order  *
 * and are what spawn/worktree/notify actually call.                   *
 * ------------------------------------------------------------------ */

function readGroup<T extends object>(key: string, defaults: T): T {
  const raw = getSetting(key);
  if (!raw) return { ...defaults };
  try {
    return { ...defaults, ...(JSON.parse(raw) as Partial<T>) };
  } catch {
    return { ...defaults };
  }
}

/** Agent-defaults settings. null = fall back to env/default. */
export interface AgentSettings {
  /** Default Claude model for the main orchestrator (overrides CC_MAIN_MODEL). */
  default_main_model: string | null;
  /** Default provider for autonomously-spawned workers (overrides CC_WORKER_PROVIDER). */
  default_worker_provider: AgentProvider | null;
  /** Pinned reviewer provider (overrides CC_REVIEWER_PROVIDER). null = no pin. */
  default_reviewer_provider: AgentProvider | null;
  /** Cross-model adversarial review toggle (overrides CC_REVIEWER_VARIETY). */
  reviewer_variety: boolean | null;
}

export const AGENT_SETTINGS_DEFAULTS: AgentSettings = {
  default_main_model: null,
  default_worker_provider: null,
  default_reviewer_provider: null,
  reviewer_variety: null,
};

export function getAgentSettings(): AgentSettings {
  return readGroup("agents", AGENT_SETTINGS_DEFAULTS);
}

export function setAgentSettings(patch: Partial<AgentSettings>): AgentSettings {
  const merged = { ...getAgentSettings(), ...patch };
  setSetting("agents", JSON.stringify(merged));
  return merged;
}

/** Workspace settings. null = fall back to env/default. */
export interface WorkspaceSettings {
  /** Base directory workers' git worktrees live under (overrides <dataDir>/worktrees). */
  worktrees_dir: string | null;
  /** Working directory the MAIN agent's terminal operates from (default: $HOME). */
  main_workspace_dir: string | null;
}

export const WORKSPACE_SETTINGS_DEFAULTS: WorkspaceSettings = {
  worktrees_dir: null,
  main_workspace_dir: null,
};

export function getWorkspaceSettings(): WorkspaceSettings {
  return readGroup("workspace", WORKSPACE_SETTINGS_DEFAULTS);
}

export function setWorkspaceSettings(
  patch: Partial<WorkspaceSettings>,
): WorkspaceSettings {
  const merged = { ...getWorkspaceSettings(), ...patch };
  setSetting("workspace", JSON.stringify(merged));
  return merged;
}

/** Notification settings. The ntfy token is a secret — it is stored here but
 *  MUST NEVER be returned in an API GET response (see api.ts). */
export interface NotificationSettings {
  /** ntfy topic URL (overrides CC_NTFY_URL). */
  ntfy_url: string | null;
  /** ntfy bearer token (overrides CC_NTFY_TOKEN). Secret — never serialized out. */
  ntfy_token: string | null;
}

export const NOTIFICATION_SETTINGS_DEFAULTS: NotificationSettings = {
  ntfy_url: null,
  ntfy_token: null,
};

export function getNotificationSettings(): NotificationSettings {
  return readGroup("notifications", NOTIFICATION_SETTINGS_DEFAULTS);
}

export function setNotificationSettings(
  patch: Partial<NotificationSettings>,
): NotificationSettings {
  const merged = { ...getNotificationSettings(), ...patch };
  setSetting("notifications", JSON.stringify(merged));
  return merged;
}

/**
 * JIRA integration behavior (§6). Secrets (base URL, email, token) live in env
 * only (src/config.ts jira*()) — NOTHING secret is ever stored here. This holds
 * the master switch, the per-repo opt-in + project mapping, the creation
 * classifier model, and the assignee mapping. Dormant in phase 1: stored/merged
 * but not yet read by any sync engine.
 */
export interface JiraRepoConfig {
  /** Opt-in per repo; default OFF. A repo mints tickets only once enabled. */
  enabled: boolean;
  /** Default (= deterministic fallback) JIRA project key, e.g. "EN". */
  project: string;
  /** Classifier allow-list of valid project keys; defaults to [project]. */
  projects?: string[];
  /** Classifier allow-list of issue type names, e.g. ["Task","Story","Bug"]; fallback "Task". */
  issue_types?: string[];
  /** Extra labels applied to created tickets (on top of "commandcenter"). */
  labels?: string[];
}

export interface JiraConfig {
  /** Master switch — default false (whole subsystem off until enabled). */
  enabled: boolean;
  /** Per-repo config, keyed by absolute repo path or "owner/name". Default OFF per repo. */
  repos: Record<string, JiraRepoConfig>;
  /** Ephemeral one-shot creation-classifier model (decision 7); a small model. */
  classifier_model?: string;
  /** Fallback assignee accountId when no per-identity mapping matches. */
  default_assignee_account_id?: string;
  /** identity → JIRA accountId mapping (§4.4). */
  assignee_map?: Record<string, string>;
}

export const JIRA_CONFIG_DEFAULTS: JiraConfig = {
  enabled: false,
  repos: {},
  classifier_model: "sonnet",
};

export function getJiraConfig(): JiraConfig {
  return readGroup("jira", JIRA_CONFIG_DEFAULTS);
}

export function setJiraConfig(patch: Partial<JiraConfig>): JiraConfig {
  const merged = { ...getJiraConfig(), ...patch };
  setSetting("jira", JSON.stringify(merged));
  return merged;
}

/** Absolute repo paths / "owner/name" keys that are JIRA-enabled right now.
 *  The config-derived gate tasksNeedingJiraCreate() consumes. Empty (and thus
 *  no candidates) whenever the master switch is off. */
export function jiraEnabledRepos(): string[] {
  const cfg = getJiraConfig();
  if (!cfg.enabled) return [];
  return Object.entries(cfg.repos)
    .filter(([, r]) => r?.enabled)
    .map(([repo]) => repo);
}

/* ---- resolvers: the DB > env > default read points ---- */

function coerceProvider(value: unknown): AgentProvider | undefined {
  return isAgentProvider(value) ? value : undefined;
}

/** Effective main-orchestrator model. Read at spawnMain time. */
export function resolveMainModel(): string {
  const stored = getAgentSettings().default_main_model?.trim();
  return stored || defaultMainModel();
}

/** Effective default worker provider. Read at worker-spawn time. */
export function resolveWorkerProvider(): AgentProvider {
  return coerceProvider(getAgentSettings().default_worker_provider) ?? defaultWorkerProvider();
}

/** Effective reviewer-provider pin. undefined = no pin (variety/Claude applies). */
export function resolveReviewerProviderPin(): AgentProvider | undefined {
  const stored = coerceProvider(getAgentSettings().default_reviewer_provider);
  if (stored) return stored;
  return coerceProvider(defaultReviewerProvider());
}

/** Effective cross-model review toggle. Read at reviewer-spawn time. */
export function resolveReviewerVariety(): boolean {
  const stored = getAgentSettings().reviewer_variety;
  return stored ?? reviewerVarietyEnabled();
}

/** Effective worktrees base dir. Read at worktree-create time. */
export function resolveWorktreesDir(): string {
  const stored = getWorkspaceSettings().worktrees_dir?.trim();
  return stored || worktreesDir();
}

/** Effective cwd for the main agent's terminal. Read at spawnMain time. */
export function resolveMainWorkspaceDir(): string {
  const stored = getWorkspaceSettings().main_workspace_dir?.trim();
  return stored || os.homedir();
}

/** Effective ntfy URL. Read at notify() time. */
export function resolveNtfyUrl(): string | undefined {
  const stored = getNotificationSettings().ntfy_url?.trim();
  return stored || ntfyUrl();
}

/** Effective ntfy token. Read at notify() time. Never serialize this out. */
export function resolveNtfyToken(): string | undefined {
  const stored = getNotificationSettings().ntfy_token?.trim();
  return stored || ntfyToken();
}
