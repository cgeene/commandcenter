import { jiraToken } from "../config.js";
import { logEvent } from "../db/events.js";
import {
  getJiraConfig,
  jiraEnabledRepos,
  type JiraConfig,
  type JiraRepoConfig,
} from "../db/settings.js";
import {
  getTask,
  tasksNeedingJiraCreate,
  tasksNeedingJiraSync,
  updateTask,
  type Task,
} from "../db/tasks.js";
import { classifyTicket } from "./jiraclassify.js";
import {
  buildCommentAdf,
  buildDescriptionAdf,
  JiraClient,
  matchTransition,
  type JiraIssueView,
  type JiraTransition,
} from "./jira.js";
import { notify } from "./notify.js";
import { enforcePrTitle } from "./prdraft.js";

/**
 * JIRA sync engine — the deterministic sibling of prsync.ts. Owns ticket
 * creation, status sync, and workflow transitions on a 2-minute poll. Gated on
 * JiraConfig.enabled AND per-repo opt-in AND a token in env (fail-closed).
 *
 * Load-bearing disciplines carried over from prsync:
 *  - Order writes so the UNRECOVERABLE failure can't happen: persist jira_key
 *    the instant POST /issue returns, BEFORE any downstream step. A duplicate
 *    ticket is unrecoverable; a stale downstream state is not.
 *  - Escalate-once: log the first failure of a streak, page exactly once at the
 *    threshold — never silently N times, never every 2 min (prsync.ts:410).
 *  - Don't-clobber: only monotonic-forward transitions; never fight a human's
 *    manual move. Terminal states drop out of the poll set.
 *  - Degrade, never block/crash: JIRA-down defers a ticket, never blocks a PR.
 */

const POLL_MS = 120_000;

/** Consecutive jirasync failures for one ticket before we escalate loudly. */
export const SYNC_FAIL_THRESHOLD = 3;

/** The label every commandcenter-minted ticket carries. */
const CC_LABEL = "commandcenter";

/**
 * Resolved (project, targetStatus) → transition, cached per daemon run so we
 * don't re-`GET /transitions` for every pass. Transition IDs are workflow- and
 * project-specific (EN's "Development started" is 41, another project differs),
 * so we NEVER hardcode them — we resolve by target status NAME at runtime and
 * memoize the result. Availability of a transition depends on the CURRENT
 * status, so a miss is never cached (it may be reachable from a later status).
 */
interface ResolvedTransition {
  id: string;
  toName: string;
  toCategory: string;
}
const transitionCache = new Map<string, ResolvedTransition>();

/**
 * Tickets we've already posted a comment-only consequence to this run (PR
 * closed-unmerged, or a cancelled task whose "Will not do" transition degraded
 * to a comment). Those cases produce no status change, so the task keeps
 * re-selecting from tasksNeedingJiraSync — this guard prevents re-commenting
 * every 2 minutes. In-memory only: at worst a daemon restart re-posts one
 * benign comment, far preferable to a persisted-marker migration and orders of
 * magnitude less harmful than the duplicate-ticket failure mode we DO guard
 * with the DB.
 */
const commentedThisRun = new Set<number>();

/** Test seam: clear per-run caches so each test starts clean. */
export function _resetJiraSyncState(): void {
  transitionCache.clear();
  commentedThisRun.clear();
  injectedClient = null;
}

/** Test seam: inject a JiraClient (fake runner) instead of the env-configured
 *  one. Pass null to restore the default. */
let injectedClient: JiraClient | null = null;
export function _setJiraClient(client: JiraClient | null): void {
  injectedClient = client;
}

function jiraClient(): JiraClient {
  return injectedClient ?? new JiraClient();
}

/* ------------------------------------------------------------------ *
 * Failure accounting — mirrors prsync's recordSyncSuccess/Failure.    *
 * ------------------------------------------------------------------ */

/** Cache the freshly-observed JIRA status on the row and clear the failure
 *  streak. The dashboard reads these columns instead of hitting JIRA on render. */
export function recordJiraSyncSuccess(
  taskId: number,
  status: { state: string; category: string },
): void {
  updateTask(taskId, {
    jira_state: status.state || null,
    jira_status_category: status.category || null,
    jira_synced_at: new Date().toISOString(),
    jira_sync_fails: 0,
  });
}

