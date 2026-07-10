import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Each test spins up real git repos (init/clone/commit/push/fetch) rather
// than mocking — comfortably under 5s alone, but the default per-test
// timeout gets tight under full-suite parallel load.
vi.setConfig({ testTimeout: 15_000 });

let tmpDir: string;

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function writeFile(repo: string, name: string, contents: string): void {
  fs.writeFileSync(path.join(repo, name), contents);
}

function commit(repo: string, message: string): void {
  git(repo, "add", "-A");
  git(repo, "-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-m", message);
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-worktree-"));
  process.env.CC_DATA_DIR = path.join(tmpDir, "data");
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Bare "remote" whose default branch is `main`, seeded with one commit. */
function setupRemote(): { remoteDir: string; seedDir: string } {
  const remoteDir = path.join(tmpDir, "remote.git");
  fs.mkdirSync(remoteDir);
  git(remoteDir, "init", "--bare", "-b", "main");

  const seedDir = path.join(tmpDir, "seed");
  fs.mkdirSync(seedDir);
  git(seedDir, "init", "-b", "main");
  git(seedDir, "remote", "add", "origin", remoteDir);
  writeFile(seedDir, "README.md", "v1\n");
  commit(seedDir, "chore: initial commit");
  git(seedDir, "push", "-u", "origin", "main");
  return { remoteDir, seedDir };
}

/** Clone of `remoteDir` — stands in for the daemon's main checkout. */
function cloneRepo(remoteDir: string, name: string): string {
  const dir = path.join(tmpDir, name);
  git(tmpDir, "clone", "--quiet", remoteDir, dir);
  return dir;
}

describe("createWorktree", () => {
  it("cuts a new branch from the fetched origin default branch, not local HEAD", async () => {
    const { remoteDir, seedDir } = setupRemote();
    const mainRepo = cloneRepo(remoteDir, "main-checkout");

    // A second commit lands on origin/main *after* mainRepo cloned — mainRepo's
    // cached origin/main ref does not have it yet; only a fresh fetch will.
    writeFile(seedDir, "upstream-only.txt", "from upstream\n");
    commit(seedDir, "feat: upstream-only change");
    git(seedDir, "push", "origin", "main");
    const upstreamTip = git(remoteDir, "rev-parse", "main");

    // Simulate the platform bug precondition: the main checkout's HEAD sits
    // on an unrelated, unmerged local branch (contamination).
    git(mainRepo, "checkout", "-b", "wip/unrelated");
    writeFile(mainRepo, "contaminated.txt", "should never appear in the task branch\n");
    commit(mainRepo, "wip: unrelated local work");

    const { createWorktree, git: worktreeGit } = await import("../src/daemon/worktree.js");
    const { listEvents } = await import("../src/db/events.js");
    const { dir, branch } = createWorktree(mainRepo, 101);

    expect(branch).toBe("agent/task-101");
    expect(worktreeGit(dir, "rev-parse", "HEAD").trim()).toBe(upstreamTip);
    expect(fs.existsSync(path.join(dir, "upstream-only.txt"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "contaminated.txt"))).toBe(false);
    expect(listEvents(20).map((e) => e.kind)).not.toContain(
      "worktree.fallback_local_head",
    );
  });

  it("reuses an existing branch unchanged (respawn case)", async () => {
    const { remoteDir } = setupRemote();
    const mainRepo = cloneRepo(remoteDir, "main-checkout");

    const branchName = "agent/task-202";
    git(mainRepo, "branch", branchName, "main");
    // Advance HEAD past the branch so a start-point bug would be obvious.
    writeFile(mainRepo, "later.txt", "later\n");
    commit(mainRepo, "chore: later commit on main");

    const { createWorktree, git: worktreeGit } = await import("../src/daemon/worktree.js");
    const { dir, branch } = createWorktree(mainRepo, 202);

    expect(branch).toBe(branchName);
    expect(worktreeGit(dir, "rev-parse", "HEAD").trim()).toBe(
      git(mainRepo, "rev-parse", branchName),
    );
  });

  it("falls back to local HEAD (loudly) when the repo has no origin remote", async () => {
    const repo = path.join(tmpDir, "no-remote");
    fs.mkdirSync(repo);
    git(repo, "init", "-b", "main");
    writeFile(repo, "f.txt", "x\n");
    commit(repo, "chore: init");
    const localTip = git(repo, "rev-parse", "HEAD");

    const { createWorktree, git: worktreeGit } = await import("../src/daemon/worktree.js");
    const { listEvents } = await import("../src/db/events.js");
    const { dir } = createWorktree(repo, 303);

    expect(worktreeGit(dir, "rev-parse", "HEAD").trim()).toBe(localTip);
    const events = listEvents(20).filter((e) => e.kind === "worktree.fallback_local_head");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload!)).toMatchObject({ reason: "no-origin-remote" });
  });

  it("falls back to local HEAD (loudly) when the fetch fails", async () => {
    const { remoteDir } = setupRemote();
    const mainRepo = cloneRepo(remoteDir, "main-checkout");
    // Point origin at a path that no longer exists so fetch fails fast.
    git(mainRepo, "remote", "set-url", "origin", path.join(tmpDir, "does-not-exist.git"));
    writeFile(mainRepo, "local-only.txt", "x\n");
    commit(mainRepo, "chore: local only");
    const localTip = git(mainRepo, "rev-parse", "HEAD");

    const { createWorktree, git: worktreeGit } = await import("../src/daemon/worktree.js");
    const { listEvents } = await import("../src/db/events.js");
    const { dir } = createWorktree(mainRepo, 404);

    expect(worktreeGit(dir, "rev-parse", "HEAD").trim()).toBe(localTip);
    const events = listEvents(20).filter((e) => e.kind === "worktree.fallback_local_head");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload!)).toMatchObject({ reason: "fetch-failed" });
  });
});

