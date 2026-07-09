import { execFile } from "node:child_process";
import { listAgents } from "../db/agents.js";
import { logEvent } from "../db/events.js";
import { getTask, listTasks, updateTask, type Task } from "../db/tasks.js";
import { notify } from "./notify.js";
import { resumeAgent } from "./resume.js";
import { killAgent } from "./spawn.js";
import { git, removeWorktree } from "./worktree.js";

/**
 * PR lifecycle sync: the human reviews in GitHub, the board follows.
 * - PR merged  -> task done, agents reaped, worktree + local branch pruned
 * - PR closed  -> task blocked (work rejected without merge)
 * - new PR comments / changes requested -> piped to the worker as feedback
 */

export interface PrComment {
  author: string;
  body: string;
  created_at: string;
}

/** CI check rollup for a PR — how the dashboard badges its health. */
export type CheckRollup = "pass" | "fail" | "pending" | "none";

export interface PrState {
  state: "OPEN" | "MERGED" | "CLOSED";
  reviewDecision: string | null;
  comments: PrComment[];
  /** Rolled-up CI status; absent when not fetched (older callers/tests). */
  checks?: CheckRollup;
}

const POLL_MS = 120_000;

/** Consecutive prsync failures for one PR before we escalate loudly instead
 *  of logging the same error silently forever (see unicorn-k8s PR #2199). */
export const SYNC_FAIL_THRESHOLD = 3;

export function parsePrUrl(
  url: string,
): { owner: string; repo: string; number: number } | undefined {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : undefined;
}

function gh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout),
    );
  });
}

/** Individual entries in gh's statusCheckRollup — either GitHub Checks
 *  (status/conclusion) or legacy commit statuses (state). */
interface RollupEntry {
  status?: string; // QUEUED | IN_PROGRESS | COMPLETED (CheckRun)
  conclusion?: string; // SUCCESS | FAILURE | ... (CheckRun, once COMPLETED)
  state?: string; // SUCCESS | PENDING | FAILURE | ERROR (StatusContext)
}

/** Collapse a PR's individual checks into one health verdict. Any failure
 *  wins; else any not-yet-complete check makes it pending; else all pass. */
export function computeCheckRollup(entries: RollupEntry[]): CheckRollup {
  if (!entries || entries.length === 0) return "none";
  let pending = false;
  for (const e of entries) {
    const concl = (e.conclusion ?? "").toUpperCase();
    const status = (e.status ?? "").toUpperCase();
    const legacy = (e.state ?? "").toUpperCase();
    if (
      concl === "FAILURE" ||
      concl === "TIMED_OUT" ||
      concl === "CANCELLED" ||
      concl === "ACTION_REQUIRED" ||
      concl === "STARTUP_FAILURE" ||
      legacy === "FAILURE" ||
      legacy === "ERROR"
    ) {
      return "fail";
    }
    // a CheckRun that hasn't reached COMPLETED, or a pending legacy status
    if ((status && status !== "COMPLETED") || legacy === "PENDING") pending = true;
  }
  return pending ? "pending" : "pass";
}

export async function fetchPrState(prUrl: string): Promise<PrState> {
  const ref = parsePrUrl(prUrl);
  if (!ref) throw new Error(`not a GitHub PR url: ${prUrl}`);
  const [view, issueComments, reviewComments] = await Promise.all([
    gh(["pr", "view", prUrl, "--json", "state,reviewDecision,reviews,statusCheckRollup"]),
    gh(["api", `repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments`]),
    gh(["api", `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments`]),
  ]);
  const v = JSON.parse(view) as {
    state: PrState["state"];
    reviewDecision: string | null;
    reviews?: { author?: { login?: string }; body?: string; submittedAt?: string }[];
    statusCheckRollup?: RollupEntry[];
  };
  type RawComment = { user?: { login?: string }; body?: string; created_at?: string };
  const comments: PrComment[] = [
    ...(JSON.parse(issueComments) as RawComment[]).map((c) => ({
      author: c.user?.login ?? "?",
      body: c.body ?? "",
      created_at: c.created_at ?? "",
    })),
    ...(JSON.parse(reviewComments) as RawComment[]).map((c) => ({
      author: c.user?.login ?? "?",
      body: c.body ?? "",
      created_at: c.created_at ?? "",
    })),
    ...(v.reviews ?? [])
      .filter((r) => r.body?.trim())
      .map((r) => ({
        author: r.author?.login ?? "?",
        body: r.body ?? "",
        created_at: r.submittedAt ?? "",
      })),
  ]
    .filter((c) => c.body.trim() && c.created_at)
    // CI chatter (codecov[bot], github-actions[bot], ...) is not review
    // feedback — forwarding it would yank the task out of review for nothing.
    .filter((c) => !c.author.endsWith("[bot]"));
  comments.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return {
    state: v.state,
    reviewDecision: v.reviewDecision,
    comments,
    checks: computeCheckRollup(v.statusCheckRollup ?? []),
  };
}

