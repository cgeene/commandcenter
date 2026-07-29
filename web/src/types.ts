export type TaskStatus =
  | "queued"
  | "claimed"
  | "in_progress"
  | "blocked"
  | "review"
  | "done"
  | "failed"
  | "cancelled";

export type AgentProvider = "claude" | "codex";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type WorkspaceKind = "repo" | "portfolio" | "scratch";
export type DispatchMode = "direct" | "orchestrated";
export type PublicationMode = "agent" | "human";
export type PublicationState =
  | "editing"
  | "reviewing"
  | "awaiting_human"
  | "published";

export interface ProviderModel {
  slug: string;
  display_name: string;
  description: string;
  reasoning_levels: Array<{ effort: ReasoningEffort; description: string }>;
}

export interface Task {
  id: number;
  title: string;
  prompt: string;
  repo: string;
  workspace_kind: WorkspaceKind;
  dispatch_mode: DispatchMode;
  parent_task_id: number | null;
  status: TaskStatus;
  priority: number;
  worker_provider: AgentProvider;
  model: string | null;
  reasoning_effort: ReasoningEffort | null;
  blocked_by: number | null;
  agent_id: number | null;
  worktree: string | null;
  branch: string | null;
  session_id: string | null;
  session_provider: AgentProvider | null;
  verify_cmd: string | null;
  result_summary: string | null;
  review_verdict: string | null;
  review_notes: string | null;
  review_cycles: number;
  review_mode: "full" | "light"; // 'light' = diff-scoped review (docs/thresholds/runbooks)
  pr_url: string | null;
  pr_feedback_at: string | null;
  pr_state: string | null; // open | merged | closed
  pr_checks: string | null; // pass | fail | pending | none
  pr_is_draft: number | null; // 1 draft (internal review pending), 0 ready, NULL unknown
  pr_synced_at: string | null;
  pr_sync_fails: number;
  jira_key: string | null; // JIRA issue key, e.g. "EN-1234"; null = no ticket yet
  jira_state: string | null; // cached JIRA status name, lowercased
  jira_status_category: string | null; // new | indeterminate | done (workflow-independent)
  jira_synced_at: string | null;
  jira_sync_fails: number; // consecutive jirasync failures; warns at 3
  jira_project: string | null; // resolved (or per-task override) JIRA project key
  open_pr: number;
  auto_review: number;
  publication_mode: PublicationMode;
  publication_state: PublicationState | null;
  review_snapshot_base: string | null;
  review_snapshot_tree: string | null;
  tokens_used: number | null;
  created_at: string;
  updated_at: string;
}

export interface Agent {
  id: number;
  kind: "main" | "worker" | "reviewer";
  provider: AgentProvider;
  model: string | null;
  reasoning_effort: ReasoningEffort | null;
  state: string;
  task_id: number | null;
  tmux_target: string | null;
  session_id: string | null;
  transcript_path: string | null;
  runtime_config_path: string | null;
  last_event_at: string | null;
  spawned_at: string;
}

export interface TaskSession {
  agent_id: number | null;
  provider: AgentProvider;
  model: string | null;
  reasoning_effort: ReasoningEffort | null;
  session_id: string;
  transcript_path: string | null;
  cwd: string | null;
  resume_command: string;
}

export interface Event {
  id: number;
  ts: string;
  agent_id: number | null;
  task_id: number | null;
  kind: string;
  payload: string | null;
  /** Present when fetched with ?narrated=true — a human-readable one-liner. */
  narrative?: string;
}

export interface TranscriptEntry {
  role: "user" | "assistant" | "tool";
  text: string;
}

export interface Memory {
  id: number;
  text: string;
  tags: string | null;
  task_id: number | null;
  agent_id: number | null;
  use_count: number;
  last_used_at: string | null;
  created_at: string;
}