describe("createReviewWorktree", () => {
  it("fetches the branch so the reviewer sees the worker's latest push, not a stale local ref", async () => {
    const { remoteDir } = setupRemote();
    const taskBranch = "agent/task-9";

    // repoA stands in for the daemon's main checkout: creates the branch and
    // pushes an initial commit.
    const repoA = cloneRepo(remoteDir, "repo-a");
    git(repoA, "checkout", "-b", taskBranch);
    writeFile(repoA, "work.txt", "commit X\n");
    commit(repoA, "feat: commit X");
    git(repoA, "push", "-u", "origin", taskBranch);
    const commitX = git(repoA, "rev-parse", taskBranch);

    // repoB simulates the worker pushing a further commit after repoA's
    // local branch ref was set — repoA's local ref is now stale.
    const repoB = cloneRepo(remoteDir, "repo-b");
    git(repoB, "checkout", taskBranch);
    writeFile(repoB, "work.txt", "commit Y\n");
    commit(repoB, "feat: commit Y");
    git(repoB, "push", "origin", taskBranch);
    const commitY = git(repoB, "rev-parse", taskBranch);
    expect(commitY).not.toBe(commitX);

    const { createReviewWorktree, git: worktreeGit } = await import(
      "../src/daemon/worktree.js"
    );
    const dir = createReviewWorktree(repoA, 9, taskBranch);

    expect(worktreeGit(dir, "rev-parse", "HEAD").trim()).toBe(commitY);
    // The local branch ref in repoA itself must stay untouched.
    expect(git(repoA, "rev-parse", taskBranch)).toBe(commitX);
  });

  it("falls back to the local branch (loudly) when the repo has no origin remote", async () => {
    const repo = path.join(tmpDir, "no-remote");
    fs.mkdirSync(repo);
    git(repo, "init", "-b", "main");
    const taskBranch = "agent/task-20";
    git(repo, "checkout", "-b", taskBranch);
    writeFile(repo, "work.txt", "local only\n");
    commit(repo, "feat: local only work");
    const localTip = git(repo, "rev-parse", taskBranch);

    const { createReviewWorktree, git: worktreeGit } = await import(
      "../src/daemon/worktree.js"
    );
    const { listEvents } = await import("../src/db/events.js");
    const dir = createReviewWorktree(repo, 20, taskBranch);

    expect(worktreeGit(dir, "rev-parse", "HEAD").trim()).toBe(localTip);
    const events = listEvents(20).filter(
      (e) => e.kind === "worktree.review_fallback_local_branch",
    );
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload!)).toMatchObject({
      branch: taskBranch,
      reason: "no-origin-remote",
    });
  });

  it("falls back to the local branch (reason: branch-not-on-origin) when it was never pushed", async () => {
    const { remoteDir } = setupRemote();
    const repoA = cloneRepo(remoteDir, "repo-a");
    const taskBranch = "agent/task-10";
    git(repoA, "checkout", "-b", taskBranch);
    writeFile(repoA, "work.txt", "local only\n");
    commit(repoA, "feat: local only work");
    const localTip = git(repoA, "rev-parse", taskBranch);

    const { createReviewWorktree, git: worktreeGit } = await import(
      "../src/daemon/worktree.js"
    );
    const { listEvents } = await import("../src/db/events.js");
    const dir = createReviewWorktree(repoA, 10, taskBranch);

    expect(worktreeGit(dir, "rev-parse", "HEAD").trim()).toBe(localTip);
    const events = listEvents(20).filter(
      (e) => e.kind === "worktree.review_fallback_local_branch",
    );
    expect(events).toHaveLength(1);
    // The benign not-yet-pushed case: origin genuinely lacks the branch, so
    // reviewing local is correct — must NOT be conflated with a fetch failure.
    expect(JSON.parse(events[0].payload!)).toMatchObject({
      branch: taskBranch,
      reason: "branch-not-on-origin",
    });
  });

  it("falls back to the local branch (reason: fetch-failed) when the fetch itself fails", async () => {
    const { remoteDir } = setupRemote();
    const repoA = cloneRepo(remoteDir, "repo-a");
    const taskBranch = "agent/task-12";
    git(repoA, "checkout", "-b", taskBranch);
    writeFile(repoA, "work.txt", "local only\n");
    commit(repoA, "feat: local only work");
    const localTip = git(repoA, "rev-parse", taskBranch);
    // Point origin at a path that no longer exists so the fetch errors out
    // (offline/auth-style failure) rather than reporting a missing ref.
    git(repoA, "remote", "set-url", "origin", path.join(tmpDir, "does-not-exist.git"));

    const { createReviewWorktree, git: worktreeGit } = await import(
      "../src/daemon/worktree.js"
    );
    const { listEvents } = await import("../src/db/events.js");
    const dir = createReviewWorktree(repoA, 12, taskBranch);

    expect(worktreeGit(dir, "rev-parse", "HEAD").trim()).toBe(localTip);
    const events = listEvents(20).filter(
      (e) => e.kind === "worktree.review_fallback_local_branch",
    );
    expect(events).toHaveLength(1);
    // A genuine fetch failure: origin may hold newer commits than local, so
    // this fallback risks a stale review and is the case worth alarming on.
    expect(JSON.parse(events[0].payload!)).toMatchObject({
      branch: taskBranch,
      reason: "fetch-failed",
    });
  });

  it("re-detaches to pick up new commits on reuse (second review cycle)", async () => {
    const { remoteDir } = setupRemote();
    const taskBranch = "agent/task-11";
    const repoA = cloneRepo(remoteDir, "repo-a");
    git(repoA, "checkout", "-b", taskBranch);
    writeFile(repoA, "work.txt", "v1\n");
    commit(repoA, "feat: v1");
    git(repoA, "push", "-u", "origin", taskBranch);

    const { createReviewWorktree, git: worktreeGit } = await import(
      "../src/daemon/worktree.js"
    );
    const firstDir = createReviewWorktree(repoA, 11, taskBranch);
    const firstTip = worktreeGit(firstDir, "rev-parse", "HEAD");

    // Second review cycle: worker pushed more commits from elsewhere.
    const repoB = cloneRepo(remoteDir, "repo-b");
    git(repoB, "checkout", taskBranch);
    writeFile(repoB, "work.txt", "v2\n");
    commit(repoB, "feat: v2");
    git(repoB, "push", "origin", taskBranch);

    const secondDir = createReviewWorktree(repoA, 11, taskBranch);
    expect(secondDir).toBe(firstDir);
    const secondTip = worktreeGit(secondDir, "rev-parse", "HEAD");
    expect(secondTip).not.toBe(firstTip);
  });
});
