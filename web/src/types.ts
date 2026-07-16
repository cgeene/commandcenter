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
  pr_url: string | null;
  pr_feedback_at: string | null;
  pr_state: string | null; // open | merged | closed
  pr_checks: string | null; // pass | fail | pending | none
  pr_synced_at: string | null;
  pr_sync_fails: number;
  open_pr: number;
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
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
}

export type AttentionKind =
  | "merge_pr"
  | "merge_and_apply"
  | "decision"
  | "escalation"
  | "stale_waiting"
  | "orchestration";

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

export interface ParsedPane {
  target: string;
  pending_permission: PendingPermission | null;
  pending_question: string | null;
  unsubmitted_input: string | null;
  raw: string;
}

export interface SchedulerInfo {
  config: {
    enabled: boolean;
    max_concurrent: number;
    daily_spawn_limit: number;
    stall_minutes: number;
    active_hours: { start: number; end: number } | null;
  };
  status: { live_workers: number; spawns_today: number };
}
