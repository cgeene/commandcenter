import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Real git throughout: what these functions are FOR is where a worktree's HEAD
// lands, so a stubbed git would prove nothing. Fixture setup is issued as one
// batched `sh -c` script per repo rather than a call per command — inside a
// vitest worker each subprocess fork costs ~120-160ms, so the invocation count
// dominated this file's runtime (and its 30s-timeout flakiness under load).
vi.setConfig({ testTimeout: 30_000 });

let tmpDir: string;

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

/** Run several git commands in ONE subprocess. Returns trimmed stdout. */
function sh(script: string, env: Record<string, string> = {}): string {
  return execFileSync("sh", ["-eu", "-c", script], {
    encoding: "utf8",
    env: { ...process.env, ...env, TMP: tmpDir },
  }).trim();
}

/** Shell functions prepended to every fixture script: `gc <repo> <args...>`
 *  commits with a fixed identity, `mkrepo <name>` inits a standalone repo under
 *  $TMP, `clone <name>` clones $TMP/remote.git to $TMP/<name>. */
const SH_HELPERS = `
  gc() { d="$1"; shift; git -C "$d" -c user.email=t@t.com -c user.name=t commit -q "$@"; }
  mkrepo() { mkdir -p "$TMP/$1"; git -C "$TMP/$1" init -q -b main; }
  clone() { git -C "$TMP" clone --quiet "$TMP/remote.git" "$TMP/$1"; }
`;

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
  // The git work in these tests is synchronous, so this worker's event loop
  // can sit blocked for tens of seconds at a time. Node runs the timers phase
  // before the poll phase, so vitest's fixed 60s worker->main RPC timer can
  // fire on a reply that was already delivered but not yet read, failing the
  // run with 'Timeout calling "onTaskUpdate"'. Yield a macrotask so those
  // replies get drained between tests.
  await new Promise((resolve) => setImmediate(resolve));
});

/** Bare `$TMP/remote.git` whose default branch is `main`, seeded with one commit
 *  via the `$TMP/seed` clone that produced it. One subprocess. */
function setupRemote(): void {
  sh(`${SH_HELPERS}
      mkdir -p "$TMP/remote.git"; git -C "$TMP/remote.git" init -q --bare -b main
      mkrepo seed
      git -C "$TMP/seed" remote add origin "$TMP/remote.git"
      printf 'v1\n' > "$TMP/seed/README.md"
      git -C "$TMP/seed" add -A; gc "$TMP/seed" -m 'chore: initial commit'
      git -C "$TMP/seed" push -q -u origin main`);
}

async function events(kind: string) {
  const { listEvents } = await import("../src/db/events.js");
  return listEvents(40).filter((e) => e.kind === kind);
}

