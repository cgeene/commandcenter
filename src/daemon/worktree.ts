import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { worktreesDir } from "../config.js";
import { logEvent } from "../db/events.js";

export function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

const FETCH_TIMEOUT_MS = 10_000;

/**
 * Fetch just the given refs from origin. GIT_TERMINAL_PROMPT=0 keeps a
 * broken/private remote from hanging on an interactive credential prompt in
 * this headless daemon; the timeout is a second backstop against a wedged
 * connection. Throws on any failure — callers decide the fallback.
 */
function fetchQuiet(repo: string, ...refs: string[]): void {
  execFileSync("git", ["-C", repo, "fetch", "--quiet", "origin", ...refs], {
    encoding: "utf8",
    timeout: FETCH_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function hasOriginRemote(repo: string): boolean {
  try {
    return git(repo, "remote")
      .split("\n")
      .map((l) => l.trim())
      .includes("origin");
  } catch {
    return false;
  }
}

/** Local guess at the remote's default branch name; unset until a clone or
 *  `git remote set-head origin -a` has recorded it. */
function detectDefaultBranch(repo: string): string | undefined {
  try {
    return git(repo, "symbolic-ref", "refs/remotes/origin/HEAD")
      .trim()
      .replace(/^refs\/remotes\/origin\//, "");
  } catch {
    return undefined;
  }
}

/**
 * Fetch the repo's default branch from origin and return `origin/<branch>`
 * as a worktree start-point, so new task branches begin from the real
 * upstream tip instead of whatever the shared main checkout's HEAD happens
 * to be sitting on. Returns undefined — and logs a loud platform event — if
 * there's no origin remote or the fetch fails (offline, auth), so callers
 * can fall back to local HEAD instead of failing the spawn.
 */
function resolveOriginStartPoint(repo: string, taskId: number): string | undefined {
  if (!hasOriginRemote(repo)) {
    logEvent("worktree.fallback_local_head", {
      taskId,
      payload: { reason: "no-origin-remote" },
    });
    return undefined;
  }

  const candidates = [detectDefaultBranch(repo), "main", "master"].filter(
    (b, i, arr): b is string => Boolean(b) && arr.indexOf(b) === i,
  );
  for (const branch of candidates) {
    try {
      fetchQuiet(repo, branch);
      return `origin/${branch}`;
    } catch {
      // try the next candidate name
    }
  }
  logEvent("worktree.fallback_local_head", {
    taskId,
    payload: { reason: "fetch-failed", tried: candidates },
  });
  return undefined;
}

export function branchForTask(taskId: number): string {
  return `agent/task-${taskId}`;
}

/**
 * Create (or reuse) the worktree for a task. If the branch already exists —
 * e.g. a worker was killed and the task respawned — reattach to it so prior
 * commits survive. A brand-new branch is cut from origin's default branch
 * (fetched fresh), not the main checkout's local HEAD, which may be sitting
 * on unrelated unmerged commits.
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
    return { dir, branch };
  }

  const startPoint = resolveOriginStartPoint(repo, taskId);
  if (startPoint) {
    git(repo, "worktree", "add", dir, "-b", branch, startPoint);
  } else {
    git(repo, "worktree", "add", dir, "-b", branch);
  }
  return { dir, branch };
}

export function reviewWorktreeDir(repo: string, taskId: number): string {
  return path.join(worktreesDir(), `${path.basename(repo)}-task-${taskId}-review`);
}

/**
 * Fetch `branch` from origin and return the ref the reviewer should detach
 * at. `git fetch origin <branch>:<branch>` is refused while the worker's
 * worktree has that branch checked out, so this fetches into the
 * origin/<branch> remote-tracking ref instead and prefers that when it
 * exists — otherwise the reviewer could detach at a local ref that predates
 * the worker's latest push. Falls back to the plain local branch name (prior
 * behavior) if there's no remote, the branch was never pushed, or the fetch
 * fails — logged loudly rather than silently.
 */
function resolveReviewTarget(repo: string, branch: string, taskId: number): string {
  if (!hasOriginRemote(repo)) return branch;
  try {
    fetchQuiet(repo, branch);
    return `origin/${branch}`;
  } catch (err) {
    logEvent("worktree.review_fallback_local_branch", {
      taskId,
      payload: { branch, reason: String(err) },
    });
    return branch;
  }
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
  const target = resolveReviewTarget(repo, branch, taskId);
  if (fs.existsSync(dir)) {
    git(dir, "checkout", "--detach", target);
    return dir;
  }
  fs.mkdirSync(worktreesDir(), { recursive: true });
  git(repo, "worktree", "add", "--detach", dir, target);
  return dir;
}

export function removeWorktree(repo: string, dir: string): void {
  git(repo, "worktree", "remove", "--force", dir);
}

/** Resolve the toplevel of the git repo containing `p` (for `agp task add` default). */
export function gitToplevel(p: string): string {
  return git(p, "rev-parse", "--show-toplevel").trim();
}
