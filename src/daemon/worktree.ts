import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { worktreesDir } from "../config.js";
import { logEvent } from "../db/events.js";
import { injectWorkspaceContext } from "./context.js";
import { type AgentProvider } from "../providers.js";

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
  provider: AgentProvider = "claude",
): { dir: string; branch: string } {
  const repoName = path.basename(repo);
  const dir = path.join(worktreesDir(), `${repoName}-task-${taskId}`);
  const branch = branchForTask(taskId);

  if (fs.existsSync(dir)) {
    // Already set up (respawn case) — still refresh injected context so a
    // resumed worker picks up any workspace-file changes since it was created.
    injectWorkspaceContext(repo, dir, taskId, provider);
    return { dir, branch };
  }
  fs.mkdirSync(worktreesDir(), { recursive: true });

  const branchExists =
    git(repo, "branch", "--list", branch).trim().length > 0;
  if (branchExists) {
    git(repo, "worktree", "add", dir, branch);
  } else {
    const startPoint = resolveOriginStartPoint(repo, taskId);
    if (startPoint) {
      git(repo, "worktree", "add", dir, "-b", branch, startPoint);
    } else {
      git(repo, "worktree", "add", dir, "-b", branch);
    }
  }
  injectWorkspaceContext(repo, dir, taskId, provider);
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
 *
 * The fallback is logged under one of two event kinds, split by whether it
 * carries any real risk of reviewing STALE state, so the raw per-kind counters
 * that drive watch-items (summary.ts `event_counts`, the nightly dream
 * reflection) only ever see the noteworthy case under the alarming name:
 *   - `worktree.review_fallback_local_branch` — the ALARM kind. Emitted whenever
 *     the fetch itself failed (offline, auth, timeout). Origin might then hold
 *     commits newer than the local ref, so falling back to local risks a stale
 *     review. This holds for no-PR / doc-store tasks too: `open_pr = 0` workers
 *     still push their branch (it IS the deliverable — see spawn.ts) and skip
 *     only the PR, so origin can be ahead of a re-cut/lost local worktree just
 *     the same. open_pr does NOT downgrade a genuine fetch failure.
 *   - `worktree.review_local_branch_expected` — the CALM kind, still recorded
 *     for auditability but not worth alarming on. Covers the two shapes where a
 *     missing origin branch is fully expected and local is by definition the
 *     freshest copy:
 *       * origin genuinely lacks the branch (`branch-not-on-origin`) — reviews
 *         trigger on the worker's Stop hook, which usually fires before the
 *         worker pushes; local is then the only, freshest copy.
 *       * no origin remote at all (`no-origin-remote`).
 * The `payload.reason` and `payload.open_pr` are kept on both kinds so a
 * consumer can still see the shape and whether it was a PR task.
 */
function resolveReviewTarget(
  repo: string,
  branch: string,
  taskId: number,
  openPr: boolean,
): string {
  const fallback = (reason: string, extra?: Record<string, unknown>): string => {
    // A stale review is only possible when the fetch itself failed — origin may
    // then be ahead of the local ref. This does not depend on open_pr: no-PR
    // tasks push their branch too (it's the deliverable), so their origin copy
    // can also lead local. The other reasons mean origin has no copy at all, so
    // local is by definition freshest and reviewing it is correct.
    const noteworthy = reason === "fetch-failed";
    logEvent(
      noteworthy
        ? "worktree.review_fallback_local_branch"
        : "worktree.review_local_branch_expected",
      { taskId, payload: { branch, reason, open_pr: openPr, ...extra } },
    );
    return branch;
  };

  if (!hasOriginRemote(repo)) {
    return fallback("no-origin-remote");
  }
  try {
    fetchQuiet(repo, branch);
    return `origin/${branch}`;
  } catch (err) {
    const detail = String(err);
    // git prints "couldn't find remote ref <branch>" when the branch simply
    // isn't on origin yet — a benign not-yet-pushed case, not a fetch failure.
    const reason = /couldn't find remote ref/i.test(detail)
      ? "branch-not-on-origin"
      : "fetch-failed";
    return fallback(reason, { detail });
  }
}

/**
 * Create (or refresh) a reviewer's worktree for a task branch. Detached HEAD
 * at the branch tip: git refuses to check out a branch already checked out in
 * the worker's worktree, and the reviewer must not commit anyway. On reuse
 * (second review cycle) re-detach so the reviewer sees the latest commits.
 *
 * `openPr` (the task's PR flag) only tunes how a fallback to the local branch
 * is logged — see resolveReviewTarget — and never changes which ref is used.
 */
export function createReviewWorktree(
  repo: string,
  taskId: number,
  branch: string,
  openPr: boolean,
  provider: AgentProvider = "claude",
): string {
  const dir = reviewWorktreeDir(repo, taskId);
  const target = resolveReviewTarget(repo, branch, taskId, openPr);
  if (fs.existsSync(dir)) {
    git(dir, "checkout", "--detach", target);
    injectWorkspaceContext(repo, dir, taskId, provider);
    return dir;
  }
  fs.mkdirSync(worktreesDir(), { recursive: true });
  git(repo, "worktree", "add", "--detach", dir, target);
  // Reviewers benefit from the same workspace context as workers.
  injectWorkspaceContext(repo, dir, taskId, provider);
  return dir;
}

export function removeWorktree(repo: string, dir: string): void {
  git(repo, "worktree", "remove", "--force", dir);
}

/** Resolve the toplevel of the git repo containing `p` (for `agp task add` default). */
export function gitToplevel(p: string): string {
  return git(p, "rev-parse", "--show-toplevel").trim();
}
