import { createHash } from "node:crypto";
import { git } from "./worktree.js";
import type { Task } from "../db/tasks.js";

/**
 * Shared helpers for the automatic review⇄fix loop. Deliberately depends only
 * on worktree.git and the Task type (never on review.ts/spawn.ts) so both of
 * those can import it without a cycle.
 */

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