describe("createWorktree", () => {
  it("cuts a new branch from the fetched origin default branch, not local HEAD", async () => {
    setupRemote();
    // mainRepo clones, THEN a further commit lands on origin/main, so mainRepo's
    // cached origin/main is stale and only a fresh fetch has the new tip. Its
    // HEAD also sits on an unrelated unmerged local branch (the contamination
    // the fetched start-point exists to avoid).
    const upstreamTip = sh(`${SH_HELPERS}
      clone main-checkout
      printf 'from upstream\n' > "$TMP/seed/upstream-only.txt"
      git -C "$TMP/seed" add -A; gc "$TMP/seed" -m 'feat: upstream-only change'
      git -C "$TMP/seed" push -q origin main
      git -C "$TMP/main-checkout" checkout -q -b wip/unrelated
      printf 'never\n' > "$TMP/main-checkout/contaminated.txt"
      git -C "$TMP/main-checkout" add -A; gc "$TMP/main-checkout" -m 'wip: unrelated'
      git -C "$TMP/remote.git" rev-parse main`);
    const mainRepo = path.join(tmpDir, "main-checkout");

    const { createWorktree, git: worktreeGit } = await import("../src/daemon/worktree.js");
    const { dir, branch } = createWorktree(mainRepo, 101);

    expect(branch).toBe("agent/task-101");
    expect(worktreeGit(dir, "rev-parse", "HEAD").trim()).toBe(upstreamTip);
    expect(fs.existsSync(path.join(dir, "upstream-only.txt"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "contaminated.txt"))).toBe(false);
    expect(await events("worktree.fallback_local_head")).toEqual([]);
  });

  it("reuses an existing branch unchanged, and rotates a resumed attempt", async () => {
    setupRemote();
    // The existing branch sits at main, then HEAD advances past it, so a
    // start-point bug (cutting from HEAD instead of reusing the ref) shows up.
    const branchTip = sh(`${SH_HELPERS}
      clone main-checkout
      git -C "$TMP/main-checkout" branch agent/task-202 main
      printf 'later\n' > "$TMP/main-checkout/later.txt"
      git -C "$TMP/main-checkout" add -A; gc "$TMP/main-checkout" -m 'chore: later commit'
      git -C "$TMP/main-checkout" rev-parse agent/task-202`);
    const mainRepo = path.join(tmpDir, "main-checkout");
    const { createWorktree, git: worktreeGit } = await import("../src/daemon/worktree.js");

    const reused = createWorktree(mainRepo, 202);
    expect(reused.branch).toBe("agent/task-202");
    expect(worktreeGit(reused.dir, "rev-parse", "HEAD").trim()).toBe(branchTip);
    expect(branchTip).not.toBe(git(mainRepo, "rev-parse", "HEAD"));

    // A resumed attempt gets its own rotated branch AND its own worktree path,
    // so it never collides with the attempt it is replacing.
    const resumeBranch = "agent/task-202-resume-2";
    const resumed = createWorktree(mainRepo, 202, "codex", "agent", resumeBranch);
    expect(resumed.branch).toBe(resumeBranch);
    expect(resumed.dir).toContain("main-checkout-task-202-resume-2");
    expect(resumed.dir).not.toBe(reused.dir);
    expect(worktreeGit(resumed.dir, "branch", "--show-current").trim()).toBe(resumeBranch);
  });

  it("hardens upstream only for opt-in human publication tasks", async () => {
    setupRemote();
    // autoSetupMerge=always is what would silently give the branch an upstream.
    sh(`${SH_HELPERS}
        clone main-checkout
        git -C "$TMP/main-checkout" config branch.autoSetupMerge always`);
    const mainRepo = path.join(tmpDir, "main-checkout");

    const { createWorktree } = await import("../src/daemon/worktree.js");
    const agent = createWorktree(mainRepo, 501);
    expect(git(agent.dir, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/main");

    const human = createWorktree(mainRepo, 502, "claude", "human");
    expect(() => git(human.dir, "rev-parse", "--abbrev-ref", "@{upstream}")).toThrow();
  });

  // Both ways the fetched start-point can be unavailable. The fallback itself is
  // the same line of code; what must differ is the recorded reason, so the two
  // are one table rather than two near-identical tests.
  it.each([
    { why: "the repo has no origin remote", broken: false, reason: "no-origin-remote", taskId: 303 },
    { why: "the fetch fails", broken: true, reason: "fetch-failed", taskId: 404 },
  ])("falls back to local HEAD (loudly) when $why", async ({ broken, reason, taskId }) => {
    const localTip = sh(`${SH_HELPERS}
      mkrepo repo
      printf 'x\n' > "$TMP/repo/f.txt"
      git -C "$TMP/repo" add -A; gc "$TMP/repo" -m 'chore: init'
      if [ "$BROKEN" = 1 ]; then
        git -C "$TMP/repo" remote add origin "$TMP/does-not-exist.git"
      fi
      git -C "$TMP/repo" rev-parse HEAD`, { BROKEN: broken ? "1" : "0" });
    const repo = path.join(tmpDir, "repo");

    const { createWorktree, git: worktreeGit } = await import("../src/daemon/worktree.js");
    const { dir } = createWorktree(repo, taskId);

    expect(worktreeGit(dir, "rev-parse", "HEAD").trim()).toBe(localTip);
    const logged = await events("worktree.fallback_local_head");
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0].payload!)).toMatchObject({ reason });
  });
});

