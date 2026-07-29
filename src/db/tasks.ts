import { getDb, type TaskStatus, TASK_STATUSES } from "./db.js";
import { logEvent } from "./events.js";
import { parseAgentProvider, type AgentProvider } from "../providers.js";
import {
  reasoningEffortForProvider,
  type ReasoningEffort,
} from "../reasoning.js";
import {
  isPublicationMode,
  isPublicationState,
  type PublicationMode,
  type PublicationState,
} from "../publication.js";
import { resolveWorkerPublicationMode } from "./settings.js";
import { BlockerValidationError, blockerChainReaches } from "../lib/blockers.js";

export const WORKSPACE_KINDS = ["repo", "portfolio", "scratch"] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];
export const DISPATCH_MODES = ["direct", "orchestrated"] as const;
export type DispatchMode = (typeof DISPATCH_MODES)[number];
/** How hard the adversarial reviewer works on this task. 'full' re-verifies
 *  everything independently; 'light' is a diff-scoped read for doc/threshold/
 *  runbook work. Chosen at triage, never inferred from the diff. */
export const REVIEW_MODES = ["full", "light"] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

/**
 * Why a task is in the `blocked` status, recorded by the path that blocked it.
 *
 * Consumers that decide whether a block may be LIFTED match on this rather than
 * inferring the cause from the newest of several event kinds: an inference over
 * an open-ended event set silently goes wrong the next time someone adds a
 * blocking path, and one of those decisions (review.blockedByReviewLoop) is a
 * merge-safety gate. A cause a consumer does not recognise — including NULL —
 * must mean "do not lift".
 *
 *  - verify_failed:          verify_cmd failed its whole nudge budget
 *  - review_loop:            the review⇄fix loop ran out of rounds
 *  - reviewer_unrecoverable: every replacement reviewer also died without a verdict
 *  - pr_closed:              the PR was closed without merging
 *  - spawn_failed:           the scheduler could not start a worker
 *  - reported:               blocked from outside the daemon — a worker's
 *                            report_blocked, or a human/orchestrator PATCH. The
 *                            reason is in result_summary, not knowable here.
 */
export const BLOCK_CAUSES = [
  "verify_failed",
  "review_loop",
  "reviewer_unrecoverable",
  "pr_closed",
  "spawn_failed",
  "reported",
] as const;
export type BlockCause = (typeof BLOCK_CAUSES)[number];