/** Record a failed sync. The streak persists across daemon restarts. Log once
 *  at streak start, then escalate loudly exactly once at the threshold — the
 *  alarm that was missing when unicorn-k8s PR #2199 failed 4x silently. */
export function recordJiraSyncFailure(taskId: number, error: string): void {
  const task = getTask(taskId);
  if (!task) return;
  const fails = (task.jira_sync_fails ?? 0) + 1;
  updateTask(taskId, { jira_sync_fails: fails });
  if (fails === 1) {
    logEvent("jira.sync_error", { taskId, payload: { error, fails } });
  } else if (fails === SYNC_FAIL_THRESHOLD) {
    logEvent("jira.sync_broken", {
      taskId,
      payload: { error, fails, jira_key: task.jira_key },
    });
    notify(
      `JIRA sync broken — task #${taskId}`,
      `${task.title} — ${fails} consecutive sync failures: ${error}`,
      { priority: "high", tags: "warning" },
    );
  }
}

/* ------------------------------------------------------------------ *
 * Transition planning + resolution.                                   *
 * ------------------------------------------------------------------ */

/** Linear rank along the driven PR path: To Do (0) → In Progress (1) →
 *  Merged (2) → Done (3). Used for the monotonic-forward don't-clobber guard so
 *  we never move a ticket backward on the path. Unknown statuses (human custom
 *  columns) fall back to their category rank. */
const DRIVE_RANK: Record<string, number> = {
  open: 0,
  "to do": 0,
  "selected for development": 0,
  backlog: 0,
  "in progress": 1,
  merged: 2,
  done: 3,
  closed: 3,
};

function categoryRank(category: string): number {
  if (category === "done") return 3;
  if (category === "indeterminate") return 1;
  return 0; // new / unknown
}

function driveRank(name: string, category: string): number {
  const byName = DRIVE_RANK[name.trim().toLowerCase()];
  return byName !== undefined ? byName : categoryRank(category);
}

/** What consequence a task's current commandcenter state implies for its
 *  ticket. Precedence is most-terminal-first (§3.4). */
type Consequence =
  | { kind: "transition"; targets: string[] } // ordered fallbacks: try [0], else [1]...
  | { kind: "willnotdo" } // Will not do, degrading to a comment on failure
  | { kind: "closed-comment" } // PR closed unmerged: comment only, never transition
  | { kind: "none" };

export function planConsequence(task: Task): Consequence {
  // Cancelled wins outright — the human pulled the plug.
  if (task.status === "cancelled") return { kind: "willnotdo" };
  // Terminal-done: drive to Done (drops out of the poll set afterward).
  if (task.status === "done") return { kind: "transition", targets: ["Done"] };
  // PR closed without merge: comment only, never auto-resolve a rejected ticket.
  if (task.pr_state === "closed") return { kind: "closed-comment" };
  // PR merged: Merged where the project has it, else Done.
  if (task.pr_state === "merged") {
    return { kind: "transition", targets: ["Merged", "Done"] };
  }
  // Otherwise the work is live: In Progress.
  return { kind: "transition", targets: ["In Progress"] };
}

/** Resolve a target status name to a transition available from the issue's
 *  current status, memoized per (project, target). Returns null when the target
 *  isn't reachable right now. */
async function resolveTransition(
  client: JiraClient,
  project: string,
  key: string,
  target: string,
): Promise<ResolvedTransition | null> {
  const ck = `${project}::${target.toLowerCase()}`;
  const cached = transitionCache.get(ck);
  if (cached) return cached;
  const transitions: JiraTransition[] = await client.getTransitions(key);
  const t = matchTransition(transitions, target);
  if (!t) return null; // not reachable from current status — don't cache a miss
  const resolved: ResolvedTransition = {
    id: t.id,
    toName: t.to.name,
    toCategory: t.to.category,
  };
  transitionCache.set(ck, resolved);
  return resolved;
}

/** The status a consequence left the ticket at, when it changed. */
type ConsequenceResult = { state: string; category: string } | undefined;