export interface Doc {
  id: number;
  slug: string;
  project: string;
  title: string;
  tags: string | null;
  task_id: number | null;
  agent_id: number | null;
  summary: string | null;
  file_path: string;
  /** JSON array of sidecar file paths (relative to the docs root), or null. */
  attachments: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface DocWithContent extends Doc {
  content: string;
}

export interface CronJob {
  id: number;
  name: string;
  schedule: string;
  title: string;
  prompt: string;
  repo: string;
  worker_provider: AgentProvider;
  model: string | null;
  reasoning_effort: ReasoningEffort | null;
  priority: number;
  verify_cmd: string | null;
  open_pr: number;
  auto_review: number;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
}

export type AttentionKind =
  | "publish_task"
  | "merge_pr"
  | "merge_and_apply"
  | "decision"
  | "stalled_transition"
  | "escalation"
  | "stale_waiting"
  | "scheduler_stalled"
  | "orchestration"
  | "jira_sync"
  | "quota";

export interface JiraMeta {
  base_url: string;
  enabled_repos: string[];
}

export interface WorkspaceCatalog {
  roots: Array<{ path: string; label: string }>;
  repositories: Array<{
    path: string;
    name: string;
    relative_path: string;
    root: string;
  }>;
  scratch_retention_days: number;
}

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  title: string;
  context: string;
  severity: "red" | "orange" | "yellow";
  urgent: boolean;
  task_id: number | null;
  agent_id: number | null;
  pr_url: string | null;
  created_at: string;
  age_ms: number;
}

export interface PaneOption {
  n: number;
  label: string;
}

export interface PendingPermission {
  question: string;
  options: PaneOption[];
}

export interface BackgroundActivity {
  shells: number;
  monitors: number;
}

export interface ParsedPane {
  target: string;
  pending_permission: PendingPermission | null;
  pending_question: string | null;
  unsubmitted_input: string | null;
  /** Whether the input line itself was located. `unsubmitted_input === null`
   *  with this false means "composer not found", not "composer empty". */
  composer_found: boolean;
  background_activity: BackgroundActivity | null;
  raw: string;
}

export interface SchedulerConfig {
  enabled: boolean;
  max_concurrent: number;
  daily_spawn_limit: number;
  verify_concurrency: number;
  stall_minutes: number;
  active_hours: { start: number; end: number } | null;
  auto_review: boolean;
  review_max_cycles: number;
  escalate_minutes: number;
  read_only_extra_allow: string[];
  attention_stale_minutes: number;
  reap_after_minutes: number;
}

export interface SchedulerInfo {
  config: SchedulerConfig;
  status: {
    /** workers occupying a slot — comparable to max_concurrent */
    live_workers: number;
    /** live workers parked under a running reviewer; exempt from the cap */
    parked_workers?: number;
    spawns_today: number;
  };
}

/* ---- spend / quota ---- */

export interface UsageMeter {
  key: string;
  label: string;
  percent: number | null;
  resets_at: string | null;
  severity: string | null;
  used_usd: number | null;
  limit_usd: number | null;
}

export interface LiveUsage {
  fetched_at: string;
  source: "claude-code-oauth" | "anthropic-admin-api";
  meters: UsageMeter[];
  headline: UsageMeter | null;
  spend: {
    used_usd: number;
    limit_usd: number | null;
    percent: number | null;
    enabled: boolean;
    limit_reached: boolean;
    disabled_reason: string | null;
  } | null;
  plan: string | null;
}

export interface DaySpend {
  day: string;
  tokens: number;
  cost_usd: number;
  unpriced_tokens: number;
}

export interface ModelSpend {
  model: string;
  tokens: number;
  cost_usd: number;
  priced: boolean;
}

export interface LocalBurnWindow {
  days: DaySpend[];
  cost_usd: number;
  tokens: number;
  by_model: ModelSpend[];
}

/** GET /api/usage — every spend source at once, each labelled with its origin
 *  so the UI never presents an estimate as billing truth. */
export interface UsagePayload {
  live: { usage: LiveUsage | null; error: string | null; checked_at: string | null };
  org: {
    total_usd: number | null;
    days: Record<string, number>;
    cycle_start: string | null;
    fetched_at: string | null;
    error: string | null;
  };
  local: {
    cycle: LocalBurnWindow & {
      start: string;
      end: string;
      days_total: number;
      days_elapsed: number;
    };
    all_time: LocalBurnWindow;
    tracked_since: string | null;
  };
  quota: { monthly_quota_usd: number | null; cycle_reset_day: number };
}

