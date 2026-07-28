/**
 * Response shaping for the "cc" MCP tools.
 *
 * Every task-touching tool used to echo the entire task row — prompt,
 * result_summary, review_notes and all — even when the caller only needed an
 * id and a status. The orchestrator's context is the scarcest resource on the
 * platform, so tool results default to a compact projection and callers opt
 * back into the full record with `verbose` (or ask for an exact `fields` set).
 *
 * The projections are ALLOW-lists: a column added to `tasks` later stays out of
 * compact output until someone deliberately adds it here.
 */

export const RESULT_SUMMARY_LIMIT = 400;
export const TRUNCATION_MARKER = "…[truncated, use verbose]";

/** Default projection for a single task (get_task, and every mutation echo). */
export const COMPACT_TASK_FIELDS = [
  "id",
  "title",
  "status",
  "priority",
  "repo",
  "workspace_kind",
  "dispatch_mode",
  "parent_task_id",
  "worker_provider",
  "model",
  // Same argument as worker_provider: triage has to preserve the effort a task
  // was created with, so it must survive the compact projection.
  "reasoning_effort",
  "agent_id",
  "branch",
  "blocked_by",
  "review_verdict",
  "review_cycles",
  // How deep the adversarial review goes. Small, and the orchestrator sets it
  // at triage, so it has to be readable without asking for verbose.
  "review_mode",
  "pr_url",
  "pr_state",
  "pr_checks",
  "pr_is_draft",
  // Whether this queued task has already been triaged. Small, and hiding it
  // from the agent whose own ack it records is what makes an already-triaged
  // queued task indistinguishable from a new one — a fresh or compacted
  // orchestrator would have to verbose-read every queued task to tell them
  // apart, and that read is itself the ack.
  "triaged_at",
  "tokens_used",
  "result_summary",
  "created_at",
  "updated_at",
] as const;

/** Extra-compact projection for list rows — a queue overview, not a record. */
export const TASK_ROW_FIELDS = [
  "id",
  "title",
  "status",
  "priority",
  "agent_id",
  "blocked_by",
  "pr_state",
  "review_verdict",
  // list_tasks(ready=true) is how the orchestrator finds work it may have
  // missed; without this it cannot see which of those it has already triaged.
  "triaged_at",
  "updated_at",
] as const;

/**
 * Human-publication state. Deliberately NOT in the compact core (most tasks are
 * agent-published and never look at it) — confirm_human_publication appends it
 * because it is the field that call changes.
 */
export const PUBLICATION_FIELDS = ["publication_mode", "publication_state"] as const;

/**
 * Fields never appended to a mutation echo, however the caller changed them:
 * they are exactly the bulk that compaction exists to keep out of the
 * orchestrator's context, and the caller just supplied the value anyway.
 * result_summary needs no entry — it is in the core and always truncated.
 */
export const BULKY_FIELDS = ["prompt", "review_notes"] as const;

/**
 * Which of the fields a mutation changed should be appended to its compact
 * echo. Confirming a field outside the core (verify_cmd, review_mode, …)
 * actually landed is worth a few tokens; replaying a 100k-character prompt is
 * not.
 */
export function echoedFields(changed: readonly string[]): string[] {
  return changed.filter((f) => !(BULKY_FIELDS as readonly string[]).includes(f));
}

export interface ShapeOptions {
  /** Return the untouched record (previous behavior). */
  verbose?: boolean;
  /** Exact field projection; wins over verbose. `id` is always kept. */
  fields?: string[];
}

type Record_ = Record<string, unknown>;

function isRecord(value: unknown): value is Record_ {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pick(record: Record_, keys: readonly string[]): Record_ {
  const out: Record_ = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) out[key] = record[key];
  }
  return out;
}

/** Trim a long result_summary down to a readable head plus an opt-in hint. */
export function truncateSummary(value: unknown): unknown {
  if (typeof value !== "string" || value.length <= RESULT_SUMMARY_LIMIT) return value;
  return value.slice(0, RESULT_SUMMARY_LIMIT) + TRUNCATION_MARKER;
}

/**
 * Default single-task shape: core fields only, result_summary truncated.
 * `extraFields` lets a mutation echo the specific column it just changed.
 */
export function compactTask(task: unknown, extraFields: readonly string[] = []): unknown {
  if (!isRecord(task)) return task;
  const out = pick(task, [...COMPACT_TASK_FIELDS, ...extraFields]);
  if ("result_summary" in out) out.result_summary = truncateSummary(out.result_summary);
  return out;
}

/** Default list-row shape. */
export function taskRow(task: unknown): unknown {
  return isRecord(task) ? pick(task, TASK_ROW_FIELDS) : task;
}

/**
 * Exact projection. Unknown field names are dropped rather than emitted as
 * nulls; `id` is always included so the result stays actionable.
 */
export function projectTask(task: unknown, fields: string[]): unknown {
  if (!isRecord(task)) return task;
  return pick(task, ["id", ...fields.filter((f) => f !== "id")]);
}

/** Shape one task per the caller's options (fields > verbose > compact). */
export function shapeTask(task: unknown, opts: ShapeOptions = {}): unknown {
  if (opts.fields && opts.fields.length > 0) return projectTask(task, opts.fields);
  if (opts.verbose) return task;
  return compactTask(task);
}

/** Shape a list of tasks; the default here is the extra-compact row. */
export function shapeTaskList(tasks: unknown, opts: ShapeOptions = {}): unknown {
  if (!Array.isArray(tasks)) return tasks;
  if (opts.fields && opts.fields.length > 0)
    return tasks.map((t) => projectTask(t, opts.fields!));
  if (opts.verbose) return tasks;
  return tasks.map(taskRow);
}

/**
 * Shape a payload that wraps a task alongside other data — `{agent, task}` from
 * the spawn endpoints, `{task, killed_agents, open_dependents}` from cancel.
 * Non-task members are passed through untouched (the agent record is small);
 * a nested task list is reduced to rows.
 */
export function shapeTaskPayload(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  const out: Record_ = { ...payload };
  if ("task" in out) out.task = compactTask(out.task);
  if (Array.isArray(out.open_dependents)) out.open_dependents = out.open_dependents.map(taskRow);
  return out;
}