/**
 * Apply a task's implied consequence to its ticket, honoring don't-clobber
 * (monotonic-forward only) and degrade-don't-crash semantics. `current` is the
 * status just fetched.
 *
 * Returns the ticket's NEW status when a transition landed (so the caller caches
 * it and a terminal move drops the task out of the poll set on the same pass),
 * or undefined when nothing changed the status (no-op, comment-only, degrade).
 *
 * Critically, this function does NOT touch the failure streak: the caller clears
 * the streak (via recordJiraSyncSuccess) ONLY after this returns cleanly. A
 * throw here (e.g. a forward transition that persistently 400s on a required
 * screen field) therefore propagates to the caller's failure counter and lets
 * the streak actually accumulate to SYNC_FAIL_THRESHOLD — resetting the streak
 * before applying the consequence is exactly the 0→1 oscillation bug that would
 * strand a ticket forever and never page.
 */
async function applyConsequence(
  client: JiraClient,
  task: Task,
  current: JiraIssueView,
): Promise<ConsequenceResult> {
  const key = task.jira_key!;
  const plan = planConsequence(task);

  if (plan.kind === "none") return undefined;

  if (plan.kind === "closed-comment") {
    if (commentedThisRun.has(task.id)) return undefined;
    await client.addComment(
      key,
      buildCommentAdf(
        `commandcenter: PR closed without merging — ${task.pr_url ?? "(PR)"}. Ticket left as-is for a human to resolve.`,
      ),
    );
    commentedThisRun.add(task.id);
    logEvent("jira.commented", {
      taskId: task.id,
      payload: { jira_key: key, reason: "pr closed unmerged" },
    });
    return undefined; // comment only — status unchanged
  }

  if (plan.kind === "willnotdo") {
    // Don't clobber a ticket a human already resolved.
    if (current.category === "done") return undefined;
    // Already degraded this run — short-circuit at the TOP (mirror the
    // closed-comment branch). A degraded ticket stays at its non-terminal status
    // and keeps re-selecting from tasksNeedingJiraSync, so without this guard the
    // failing "Will not do" POST would be re-attempted and jira.transition_failed
    // re-logged (logEvent has no dedup) every pass, forever — the exact
    // spam-every-2-min the escalate-once discipline forbids. The degrade is
    // treated as a clean success (no streak), so this in-memory guard is what
    // bounds it; across a daemon restart it re-degrades at most once.
    if (commentedThisRun.has(task.id)) return undefined;
    const resolved = await resolveTransition(client, task.jira_project!, key, "Will not do");
    if (resolved) {
      try {
        await client.transitionIssue(key, resolved.id);
        logEvent("jira.transition", {
          taskId: task.id,
          payload: { jira_key: key, to: resolved.toName },
        });
        return { state: resolved.toName.toLowerCase(), category: resolved.toCategory };
      } catch (err) {
        // "Will not do" hasScreen:true (EN transition 71) — the POST can 400 on
        // a required screen field even though the transition WAS offered. Decision
        // 4 / §2.4 mandate degrading to a comment here, not crashing the pass.
        // Fall through to the comment path below (logged/attempted at most once
        // per run thanks to the guard above); we do NOT rethrow, so the degrade
        // is a clean success (the human intent — cancellation — is recorded on
        // the ticket via the comment).
        logEvent("jira.transition_failed", {
          taskId: task.id,
          payload: {
            jira_key: key,
            to: "Will not do",
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }
    // Reached when "Will not do" is either not offered from the current status OR
    // was offered but the POST failed (required screen field, missing state).
    // Both degrade to the same "task cancelled" comment — never crash the pass.
    await client.addComment(
      key,
      buildCommentAdf("commandcenter: task cancelled in commandcenter."),
    );
    commentedThisRun.add(task.id);
    logEvent("jira.commented", {
      taskId: task.id,
      payload: { jira_key: key, reason: "cancelled (will-not-do transition failed)" },
    });
    return undefined; // degraded to a comment — status unchanged
  }

  // plan.kind === "transition": ordered forward targets.
  const currentRank = driveRank(current.state, current.category);
  for (const target of plan.targets) {
    const targetRank = driveRank(target.toLowerCase(), "");
    // Don't-clobber: never move backward or sideways along the driven path.
    if (targetRank <= currentRank) return undefined; // already at/past this target — no-op
    const resolved = await resolveTransition(client, task.jira_project!, key, target);
    if (!resolved) continue; // target not reachable now — try the next fallback
    // A throw here (e.g. required screen field on Done) is intentionally NOT
    // caught: it propagates so the streak accumulates and escalate-once fires.
    await client.transitionIssue(key, resolved.id);
    logEvent("jira.transition", {
      taskId: task.id,
      payload: { jira_key: key, to: resolved.toName },
    });
    return { state: resolved.toName.toLowerCase(), category: resolved.toCategory };
  }
  return undefined; // no reachable forward target this pass
}

/* ------------------------------------------------------------------ *
 * Create path — §3.3 ordering (persist key before ANY downstream).    *
 * ------------------------------------------------------------------ */

/** Resolve the create-time (project, issueType) with the decision-7 order:
 *  per-task jira_project override → validated classifier proposal → per-repo
 *  default project + "Task". The classifier is skipped entirely when there's
 *  nothing to choose (single-entry allow-lists). */
export async function resolveCreateTarget(
  task: Task,
  repoCfg: JiraRepoConfig,
  cfg: JiraConfig,
): Promise<{ project: string; issueType: string }> {
  const allowProjects = repoCfg.projects?.length ? repoCfg.projects : [repoCfg.project];
  const allowTypes = repoCfg.issue_types?.length ? repoCfg.issue_types : ["Task"];

  let project = repoCfg.project; // deterministic default
  let issueType = "Task"; // deterministic default

  // Only consult the classifier when there's an actual choice to make.
  if (allowProjects.length > 1 || allowTypes.length > 1) {
    const proposal = await classifyTicket({
      title: task.title,
      prompt: task.prompt,
      repo: task.repo,
      projects: allowProjects,
      issueTypes: allowTypes,
      model: cfg.classifier_model ?? "sonnet",
    });
    if (proposal) {
      // Validate against the allow-list; ignore out-of-list picks (fallback stays).
      if (allowProjects.includes(proposal.project)) project = proposal.project;
      if (allowTypes.includes(proposal.issue_type)) issueType = proposal.issue_type;
    }
  }

  // Per-task override wins over everything for the project.
  if (task.jira_project) project = task.jira_project;

  return { project, issueType };
}

/**
 * Create a ticket for one task, then drive its initial consequence. §3.3
 * ordering is strict: POST /issue → PERSIST jira_key IMMEDIATELY → downstream.
 * If a downstream step fails, jira_key is already recorded so the task never
 * re-enters the create path (no duplicate ticket); the sync pass drives the
 * initial transition on a later pass instead.
 */
async function jiraCreate(
  client: JiraClient,
  task: Task,
  cfg: JiraConfig,
): Promise<void> {
  const repoCfg = cfg.repos[task.repo];
  if (!repoCfg?.enabled) return; // repo not enabled — no ticket (belt to the query gate)

  const { project, issueType } = await resolveCreateTarget(task, repoCfg, cfg);
  const labels = [CC_LABEL, ...(repoCfg.labels ?? [])];

  const created = await client.createIssue({
    project,
    issueType,
    summary: task.title,
    description: buildDescriptionAdf(task.prompt, task.pr_url ?? "", task.id),
    labels,
    // Personal-token model: assignee = configured owner, else unset (degrade,
    // never fail on a mapping). Identity→accountId resolution is future work.
    assigneeAccountId: cfg.default_assignee_account_id,
  });

  // PERSIST THE KEY IMMEDIATELY — the idempotency anchor (§3.3). Also persist
  // the resolved project so a per-task override / classifier pick survives and
  // we don't re-resolve every pass.
  updateTask(task.id, { jira_key: created.key, jira_project: project });
  logEvent("jira.created", {
    taskId: task.id,
    payload: { jira_key: created.key, project, issue_type: issueType },
  });

  // Downstream: reflect current status and drive the initial transition
  // (In Progress). A failure here doesn't undo the create — the key is safely
  // persisted and the sync pass retries the transition; it throws to the create
  // loop's catch so the failure streak accumulates. recordJiraSyncSuccess (which
  // caches status AND clears the streak) runs ONLY after applyConsequence
  // returns cleanly, caching the post-transition status when one landed.
  const fresh = getTask(task.id)!;
  const view = await client.getIssue(created.key);
  const after = await applyConsequence(client, fresh, view);
  // Enforce the bracketed [KEY-N] PR title now that the key is persisted (§3.3
  // step 4). A failure here throws to the create loop's catch → the sync-failure
  // streak; the key is already recorded, so the retitle is retried by the
  // reconciler on a later pass and the ticket is never re-created.
  if (fresh.pr_url) await enforcePrTitle(fresh.pr_url, created.key);
  recordJiraSyncSuccess(task.id, after ?? view);
}

/* ------------------------------------------------------------------ *
 * PR-title reconciler — heal a stale/missing [KEY-N] on later passes.  *
 * ------------------------------------------------------------------ */

/** Task statuses whose PR title is historical — not worth failing a pass to
 *  retitle (the ticket is terminal or the work is abandoned). */
const TITLE_TERMINAL_STATUS = new Set(["done", "cancelled", "failed"]);

/**
 * Re-enforce the [KEY-N] PR title for a ticketed task whose PR is still live.
 * enforcePrTitle is idempotent (a correct title triggers no `gh pr edit`), so
 * this is a no-op in the common case and only heals a title that drifted — e.g.
 * the create-path retitle failed (its throw was recorded but the key persisted),
 * or a human edited the title. A retitle failure throws to the sync loop's catch
 * and accrues to the same jira_sync_fails streak; it never re-creates a ticket
 * (jiraCreate is gated on jira_key IS NULL).
 *
 * Skipped once the PR is merged/closed or the task is terminal: at that point
 * the title is historical and a gh hiccup shouldn't stall the pass.
 */
async function reconcilePrTitle(task: Task): Promise<void> {
  if (!task.pr_url || !task.jira_key) return;
  if (task.pr_state === "merged" || task.pr_state === "closed") return;
  if (TITLE_TERMINAL_STATUS.has(task.status)) return;
  await enforcePrTitle(task.pr_url, task.jira_key);
}

/* ------------------------------------------------------------------ *
 * The pass + the loop.                                                *
 * ------------------------------------------------------------------ */

export async function jiraSyncPass(): Promise<void> {
  const cfg = getJiraConfig();
  // Master switch and fail-closed token gate. Either off ⇒ subsystem inert.
  if (!cfg.enabled) return;
  if (!jiraToken()) return;

  const client = jiraClient();

  // Create tickets for PR-bearing, ticketless tasks in enabled repos. A task
  // created here gains a jira_key and would ALSO match tasksNeedingJiraSync
  // below; the create path already fetched status + drove the initial
  // transition, so we skip it in the sync loop this pass (avoids a redundant
  // round-trip and double-counting a downstream failure).
  const createdThisPass = new Set<number>();
  for (const task of tasksNeedingJiraCreate(jiraEnabledRepos())) {
    createdThisPass.add(task.id);
    try {
      await jiraCreate(client, task, cfg);
    } catch (err) {
      recordJiraSyncFailure(
        task.id,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Sync existing tickets: drive any pending consequence, then cache status +
  // clear the streak. recordJiraSyncSuccess runs ONLY after applyConsequence
  // returns cleanly — a persistently-failing consequence (e.g. a Done transition
  // with a required screen field) throws before the streak is cleared, so the
  // streak accumulates to SYNC_FAIL_THRESHOLD and escalate-once fires exactly
  // once. (Resetting the streak before applying the consequence was the 0→1
  // oscillation bug that stranded tickets and never paged.)
  for (const task of tasksNeedingJiraSync()) {
    if (createdThisPass.has(task.id)) continue;
    try {
      const view = await client.getIssue(task.jira_key!);
      const after = await applyConsequence(client, task, view);
      // Heal a drifted PR title (best-effort, idempotent). Shares the streak:
      // a persistent retitle failure accrues to jira_sync_fails just like a
      // JIRA-API failure, so recordJiraSyncSuccess runs only when BOTH succeed.
      await reconcilePrTitle(task);
      recordJiraSyncSuccess(task.id, after ?? view);
    } catch (err) {
      recordJiraSyncFailure(
        task.id,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

export function startJiraSync(): void {
  // Fail-closed: no token ⇒ the whole subsystem stays inert, logged once at boot
  // (the CC_NTFY_TOKEN precedent). No interval is armed, so a token-less install
  // pays nothing.
  if (!jiraToken()) {
    console.log("JIRA sync disabled: no CC_JIRA_TOKEN");
    return;
  }
  // Immediate startup catch-up, then the 2-min poll — mirrors startPrSync.
  jiraSyncPass().catch((err) =>
    console.error("jira sync (startup catch-up) failed:", err),
  );
  setInterval(() => {
    jiraSyncPass().catch((err) => console.error("jira sync failed:", err));
  }, POLL_MS);
}