/** Runtime settings surfaced by the Settings tab (GET /api/settings).
 *  `stored` holds explicit overrides (null = unset → env/default fallback);
 *  `effective` is the resolved value actually in use. Both ntfy credentials are
 *  secrets — a topic URL is publish capability — so only their presence
 *  (`ntfy_token_set`, `effective.ntfy_url_set`) crosses the boundary. */
export interface AppSettings {
  agents: {
    stored: {
      default_main_model: string | null;
      default_worker_provider: AgentProvider | null;
      default_reviewer_provider: AgentProvider | null;
      reviewer_variety: boolean | null;
      worker_publication_mode: PublicationMode | null;
    };
    effective: {
      default_main_model: string;
      default_worker_provider: AgentProvider;
      default_reviewer_provider: AgentProvider | null;
      reviewer_variety: boolean;
      worker_publication_mode: PublicationMode;
    };
  };
  workspace: {
    stored: {
      worktrees_dir: string | null;
      main_workspace_dir: string | null;
    };
    effective: {
      worktrees_dir: string;
      main_workspace_dir: string;
    };
  };
  notifications: {
    /** `events` holds ONLY explicit per-event overrides; a key that is absent
     *  follows the built-in default from `notify_event_choices`. */
    stored: { ntfy_url: string | null; events: Record<string, boolean> };
    ntfy_token_set: boolean;
    effective: { ntfy_url_set: boolean; events: Record<string, boolean> };
  };
  quota: {
    stored: {
      monthly_quota_usd: number | null;
      cycle_reset_day: number;
      alert_threshold_percent: number | null;
    };
    /** Derived from CC_ANTHROPIC_ADMIN_KEY — the key itself never crosses. */
    admin_key_set: boolean;
    /** Whether the daemon was opted into reading Claude Code's stored OAuth
     *  credential (CC_LIVE_USAGE=1). Off unless explicitly enabled. */
    live_usage_enabled: boolean;
  };
  /** PR-integration behavior. No `effective` twin: every field is read
   *  directly, with no env-var fallback layer behind it. */
  integration: {
    stored: {
      auto_freshen: boolean;
      freshen_max_attempts: number;
      freshen_per_pass_limit: number;
      /** Absolute repo paths allowed only one active task at a time. Opt-in. */
      strict_serial_repos: string[];
      /** null = the merge-latency nudge is off. */
      merge_nudge_minutes: number | null;
    };
  };
  jira: {
    stored: JiraConfig;
    // Derived from CC_JIRA_TOKEN presence — the token value NEVER crosses the
    // boundary. base_url/email are non-secret env config for the UI banner/links.
    token_set: boolean;
    base_url: string;
    email: string | null;
  };
  model_choices: string[];
  provider_choices: AgentProvider[];
  /** The push-notification catalog (src/notify-events.ts), in display order. */
  notify_event_choices: NotifyEventSpec[];
  notify_category_choices: NotifyCategorySpec[];
}

/** One switchable push event. Mirrors the daemon's NotifyEventSpec. */
export interface NotifyEventSpec {
  key: string;
  category: string;
  label: string;
  description: string;
  default_enabled: boolean;
}

export interface NotifyCategorySpec {
  key: string;
  label: string;
  blurb: string;
}

/** Per-repo JIRA config (opt-in, default OFF). Mirrors the daemon JiraRepoConfig. */
export interface JiraRepoConfig {
  enabled: boolean;
  /** Default (= deterministic fallback) project key, e.g. "EN". */
  project: string;
  /** Classifier allow-list of valid project keys; defaults to [project]. */
  projects?: string[];
  /** Classifier allow-list of issue type names; fallback "Task". */
  issue_types?: string[];
  /** Extra labels on created tickets (on top of "commandcenter"). */
  labels?: string[];
}

/** JIRA behavior config (secrets are env-only, never here). Mirrors JiraConfig. */
export interface JiraConfig {
  enabled: boolean;
  repos: Record<string, JiraRepoConfig>;
  classifier_model?: string;
  default_assignee_account_id?: string;
  assignee_map?: Record<string, string>;
}
