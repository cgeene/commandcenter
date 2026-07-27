import { createHash } from "node:crypto";
import { git } from "./worktree.js";
import type { Task } from "../db/tasks.js";

/**
 * Shared helpers for the automatic review⇄fix loop. Deliberately depends only
 * on worktree.git and the Task type (never on review.ts/spawn.ts) so both of
 * those can import it without a cycle.
 */

/** Ceiling on how much patch text goes into a reviewer prompt. Shared by the
 *  whole-branch diff (review.taskDiff) and the delta diff below. */
export const DIFF_CHAR_LIMIT = 20_000;

/**
 * The work that landed AFTER a completed review round — the input to a
 * delta-scoped re-review. `from` is the SHA the previous reviewer judged,
 * `to` the branch tip now.
 */
export interface ReviewDelta {
  from: string;
  to: string;
  commits: string;
  stat: string;
  diff: string;
  truncated: boolean;
}

/**
 * Resolve the delta between a previously reviewed SHA and the branch tip, or
 * null when a delta-scoped re-review is not sound and the caller must fall
 * back to a full one. That is the case when:
 *  - there is no git signal (scratch task, missing branch/HEAD);
 *  - nothing moved (`to === from`);
 *  - the old SHA is gone (force-push, pruned commit); or
 *  - the old SHA is not an ancestor of the tip. A rebase rewrites the very
 *    commits the previous round judged, so "carry the prior findings forward"
 *    would be carrying forward findings about code that no longer exists.
 */
export function resolveReviewDelta(task: Task, fromSha: string): ReviewDelta | null {
  if (!fromSha) return null;
  const to = branchHeadSha(task);
  if (!to || to === fromSha) return null;
  try {
    // Both checks throw on failure: the SHA must still resolve to a commit,
    // and the branch must be a strict descendant of it.
    git(task.repo, "cat-file", "-e", `${fromSha}^{commit}`);
    git(task.repo, "merge-base", "--is-ancestor", fromSha, to);
    const range = `${fromSha}..${to}`;
    const full = git(task.repo, "diff", fromSha, to);
    const truncated = full.length > DIFF_CHAR_LIMIT;
    return {
      from: fromSha,
      to,
      commits: git(task.repo, "log", "--oneline", range).trim(),
      stat: git(task.repo, "diff", "--stat", fromSha, to).trim(),
      diff: truncated ? full.slice(0, DIFF_CHAR_LIMIT) + "\n... [diff truncated]" : full,
      truncated,
    };
  } catch {
    return null;
  }
}

/** A stable hash of the worker's claimed result. Used to tell a genuinely new
 *  submission (changed summary) from an identical re-entry that must NOT
 *  re-trigger a review round. */
export function hashResult(summary: string | null | undefined): string {
  return createHash("sha256").update(summary ?? "").digest("hex");
}

/**
 * Current HEAD SHA of a task's branch, or null when it can't be resolved (a
 * scratch/no-git task, a missing branch, or an odd repo state). Callers treat
 * null as "no git signal" and fall back to the result-summary hash.
 */
export function branchHeadSha(task: Task): string | null {
  if (task.workspace_kind !== "repo" || !task.branch) return null;
  try {
    return git(task.repo, "rev-parse", task.branch).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Does the branch have any commits beyond its merge-base with HEAD? A branch
 * sitting exactly at the base (report-only tasks) has nothing to review.
 * Returns true for scratch/no-git tasks — their deliverable isn't commits, so
 * commit-count is not the gate (the result_summary is).
 */
export function branchHasCommits(task: Task): boolean {
  if (task.workspace_kind !== "repo" || !task.branch) return true;
  try {
    const base = git(task.repo, "merge-base", "HEAD", task.branch).trim();
    return git(task.repo, "log", "--oneline", `${base}..${task.branch}`).trim().length > 0;
  } catch {
    // Odd repo/branch state: don't silently swallow the task — let the caller
    // attempt a spawn so the failure surfaces as a spawn error.
    return true;
  }
}