export interface Task {
  id: number;
  title: string;
  prompt: string;
  repo: string;
  workspace_kind: WorkspaceKind;
  dispatch_mode: DispatchMode;
  parent_task_id: number | null;
  status: TaskStatus;
  block_cause: BlockCause | null; // why it is blocked; NULL unless status === 'blocked' — see BLOCK_CAUSES
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
  review_mode: ReviewMode; // 'full' (default) | 'light' — see REVIEW_MODES
  review_head_sha: string | null; // branch HEAD SHA the last reviewer judged (NULL for scratch)
  review_result_hash: string | null; // hash of result_summary at that reviewer's spawn
  pr_url: string | null;
  pr_feedback_at: string | null;
  pr_state: string | null; // open | merged | closed (lowercased gh state)
  pr_checks: string | null; // CI rollup: pass | fail | pending | none
  pr_is_draft: number | null; // 1 draft (internal review pending), 0 ready, NULL unknown
  human_approved_at: string | null; // latest human GitHub approval (signal only, not a re-queue trigger)
  triaged_at: string | null; // orchestrator acked the triage ping by reading the full record; NULL = still needs triage
  pr_synced_at: string | null; // last successful prsync
  pr_sync_fails: number; // consecutive prsync failures; escalates at 3
  jira_key: string | null; // JIRA issue key, e.g. "EN-1234"; NULL = no ticket yet
  jira_state: string | null; // cached JIRA status name, lowercased (open | in progress | merged | done | will not do)
  jira_status_category: string | null; // cached status category: new | indeterminate | done
  jira_synced_at: string | null; // last successful jirasync
  jira_sync_fails: number; // consecutive jirasync failures; escalates at 3
  jira_project: string | null; // resolved (or per-task override) JIRA project key
  open_pr: number; // sqlite boolean, default 1
  auto_review: number; // sqlite boolean, default 1; 0 = skip the adversarial reviewer
  publication_mode: PublicationMode;
  publication_state: PublicationState | null;
  review_snapshot_base: string | null;
  review_snapshot_tree: string | null;
  tokens_used: number | null;
  cron_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface NewTask {
  title: string;
  prompt: string;
  repo: string;
  workspace_kind?: WorkspaceKind;
  dispatch_mode?: DispatchMode;
  parent_task_id?: number;
  priority?: number;
  worker_provider?: AgentProvider;
  model?: string;
  reasoning_effort?: ReasoningEffort;
  blocked_by?: number;
  verify_cmd?: string;
  cron_id?: number;
  open_pr?: boolean;
  auto_review?: boolean;
  publication_mode?: PublicationMode;
  review_mode?: ReviewMode;
}

function parseReviewMode(value: unknown, fallback: ReviewMode = "full"): ReviewMode {
  if (value === undefined || value === null) return fallback;
  if (!REVIEW_MODES.includes(value as ReviewMode)) {
    throw new Error(`invalid review mode: ${String(value)}`);
  }
  return value as ReviewMode;
}

/**
 * Reject a blocked_by assignment that would deadlock the ready queue.
 *
 * readyTasks() only releases a task once its blocker is 'done', so a task
 * blocked on itself — or on a chain that leads back to itself — waits forever
 * with nothing surfacing the reason. An unknown blocker id would otherwise fail
 * at the FK constraint with an opaque SQLite message, so it is caught here too.
 *
 * `taskId` is undefined at creation time (the row has no id yet), where only
 * the existence check applies: a brand-new task cannot be part of a cycle.
 */
export function assertBlockerAssignable(
  blockerId: number,
  taskId?: number,
): void {
  if (taskId !== undefined && blockerId === taskId) {
    throw new BlockerValidationError(`task #${taskId} cannot be blocked by itself`);
  }
  if (!getTask(blockerId)) {
    throw new BlockerValidationError(`blocker task #${blockerId} does not exist`);
  }
  if (
    taskId !== undefined &&
    blockerChainReaches(blockerId, taskId, (id) => getTask(id)?.blocked_by ?? null)
  ) {
    throw new BlockerValidationError(
      `blocking task #${taskId} on #${blockerId} would create a dependency cycle`,
    );
  }
}

export function createTask(t: NewTask): Task {
  const db = getDb();
  if (t.blocked_by != null) assertBlockerAssignable(t.blocked_by);
  const workerProvider = parseAgentProvider(t.worker_provider, "claude");
  const publicationMode =
    t.publication_mode ?? resolveWorkerPublicationMode();
  const info = db
    .prepare(
      `INSERT INTO tasks (title, prompt, repo, workspace_kind, dispatch_mode, parent_task_id, priority, worker_provider, model, reasoning_effort, blocked_by, verify_cmd, cron_id, open_pr, auto_review, review_mode, publication_mode, publication_state)
       VALUES (@title, @prompt, @repo, @workspace_kind, @dispatch_mode, @parent_task_id, @priority, @worker_provider, @model, @reasoning_effort, @blocked_by, @verify_cmd, @cron_id, @open_pr, @auto_review, @review_mode, @publication_mode, @publication_state)`,
    )
    .run({
      title: t.title,
      prompt: t.prompt,
      repo: t.repo,
      workspace_kind: t.workspace_kind ?? "repo",
      dispatch_mode: t.dispatch_mode ?? "direct",
      parent_task_id: t.parent_task_id ?? null,
      priority: t.priority ?? 2,
      worker_provider: workerProvider,
      model: t.model ?? null,
      reasoning_effort: reasoningEffortForProvider(workerProvider, t.reasoning_effort),
      blocked_by: t.blocked_by ?? null,
      verify_cmd: t.verify_cmd ?? null,
      cron_id: t.cron_id ?? null,
      open_pr: t.open_pr === false ? 0 : 1,
      auto_review: t.auto_review === false ? 0 : 1,
      review_mode: parseReviewMode(t.review_mode),
      publication_mode: publicationMode,
      publication_state:
        publicationMode === "human" &&
          (t.workspace_kind ?? "repo") === "repo"
          ? "editing"
          : null,
    });
  return getTask(Number(info.lastInsertRowid))!;
}

export function getTask(id: number): Task | undefined {
  return getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
    | Task
    | undefined;
}

export function listTasks(status?: TaskStatus): Task[] {
  const db = getDb();
  if (status) {
    return db
      .prepare(
        "SELECT * FROM tasks WHERE status = ? ORDER BY priority ASC, id ASC",
      )
      .all(status) as Task[];
  }
  return db
    .prepare(
      `SELECT * FROM tasks
       ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'claimed' THEN 1
                            WHEN 'queued' THEN 2 WHEN 'blocked' THEN 3
                            WHEN 'review' THEN 4 WHEN 'failed' THEN 5
                            WHEN 'cancelled' THEN 6 ELSE 7 END,
                priority ASC, id ASC`,
    )
    .all() as Task[];
}

/** Tasks that are queued and whose blocker (if any) is done. */
export function readyTasks(dispatchMode?: DispatchMode): Task[] {
  return getDb()
    .prepare(
      `SELECT t.* FROM tasks t
       LEFT JOIN tasks b ON t.blocked_by = b.id
       WHERE t.status = 'queued' AND (t.blocked_by IS NULL OR b.status = 'done')
         AND (@dispatch_mode IS NULL OR t.dispatch_mode = @dispatch_mode)
       ORDER BY t.priority ASC, t.id ASC`,
    )
    .all({ dispatch_mode: dispatchMode ?? null }) as Task[];
}

export function childTasks(parentTaskId: number): Task[] {
  return getDb()
    .prepare("SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY priority ASC, id ASC")
    .all(parentTaskId) as Task[];
}

/**
 * Tasks whose PR still needs polling: it has a pr_url, PR-opening is enabled
 * (open_pr != 0), and the cached pr_state is not yet terminal. A PR is terminal
 * once it is merged or closed — we never poll it again (that would burn gh
 * quota for a state that can't change). Crucially this is NOT scoped to
 * review-status tasks: a task can be done/cancelled while its PR is still open
 * (or was never synced), and its PR badge must still reflect reality. The
 * NULL check is explicit because `NULL NOT IN (...)` is NULL, not true, so a
 * never-synced row would otherwise be skipped.
 */
export function tasksNeedingPrSync(): Task[] {
  return getDb()
    .prepare(
      `SELECT * FROM tasks
       WHERE pr_url IS NOT NULL AND open_pr != 0
         AND (pr_state IS NULL OR pr_state NOT IN ('merged', 'closed'))
       ORDER BY id ASC`,
    )
    .all() as Task[];
}

/**
 * Tasks whose PR reached a terminal state (merged/closed) but whose lifecycle
 * consequence was never applied — they are still in 'review'. This is the
 * STATE-based candidate set for reconciliation (task #97): recording pr_state
 * and applying the consequence (auto-complete on merge, block on close) are
 * separate steps, and a daemon crash/restart between them strands the task. A
 * terminal pr_state drops the task out of tasksNeedingPrSync, so the normal
 * delta-driven poll never revisits it — only this query does. Because it keys
 * off current state (not an observed transition), a missed consequence
 * self-heals on the next pass.
 *
 * The merged case mirrors applyPrState's guard exactly, so every returned task
 * actually transitions: it excludes the deliberate-human-merge-of-a-rejected-PR
 * override (reject verdict or exhausted review cycles), which applyPrState
 * intentionally parks in 'review' for a human. Re-selecting those every pass
 * would spam pr.merged; they are parked, not stranded. Closed PRs always block
 * regardless of verdict, so no such exclusion applies there.
 */
export function tasksNeedingPrReconcile(maxReviewCycles: number): Task[] {
  return getDb()
    .prepare(
      `SELECT * FROM tasks
       WHERE status = 'review' AND pr_url IS NOT NULL AND open_pr != 0
         AND (
           pr_state = 'closed'
           OR (pr_state = 'merged'
               AND (review_verdict IS NULL OR review_verdict != 'reject')
               AND review_cycles < @maxReviewCycles)
         )
       ORDER BY id ASC`,
    )
    .all({ maxReviewCycles }) as Task[];
}

/**
 * Tasks whose existing JIRA ticket still needs polling: jira_key is set and the
 * cached status is not yet terminal. Terminal states — the "done" / "will not
 * do" status names AND anything in the "done" status *category* — drop out so
 * they are never re-polled (saving JIRA API quota), the direct analogue of
 * merged/closed PRs dropping out of tasksNeedingPrSync. Both NULL checks are
 * explicit and deliberate (task #38 lesson): `NULL NOT IN (...)` / `NULL != ...`
 * evaluate to NULL, not true, so a just-created ticket whose status hasn't been
 * fetched yet (jira_state / jira_status_category still NULL) would otherwise be
 * silently skipped and never synced.
 *
 * Ticket CREATION is a separate query (tasksNeedingJiraCreate) — this only syncs
 * tickets that already exist.
 */
export function tasksNeedingJiraSync(): Task[] {
  return getDb()
    .prepare(
      `SELECT * FROM tasks
       WHERE jira_key IS NOT NULL
         AND (jira_state IS NULL OR jira_state NOT IN ('done', 'will not do'))
         AND (jira_status_category IS NULL OR jira_status_category != 'done')
       ORDER BY id ASC`,
    )
    .all() as Task[];
}

/**
 * Tasks that need a JIRA ticket created: they have a PR (pr_url set and
 * PR-opening enabled via open_pr != 0 — the iff-PR rule enforced at the query
 * level, so doc-only tasks are structurally excluded), don't yet have a ticket
 * (jira_key IS NULL — the idempotency guard, so a task never re-enters the
 * create path once its key is recorded), live in a JIRA-enabled repo, and are
 * not cancelled/failed. `enabledRepos` is the config-derived opt-in gate
 * (JiraConfig, §6); an empty list means no repo is enabled, so there are no
 * candidates. Repos are bound as parameters (never interpolated) so the gate is
 * injection-safe.
 */
export function tasksNeedingJiraCreate(enabledRepos: string[]): Task[] {
  if (enabledRepos.length === 0) return [];
  const placeholders = enabledRepos.map(() => "?").join(", ");
  return getDb()
    .prepare(
      `SELECT * FROM tasks
       WHERE pr_url IS NOT NULL AND open_pr != 0
         AND jira_key IS NULL
         AND repo IN (${placeholders})
         AND status NOT IN ('cancelled', 'failed')
       ORDER BY id ASC`,
    )
    .all(...enabledRepos) as Task[];
}

/** Open tasks waiting on `taskId` via blocked_by. A cancelled blocker never
 *  becomes 'done', so these stay stuck unless the human re-points them. */
export function openDependents(taskId: number): Task[] {
  return getDb()
    .prepare(
      `SELECT * FROM tasks WHERE blocked_by = ?
       AND status NOT IN ('done','failed','cancelled') ORDER BY id ASC`,
    )
    .all(taskId) as Task[];
}

/**
 * Atomically claim a queued task. Returns the task if this caller won the
 * claim, undefined if the task was not claimable (already claimed, missing,
 * or not queued). This single UPDATE is the concurrency guarantee: two
 * agents can never both claim the same task.
 */
export function claimTask(id: number, agentId?: number): Task | undefined {
  const info = getDb()
    .prepare(
      `UPDATE tasks
       SET status = 'claimed', agent_id = @agentId,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = @id AND status = 'queued'`,
    )
    .run({ id, agentId: agentId ?? null });
  return info.changes === 1 ? getTask(id) : undefined;
}

/**
 * Record that the orchestrator has triaged a queued task, so the triage
 * delivery path stops re-pinging it about a task it has already read.
 *
 * Conditional in SQL rather than in the caller: only a queued, orchestrated
 * task is awaiting triage at all, and only the FIRST ack matters (a later
 * re-read must not push the stamp forward and hide an edit made in between).
 * Returns the stamped task, or undefined when nothing was stamped.
 */
export function markTaskTriaged(id: number): Task | undefined {
  const info = getDb()
    .prepare(
      `UPDATE tasks
          SET triaged_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = @id AND status = 'queued' AND dispatch_mode = 'orchestrated'
          AND triaged_at IS NULL`,
    )
    .run({ id });
  return info.changes === 1 ? getTask(id) : undefined;
}

/** Drop a task's triage ack so it is delivered for triage again. Used for an
 *  explicit re-flag (the manual "notify main" route); ordinary re-queues and
 *  prompt/repo edits are handled inside updateTask. */
export function clearTaskTriageAck(id: number): boolean {
  return (
    getDb()
      .prepare("UPDATE tasks SET triaged_at = NULL WHERE id = ? AND triaged_at IS NOT NULL")
      .run(id).changes === 1
  );
}

/**
 * The block_cause write implied by a status change, or null for "leave the
 * column alone". Deliberately derived from the status transition rather than
 * copied from the caller's field list — that is what makes the invariant
 * "block_cause is non-NULL exactly while status === 'blocked'" hold for every
 * blocking path, including ones added later.
 *
 * FIRST WRITE WINS while the task stays blocked. A path that blocks an
 * already-blocked task must not relabel it: a rejection hitting the review
 * cycle cap re-blocks a task a failing verify_cmd already blocked, and
 * relabelling that to `review_loop` would make it look like a block a
 * reviewer's approve is entitled to lift (review.blockedByReviewLoop).
 *
 * block_cause is not in UPDATABLE, so it is never bound from `fields` directly
 * and an API PATCH cannot set it. Passing it without a status is a no-op.
 */
function blockCauseWrite(
  id: number,
  fields: Partial<Omit<Task, "id" | "created_at" | "updated_at">>,
): BlockCause | null | undefined {
  if (fields.status === undefined) return undefined;
  if (fields.status !== "blocked") return null; // leaving blocked clears the cause
  if (getTask(id)?.status === "blocked") return undefined; // first write wins
  const cause = fields.block_cause ?? "reported";
  if (!BLOCK_CAUSES.includes(cause)) {
    throw new Error(`invalid block cause: ${String(cause)}`);
  }
  return cause;
}

const UPDATABLE = new Set([
  "title",
  "prompt",
  "repo",
  "status",
  "priority",
  "worker_provider",
  "model",
  "reasoning_effort",
  "blocked_by",
  "agent_id",
  "worktree",
  "branch",
  "session_id",
  "session_provider",
  "verify_cmd",
  "result_summary",
  "review_verdict",
  "review_notes",
  "review_cycles",
  "review_mode",
  "review_head_sha",
  "review_result_hash",
  "pr_url",
  "pr_feedback_at",
  "pr_state",
  "pr_checks",
  "pr_is_draft",
  "human_approved_at",
  "pr_synced_at",
  "pr_sync_fails",
  "jira_key",
  "jira_state",
  "jira_status_category",
  "jira_synced_at",
  "jira_sync_fails",
  "jira_project",
  "open_pr",
  "publication_mode",
  "publication_state",
  "review_snapshot_base",
  "review_snapshot_tree",
  "tokens_used",
  "workspace_kind",
  "dispatch_mode",
  "parent_task_id",
]);

export function updateTask(
  id: number,
  fields: Partial<Omit<Task, "id" | "created_at" | "updated_at">>,
): Task | undefined {
  const keys = Object.keys(fields).filter((k) => UPDATABLE.has(k));
  if (keys.length === 0) return getTask(id);
  if (fields.status && !TASK_STATUSES.includes(fields.status)) {
    throw new Error(`invalid status: ${fields.status}`);
  }
  if (fields.worker_provider !== undefined) {
    parseAgentProvider(fields.worker_provider);
  }
  if (fields.session_provider !== undefined && fields.session_provider !== null) {
    parseAgentProvider(fields.session_provider);
  }
  if (
    fields.workspace_kind !== undefined &&
    !WORKSPACE_KINDS.includes(fields.workspace_kind)
  ) {
    throw new Error(`invalid workspace kind: ${fields.workspace_kind}`);
  }
  if (
    fields.dispatch_mode !== undefined &&
    !DISPATCH_MODES.includes(fields.dispatch_mode)
  ) {
    throw new Error(`invalid dispatch mode: ${fields.dispatch_mode}`);
  }
  if (
    fields.publication_mode !== undefined &&
    !isPublicationMode(fields.publication_mode)
  ) {
    throw new Error(`invalid publication mode: ${fields.publication_mode}`);
  }
  if (
    fields.publication_state !== undefined &&
    fields.publication_state !== null &&
    !isPublicationState(fields.publication_state)
  ) {
    throw new Error(`invalid publication state: ${fields.publication_state}`);
  }
  // review_mode is NOT NULL in SQLite: a null here would fail the constraint
  // at write time, so reject it (and any unknown value) up front.
  if (fields.review_mode !== undefined && !REVIEW_MODES.includes(fields.review_mode)) {
    throw new Error(`invalid review mode: ${String(fields.review_mode)}`);
  }
  // blocked_by: null clears the dependency; any other value must point at a
  // real task that is not this one and whose own chain does not lead back here.
  if (fields.blocked_by != null) {
    assertBlockerAssignable(fields.blocked_by, id);
  }
  // A task that re-enters the queue, or whose prompt/repo changed, is no longer
  // the task the orchestrator triaged: drop the ack here — the single choke
  // point every re-queue path (review rejection, PR feedback, archived resume,
  // the stale-agent sweep) already writes through — so it gets delivered for
  // triage again. Cosmetic edits (priority, review_mode, …) keep the ack.
  const invalidatesTriage =
    fields.status === "queued" ||
    fields.prompt !== undefined ||
    fields.repo !== undefined;
  const priorAck = invalidatesTriage ? getTask(id)?.triaged_at : undefined;
  const params: Record<string, unknown> = { id };
  for (const k of keys) params[k] = (fields as Record<string, unknown>)[k];
  const cause = blockCauseWrite(id, fields);
  if (cause !== undefined) {
    keys.push("block_cause");
    params.block_cause = cause;
  }
  const sets = keys.map((k) => `${k} = @${k}`).join(", ");
  getDb()
    .prepare(
      `UPDATE tasks SET ${sets}${invalidatesTriage ? ", triaged_at = NULL" : ""},
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = @id`,
    )
    .run(params);
  // Losing an ack is a delivery-relevant event, not just a column going NULL:
  // the triage delivery path reads it as "this task needs triage again" and the
  // dashboard feed shows the human why the orchestrator was pinged twice.
  if (priorAck) {
    logEvent("task.triage_reflagged", {
      taskId: id,
      payload: {
        reason:
          fields.prompt !== undefined
            ? "prompt edited"
            : fields.repo !== undefined
              ? "repository changed"
              : "back in the queue",
      },
    });
  }
  return getTask(id);
}
