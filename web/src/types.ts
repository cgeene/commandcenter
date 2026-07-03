export type TaskStatus =
  | "queued"
  | "claimed"
  | "in_progress"
  | "blocked"
  | "review"
  | "done"
  | "failed";

export interface Task {
  id: number;
  title: string;
  prompt: string;
  repo: string;
  status: TaskStatus;
  priority: number;
  model: string | null;
  blocked_by: number | null;
  agent_id: number | null;
  worktree: string | null;
  branch: string | null;
  session_id: string | null;
  verify_cmd: string | null;
  result_summary: string | null;
  created_at: string;
  updated_at: string;
}

export interface Agent {
  id: number;
  kind: "main" | "worker";
  model: string | null;
  state: string;
  task_id: number | null;
  tmux_target: string | null;
  session_id: string | null;
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
}

export interface TranscriptEntry {
  role: "user" | "assistant" | "tool";
  text: string;
}
