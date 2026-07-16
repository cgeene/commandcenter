import { getDb, type AgentState } from "./db.js";
import { parseAgentProvider, type AgentProvider } from "../providers.js";
import type { ReasoningEffort } from "../reasoning.js";

export interface Agent {
  id: number;
  kind: "main" | "worker" | "reviewer";
  provider: AgentProvider;
  model: string | null;
  reasoning_effort: ReasoningEffort | null;
  state: AgentState;
  task_id: number | null;
  tmux_target: string | null;
  session_id: string | null;
  transcript_path: string | null;
  runtime_config_path: string | null;
  last_event_at: string | null;
  spawned_at: string;
}

export function createAgent(a: {
  kind?: "main" | "worker" | "reviewer";
  provider?: AgentProvider;
  model?: string;
  reasoning_effort?: ReasoningEffort;
  state?: AgentState;
  task_id?: number;
  tmux_target?: string;
  runtime_config_path?: string;
}): Agent {
  const info = getDb()
    .prepare(
      `INSERT INTO agents (kind, provider, model, reasoning_effort, state, task_id, tmux_target, runtime_config_path)
       VALUES (@kind, @provider, @model, @reasoning_effort, @state, @task_id, @tmux_target, @runtime_config_path)`,
    )
    .run({
      kind: a.kind ?? "worker",
      provider: parseAgentProvider(a.provider, "claude"),
      model: a.model ?? null,
      reasoning_effort: a.reasoning_effort ?? null,
      state: a.state ?? "spawning",
      task_id: a.task_id ?? null,
      tmux_target: a.tmux_target ?? null,
      runtime_config_path: a.runtime_config_path ?? null,
    });
  return getAgent(Number(info.lastInsertRowid))!;
}

export function getAgent(id: number): Agent | undefined {
  return getDb().prepare("SELECT * FROM agents WHERE id = ?").get(id) as
    | Agent
    | undefined;
}

export function listAgents(opts?: { live?: boolean }): Agent[] {
  if (opts?.live) {
    return getDb()
      .prepare("SELECT * FROM agents WHERE state != 'dead' ORDER BY id ASC")
      .all() as Agent[];
  }
  return getDb().prepare("SELECT * FROM agents ORDER BY id ASC").all() as Agent[];
}

export function updateAgent(
  id: number,
  fields: Partial<
    Pick<
      Agent,
      | "state"
      | "task_id"
      | "tmux_target"
      | "session_id"
      | "transcript_path"
      | "runtime_config_path"
      | "last_event_at"
    >
  >,
): Agent | undefined {
  const keys = Object.keys(fields);
  if (keys.length === 0) return getAgent(id);
  const sets = keys.map((k) => `${k} = @${k}`).join(", ");
  getDb()
    .prepare(`UPDATE agents SET ${sets} WHERE id = @id`)
    .run({ id, ...fields });
  return getAgent(id);
}
