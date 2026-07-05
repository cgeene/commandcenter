import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { worktreesDir } from "../config.js";

export function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

export function branchForTask(taskId: number): string {
  return `agent/task-${taskId}`;
}

/**
 * Create (or reuse) the worktree for a task. If the branch already exists —
 * e.g. a worker was killed and the task respawned — reattach to it so prior
 * commits survive.
 */
export function createWorktree(
  repo: string,
  taskId: number,
): { dir: string; branch: string } {
  const repoName = path.basename(repo);
  const dir = path.join(worktreesDir(), `${repoName}-task-${taskId}`);
  const branch = branchForTask(taskId);

  if (fs.existsSync(dir)) {
    return { dir, branch }; // already set up (respawn case)
  }
  fs.mkdirSync(worktreesDir(), { recursive: true });

  const branchExists =
    git(repo, "branch", "--list", branch).trim().length > 0;
  if (branchExists) {
    git(repo, "worktree", "add", dir, branch);
  } else {
    git(repo, "worktree", "add", dir, "-b", branch);
  }
  return { dir, branch };
}

export function reviewWorktreeDir(repo: string, taskId: number): string {
  return path.join(worktreesDir(), `${path.basename(repo)}-task-${taskId}-review`);
}

/**
 * Create (or refresh) a reviewer's worktree for a task branch. Detached HEAD
 * at the branch tip: git refuses to check out a branch already checked out in
 * the worker's worktree, and the reviewer must not commit anyway. On reuse
 * (second review cycle) re-detach so the reviewer sees the latest commits.
 */
export function createReviewWorktree(
  repo: string,
  taskId: number,
  branch: string,
): string {
  const dir = reviewWorktreeDir(repo, taskId);
  if (fs.existsSync(dir)) {
    git(dir, "checkout", "--detach", branch);
    return dir;
  }
  fs.mkdirSync(worktreesDir(), { recursive: true });
  git(repo, "worktree", "add", "--detach", dir, branch);
  return dir;
}

export function removeWorktree(repo: string, dir: string): void {
  git(repo, "worktree", "remove", "--force", dir);
}

/** Resolve the toplevel of the git repo containing `p` (for `agp task add` default). */
export function gitToplevel(p: string): string {
  return git(p, "rev-parse", "--show-toplevel").trim();
}