describe("createReviewWorktree", () => {
  it("fetches the branch so the reviewer sees the worker's latest push, not a stale local ref", async () => {
    setupRemote();
    const taskBranch = "agent/task-9";
    // repoA creates and pushes commit X; repoB then pushes commit Y, so repoA's
    // local ref for the branch is stale by construction.
    const [commitX, commitY] = sh(`${SH_HELPERS}
      clone repo-a
      git -C "$TMP/repo-a" checkout -q -b "$BRANCH"
      printf 'commit X\n' > "$TMP/repo-a/work.txt"
      git -C "$TMP/repo-a" add -A; gc "$TMP/repo-a" -m 'feat: commit X'
      git -C "$TMP/repo-a" push -q -u origin "$BRANCH"
      git -C "$TMP/repo-a" rev-parse "$BRANCH"
      clone repo-b
      git -C "$TMP/repo-b" checkout -q "$BRANCH"
      printf 'commit Y\n' > "$TMP/repo-b/work.txt"
      git -C "$TMP/repo-b" add -A; gc "$TMP/repo-b" -m 'feat: commit Y'
      git -C "$TMP/repo-b" push -q origin "$BRANCH"
      git -C "$TMP/repo-b" rev-parse "$BRANCH"`, { BRANCH: taskBranch }).split("\n");
    expect(commitY).not.toBe(commitX);
    const repoA = path.join(tmpDir, "repo-a");

    const { createReviewWorktree, git: worktreeGit } = await import(
      "../src/daemon/worktree.js"
    );
    const dir = createReviewWorktree(repoA, 9, taskBranch, true);

    expect(worktreeGit(dir, "rev-parse", "HEAD").trim()).toBe(commitY);
    // The local branch ref in repoA itself must stay untouched.
    expect(git(repoA, "rev-parse", taskBranch)).toBe(commitX);
  });

  // Every way the reviewer can end up on the LOCAL branch instead of origin's.
  // One classification, four inputs — and the calm/alarm split is the whole
  // point, so each case asserts the other kind is absent rather than only that
  // its own kind fired. A genuine fetch failure risks reviewing a stale tree, so
  // it alarms whether or not the task opens a PR; the two benign cases (no
  // origin at all, branch simply not pushed yet) must stay quiet.
  it.each([
    {
      why: "the repo has no origin remote",
      setup: "standalone",
      openPr: true,
      taskId: 20,
      kind: "worktree.review_local_branch_expected",
      reason: "no-origin-remote",
    },
    {
      why: "the branch was never pushed",
      setup: "clone",
      openPr: true,
      taskId: 10,
      kind: "worktree.review_local_branch_expected",
      reason: "branch-not-on-origin",
    },
    {
      why: "the fetch fails on a PR task",
      setup: "broken-origin",
      openPr: true,
      taskId: 12,
      kind: "worktree.review_fallback_local_branch",
      reason: "fetch-failed",
    },
    {
      why: "the fetch fails on a no-PR task",
      setup: "broken-origin",
      openPr: false,
      taskId: 13,
      kind: "worktree.review_fallback_local_branch",
      reason: "fetch-failed",
    },
  ])(
    "reviews the local branch when $why",
    async ({ setup, openPr, taskId, kind, reason }) => {
      const taskBranch = `agent/task-${taskId}`;
      if (setup !== "standalone") setupRemote();
      const localTip = sh(`${SH_HELPERS}
        if [ "$SETUP" = standalone ]; then mkrepo repo; else clone repo; fi
        git -C "$TMP/repo" checkout -q -b "$BRANCH"
        printf 'local only\n' > "$TMP/repo/work.txt"
        git -C "$TMP/repo" add -A; gc "$TMP/repo" -m 'feat: local only work'
        if [ "$SETUP" = broken-origin ]; then
          git -C "$TMP/repo" remote set-url origin "$TMP/does-not-exist.git"
        fi
        git -C "$TMP/repo" rev-parse "$BRANCH"`, { SETUP: setup, BRANCH: taskBranch });
      const repo = path.join(tmpDir, "repo");

      const { createReviewWorktree, git: worktreeGit } = await import(
        "../src/daemon/worktree.js"
      );
      const dir = createReviewWorktree(repo, taskId, taskBranch, openPr);

      expect(worktreeGit(dir, "rev-parse", "HEAD").trim()).toBe(localTip);
      const other =
        kind === "worktree.review_fallback_local_branch"
          ? "worktree.review_local_branch_expected"
          : "worktree.review_fallback_local_branch";
      expect(await events(other)).toEqual([]);
      const logged = await events(kind);
      expect(logged).toHaveLength(1);
      expect(JSON.parse(logged[0].payload!)).toMatchObject({
        branch: taskBranch,
        reason,
        ...(kind === "worktree.review_fallback_local_branch" ? { open_pr: openPr } : {}),
      });
    },
  );

  it("re-detaches to pick up new commits on reuse (second review cycle)", async () => {
    setupRemote();
    const taskBranch = "agent/task-11";
    sh(`${SH_HELPERS}
        clone repo-a
        git -C "$TMP/repo-a" checkout -q -b "$BRANCH"
        printf 'v1\n' > "$TMP/repo-a/work.txt"
        git -C "$TMP/repo-a" add -A; gc "$TMP/repo-a" -m 'feat: v1'
        git -C "$TMP/repo-a" push -q -u origin "$BRANCH"`, { BRANCH: taskBranch });
    const repoA = path.join(tmpDir, "repo-a");

    const { createReviewWorktree, git: worktreeGit } = await import(
      "../src/daemon/worktree.js"
    );
    const firstDir = createReviewWorktree(repoA, 11, taskBranch, true);
    const firstTip = worktreeGit(firstDir, "rev-parse", "HEAD").trim();

    // Second review cycle: the worker pushed more commits since. repo-a's LOCAL
    // ref is then rewound to the first tip, so origin holds v2 while the local
    // branch still points at v1. Without that the local and remote refs agree
    // and this test would pass whether the reuse path resolved origin/<branch>
    // or the stale local ref — which is the only thing it exists to catch.
    const secondPush = sh(`${SH_HELPERS}
        printf 'v2\n' > "$TMP/repo-a/work.txt"
        git -C "$TMP/repo-a" add -A; gc "$TMP/repo-a" -m 'feat: v2'
        git -C "$TMP/repo-a" push -q origin "$BRANCH"
        NEW=$(git -C "$TMP/remote.git" rev-parse "$BRANCH")
        git -C "$TMP/repo-a" update-ref "refs/heads/$BRANCH" "$FIRST"
        echo "$NEW"`, { BRANCH: taskBranch, FIRST: firstTip });
    expect(git(repoA, "rev-parse", taskBranch)).toBe(firstTip); // local really is stale
    expect(secondPush).not.toBe(firstTip);

    const secondDir = createReviewWorktree(repoA, 11, taskBranch, true);
    expect(secondDir).toBe(firstDir); // same worktree reused...
    // ...re-detached onto what origin holds now, not left on the first tip.
    expect(worktreeGit(secondDir, "rev-parse", "HEAD").trim()).toBe(secondPush);
  });
});
