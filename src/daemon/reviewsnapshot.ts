import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getTask, updateTask, type Task } from "../db/tasks.js";
import { git } from "./worktree.js";

export interface ReviewSnapshot {
  base: string;
  tree: string;
}

function snapshotRef(taskId: number): string {
  if (!Number.isSafeInteger(taskId) || taskId <= 0) {
    throw new Error("invalid task id");
  }
  return `refs/commandcenter/review-snapshots/task-${taskId}`;
}

function requireHumanRepoTask(task: Task): string {
  if (
    task.publication_mode !== "human" ||
    task.workspace_kind !== "repo" ||
    !task.worktree ||
    !task.branch
  ) {
    throw new Error(`task ${task.id} is not a human-publication repository task`);
  }
  return task.worktree;
}

/** Build a tree object from the complete non-ignored working tree using a
 * temporary index. The real index, branch, and worktree are never changed. */
export function workingTreeSnapshot(task: Task): ReviewSnapshot {
  const worktree = requireHumanRepoTask(task);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `cc-review-${task.id}-`));
  const index = path.join(tmp, "index");
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const run = (...args: string[]) =>
    execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8", env }).trim();
  try {
    const base = run("rev-parse", "HEAD");
    run("read-tree", "HEAD");
    run("add", "-A", "--", ".");
    const tree = run("write-tree");
    if (!/^[0-9a-f]{40,64}$/i.test(base) || !/^[0-9a-f]{40,64}$/i.test(tree)) {
      throw new Error("git returned an invalid review snapshot");
    }
    return { base, tree };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Capture and pin the candidate tree so git gc cannot remove it while a
 * reviewer or human is deciding. The custom ref points to a tree, not a
 * commit, and never changes the task branch. */
export function captureReviewSnapshot(taskId: number): Task {
  const task = getTask(taskId);
  if (!task) throw new Error(`task ${taskId} not found`);
  const snapshot = workingTreeSnapshot(task);
  git(task.worktree!, "update-ref", snapshotRef(task.id), snapshot.tree);
  return updateTask(task.id, {
    review_snapshot_base: snapshot.base,
    review_snapshot_tree: snapshot.tree,
    publication_state: "reviewing",
  })!;
}

export function clearReviewSnapshot(taskId: number): Task {
  const task = getTask(taskId);
  if (!task) throw new Error(`task ${taskId} not found`);
  if (task.worktree) {
    try {
      git(task.worktree, "update-ref", "-d", snapshotRef(task.id));
    } catch {
      // Missing worktree/ref is already clean.
    }
  }
  return updateTask(task.id, {
    review_snapshot_base: null,
    review_snapshot_tree: null,
  })!;
}

export function reviewSnapshotChanged(task: Task): boolean {
  if (!task.review_snapshot_tree) return true;
  return workingTreeSnapshot(task).tree !== task.review_snapshot_tree;
}

/** True only when the human committed the exact approved tree and left no
 * additional tracked or untracked changes in the task worktree. */
export function approvedSnapshotIsCommitted(task: Task): boolean {
  const worktree = requireHumanRepoTask(task);
  if (!task.review_snapshot_tree || task.review_verdict !== "approve") return false;
  try {
    if (git(worktree, "symbolic-ref", "--quiet", "--short", "HEAD").trim() !== task.branch) {
      return false;
    }
  } catch {
    return false;
  }
  if (git(worktree, "status", "--porcelain").trim()) return false;
  const branchTree = git(worktree, "rev-parse", `${task.branch}^{tree}`).trim();
  return branchTree === task.review_snapshot_tree;
}

/** True only when the same approved tree is also present on the canonical
 * same-name origin branch. This makes "Confirm Published" prove a push
 * happened instead of trusting a button click or a pasted URL. */
export function approvedSnapshotIsPublished(task: Task): boolean {
  if (!approvedSnapshotIsCommitted(task)) return false;
  try {
    const remoteRef = `refs/remotes/origin/${task.branch}`;
    git(task.worktree!, "show-ref", "--verify", "--quiet", remoteRef);
    const remoteTree = git(
      task.worktree!,
      "rev-parse",
      `${remoteRef}^{tree}`,
    ).trim();
    return remoteTree === task.review_snapshot_tree;
  } catch {
    return false;
  }
}

/** A snapshot is reviewable when it differs from the repository baseline,
 * whether that difference came from older task commits or current uncommitted
 * files. */
export function snapshotHasChanges(task: Task): boolean {
  if (!task.branch || !task.review_snapshot_tree) return false;
  const mergeBase = git(task.repo, "merge-base", "HEAD", task.branch).trim();
  const baseTree = git(task.repo, "rev-parse", `${mergeBase}^{tree}`).trim();
  return baseTree !== task.review_snapshot_tree;
}