function reapTaskAgents(task: Task, opts?: { rmWorktree?: boolean }): void {
  for (const a of listAgents({ live: true })) {
    if (a.task_id === task.id && a.kind !== "main") {
      // reviewer worktrees are throwaway — always reap them with the agent
      killAgent(a.id, {
        rmWorktree: a.kind === "reviewer" || (opts?.rmWorktree ?? false),
      });
    }
  }
}

/** Apply a PR's state to its task. Pure of gh — unit-testable. */
export async function applyPrState(taskId: number, pr: PrState): Promise<void> {
  const task = getTask(taskId);
  if (!task || task.status !== "review") return;

  if (pr.state === "MERGED") {
    reapTaskAgents(task, { rmWorktree: true });
    const fresh = getTask(taskId)!;
    if (fresh.worktree) {
      try {
        removeWorktree(fresh.repo, fresh.worktree);
        updateTask(taskId, { worktree: null });
      } catch {
        /* leave it for manual cleanup */
      }
    }
    if (task.branch && /^agent\/task-\d+$/.test(task.branch)) {
      try {
        git(task.repo, "branch", "-D", task.branch);
      } catch {
        /* branch already gone or still checked out somewhere */
      }
    }
    updateTask(taskId, { status: "done" });
    logEvent("pr.merged", { taskId, payload: { pr_url: task.pr_url } });
    notify(`task #${taskId} done — PR merged`, task.title, { tags: "tada" });
    return;
  }

  if (pr.state === "CLOSED") {
    // Reap the agents — a blocked task's idle worker would otherwise sit in
    // scheduler capacity forever (nothing else cleans up blocked tasks).
    // The worktree and branch stay for the human to inspect or salvage.
    reapTaskAgents(task);
    updateTask(taskId, {
      status: "blocked",
      review_notes: `PR closed without merging: ${task.pr_url}`,
    });
    logEvent("pr.closed", { taskId, payload: { pr_url: task.pr_url } });
    notify(`task #${taskId} blocked — PR closed without merge`, task.title, {
      priority: "high",
      tags: "x",
    });
    return;
  }

  // OPEN: forward new human feedback. pr_feedback_at is the high-water mark;
  // null means the PR was just created — everything so far is feedback.
  const since = task.pr_feedback_at ?? "";
  const fresh = pr.comments.filter((c) => c.created_at > since);
  const changesRequested = pr.reviewDecision === "CHANGES_REQUESTED";
  if (fresh.length === 0 && !changesRequested) return;
  if (fresh.length === 0 && changesRequested && task.pr_feedback_at) return; // already forwarded

  // A live adversarial reviewer is judging this exact state — moving the
  // task out of review now would void its verdict mid-flight. The feedback
  // keeps: nothing below is persisted, so the next pass retries.
  const reviewing = listAgents({ live: true }).some(
    (a) => a.kind === "reviewer" && a.task_id === taskId,
  );
  if (reviewing) return;

  const feedback = [
    changesRequested ? "The PR review verdict is CHANGES REQUESTED." : "",
    ...fresh.map((c) => `${c.author}: ${c.body}`),
  ]
    .filter(Boolean)
    .join("\n\n");
  const mark = fresh.length
    ? fresh[fresh.length - 1].created_at
    : new Date().toISOString();

  // Deliver BEFORE persisting: once pr_feedback_at advances these comments
  // are never looked at again, so a failed send must leave it untouched.
  if (task.agent_id) {
    const outcome = await resumeAgent(
      task.agent_id,
      `New feedback on your PR (${task.pr_url}). Address every point, push to the same branch, then update your result_summary and stop.\n\n${feedback}`,
    );
    // Worker is parked on a permission prompt — injected text would answer
    // the menu, not reach the conversation. The wait is already being
    // escalated; retry on a later pass once it's unblocked.
    if (outcome === "waiting_input") return;
    if (outcome === "sent") {
      updateTask(taskId, { status: "in_progress", pr_feedback_at: mark });
      logEvent("pr.feedback", {
        taskId,
        payload: { comments: fresh.length, changes_requested: changesRequested },
      });
      logEvent("task.reopened", { taskId, payload: { reason: "pr feedback" } });
      return;
    }
    // not_live: fall through to requeue
  }

  // notes flow into the respawn prompt, same as a reviewer rejection
  updateTask(taskId, {
    status: "queued",
    agent_id: null,
    pr_feedback_at: mark,
    review_notes: `PR feedback (${task.pr_url}) — address every point and push to the same branch:\n${feedback}`,
  });
  logEvent("pr.feedback", {
    taskId,
    payload: { comments: fresh.length, changes_requested: changesRequested },
  });
  logEvent("task.requeued", { taskId, payload: { reason: "pr feedback" } });
}

/**
 * Persist a successful sync: cache the PR lifecycle + CI rollup on the task
 * and clear the consecutive-failure streak. The dashboard's PR board reads
 * these columns instead of shelling out to gh on every render.
 */
export function recordSyncSuccess(taskId: number, pr: PrState): void {
  updateTask(taskId, {
    pr_state: pr.state.toLowerCase(),
    pr_checks: pr.checks ?? null,
    pr_synced_at: new Date().toISOString(),
    pr_sync_fails: 0,
  });
}

/**
 * Record a failed sync. The failure count is persisted so the streak survives
 * daemon restarts. We log the error once at the start of a streak (not every
 * 2min), then escalate loudly exactly once when it reaches the threshold —
 * that's the alarm that was missing when unicorn-k8s PR #2199 failed 4x
 * silently.
 */
export function recordSyncFailure(taskId: number, error: string): void {
  const task = getTask(taskId);
  if (!task) return;
  const fails = (task.pr_sync_fails ?? 0) + 1;
  updateTask(taskId, { pr_sync_fails: fails });
  if (fails === 1) {
    logEvent("pr.sync_error", { taskId, payload: { error, fails } });
  } else if (fails === SYNC_FAIL_THRESHOLD) {
    logEvent("pr.sync_broken", {
      taskId,
      payload: { error, fails, pr_url: task.pr_url },
    });
    notify(
      `PR sync broken — task #${taskId}`,
      `${task.title} — ${fails} consecutive sync failures: ${error}`,
      { priority: "high", tags: "warning" },
    );
  }
}

export async function prSyncPass(): Promise<void> {
  // open_pr=false tasks are branch-only by design and should never carry a
  // pr_url, but skip explicitly rather than let a stale one trigger a sync
  // error against a PR this task was never supposed to have.
  const candidates = listTasks("review").filter((t) => t.pr_url && t.open_pr !== 0);
  for (const task of candidates) {
    try {
      const pr = await fetchPrState(task.pr_url!);
      recordSyncSuccess(task.id, pr);
      await applyPrState(task.id, pr);
    } catch (err) {
      recordSyncFailure(task.id, err instanceof Error ? err.message : String(err));
    }
  }
}

export function startPrSync(): void {
  setInterval(() => {
    prSyncPass().catch((err) => console.error("pr sync failed:", err));
  }, POLL_MS);
}
