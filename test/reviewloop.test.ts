import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Stub the reviewer spawn so the loop's decision logic is testable without a
// real tmux window or review worktree. spawnReviewer records its calls and
// returns a fake agent; killAgent is a no-op. Everything else in the loop
// (git HEAD detection, PR re-draft via prdraft, DB writes, events) runs for
// real.
const spawnReviewer = vi.fn((_taskId: number) => ({ agent: { id: 999 }, task: {} }));
vi.mock("../src/daemon/spawn.js", () => ({
  spawnReviewer: (id: number) => spawnReviewer(id),
  killAgent: () => {},
}));

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-reviewloop-"));
  process.env.CC_DATA_DIR = tmpDir;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  spawnReviewer.mockClear();
  spawnReviewer.mockImplementation((_taskId: number) => ({ agent: { id: 999 }, task: {} }));
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  const { _setGhRunner } = await import("../src/daemon/prdraft.js");
  _setGhRunner(null);
});

/** A real git repo whose task branch sits one commit ahead of the base the
 *  repo's HEAD points at (so branchHasCommits/HEAD detection work). Returns the
 *  branch tip SHA. Call `commitMore()` to advance the branch and get a new SHA. */
function makeRepo(taskId: number): {
  repo: string;
  branch: string;
  headSha: string;
  commitMore: () => string;
} {
  const repo = path.join(tmpDir, `repo-${taskId}`);
  fs.mkdirSync(repo, { recursive: true });
  const g = (...a: string[]) =>
    execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...a]);
  g("init", "-q", "-b", "main");
  g("commit", "-q", "--allow-empty", "-m", "init");
  const branch = `agent/task-${taskId}`;
  g("branch", branch);
  let n = 0;
  // Always commit ON the branch, then leave repo HEAD back on the base so the
  // branch stays 1+ commits ahead (merge-base(HEAD, branch) == base).
  const commitMore = (): string => {
    n += 1;
    g("checkout", "-q", branch);
    fs.writeFileSync(path.join(repo, `f${n}.txt`), `work ${n}`);
    g("add", "-A");
    g("commit", "-q", "-m", `work ${n}`);
    const sha = g("rev-parse", branch).toString().trim();
    g("checkout", "-q", "main");
    return sha;
  };
  const headSha = commitMore();
  return { repo, branch, headSha, commitMore };
}

async function reviewTask(
  taskId: number,
  repo: string,
  branch: string,
  fields: Partial<Record<string, unknown>> = {},
) {
  const { createTask, updateTask } = await import("../src/db/tasks.js");
  const t = createTask({ title: "t", prompt: "x", repo });
  updateTask(t.id, {
    status: "review",
    branch,
    result_summary: "claims done",
    ...fields,
  });
  return t.id;
}

describe("review⇄fix loop — auto next round", () => {
  it("fix-push (new commit) auto-spawns the next reviewer round", async () => {
    const { maybeAutoReview } = await import("../src/daemon/review.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { hashResult } = await import("../src/daemon/reviewstate.js");
    const { listEvents } = await import("../src/db/events.js");
    const repo = makeRepo(1);
    // last reviewed a DIFFERENT (older) sha; result unchanged
    const id = await reviewTask(1, repo.repo, repo.branch, {
      review_verdict: null,
      review_cycles: 1,
      review_head_sha: "oldshaoldsha",
      review_result_hash: hashResult("claims done"),
    });

    await maybeAutoReview(id);

    expect(spawnReviewer).toHaveBeenCalledOnce();
    const kinds = listEvents(20).map((e) => e.kind);
    expect(kinds).toContain("review.round_started");
    // the round records the sha it is now judging, so an idle re-entry won't re-fire
    expect(getTask(id)?.review_head_sha).toBe(repo.headSha);
  });

  it("does NOT re-trigger when neither the commit nor the result changed", async () => {
    const { maybeAutoReview } = await import("../src/daemon/review.js");
    const { hashResult } = await import("../src/daemon/reviewstate.js");
    const { listEvents } = await import("../src/db/events.js");
    const repo = makeRepo(2);
    const id = await reviewTask(2, repo.repo, repo.branch, {
      review_verdict: null,
      review_cycles: 1,
      review_head_sha: repo.headSha, // already reviewed THIS sha
      review_result_hash: hashResult("claims done"),
    });

    await maybeAutoReview(id);

    expect(spawnReviewer).not.toHaveBeenCalled();
    expect(listEvents(20).map((e) => e.kind)).not.toContain("review.round_started");
  });

  it("first entry into review (never reviewed) spawns round 1 even with no PR", async () => {
    const { maybeAutoReview } = await import("../src/daemon/review.js");
    const { listEvents } = await import("../src/db/events.js");
    const { getTask } = await import("../src/db/tasks.js");
    const repo = makeRepo(3);
    // no-PR task: open_pr flag is irrelevant to the trigger
    const { updateTask } = await import("../src/db/tasks.js");
    const id = await reviewTask(3, repo.repo, repo.branch);
    updateTask(id, { open_pr: 0 } as never);

    await maybeAutoReview(id);

    expect(spawnReviewer).toHaveBeenCalledOnce();
    expect(listEvents(20).map((e) => e.kind)).toContain("review.round_started");
    expect(getTask(id)?.review_head_sha).toBe(repo.headSha);
  });

  it("a scratch (no-branch, no-PR) task in review auto-spawns a reviewer", async () => {
    const { maybeAutoReview } = await import("../src/daemon/review.js");
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    // scratch tasks have no git branch — the trigger keys on the result_summary
    const t = createTask({
      title: "investigate",
      prompt: "x",
      repo: path.join(tmpDir, "scratch-8"),
      workspace_kind: "scratch",
      open_pr: false,
    });
    updateTask(t.id, { status: "review", result_summary: "found the root cause" });

    await maybeAutoReview(t.id);

    expect(spawnReviewer).toHaveBeenCalledOnce();
    expect(listEvents(20).map((e) => e.kind)).toContain("review.round_started");
  });

  it("a scratch task in review with NO result_summary is not reviewed yet", async () => {
    const { maybeAutoReview } = await import("../src/daemon/review.js");
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const t = createTask({
      title: "investigate",
      prompt: "x",
      repo: path.join(tmpDir, "scratch-9"),
      workspace_kind: "scratch",
      open_pr: false,
    });
    updateTask(t.id, { status: "review" }); // no result_summary
    await maybeAutoReview(t.id);
    expect(spawnReviewer).not.toHaveBeenCalled();
  });

  it("blocks + emits review.loop_exhausted at the cap (no reviewer spawned)", async () => {
    const { maybeAutoReview } = await import("../src/daemon/review.js");
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    setSchedulerConfig({ review_max_cycles: 3 });
    const repo = makeRepo(4);
    const id = await reviewTask(4, repo.repo, repo.branch, {
      review_verdict: null,
      review_cycles: 3, // already at the cap
      review_head_sha: "oldshaoldsha", // new work exists, but the cap wins
    });

    await maybeAutoReview(id);

    expect(spawnReviewer).not.toHaveBeenCalled();
    const kinds = listEvents(20).map((e) => e.kind);
    expect(kinds).toContain("review.loop_exhausted");
    expect(getTask(id)?.status).toBe("blocked");
  });
});

describe("verdict invalidation — the premature-merge fix", () => {
  it("a post-approval push supersedes the approval, re-drafts, and re-reviews", async () => {
    const { maybeAutoReview } = await import("../src/daemon/review.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { _setGhRunner } = await import("../src/daemon/prdraft.js");
    const { listEvents } = await import("../src/db/events.js");
    const gh: string[][] = [];
    _setGhRunner(async (args) => {
      gh.push(args);
      return "";
    });
    const repo = makeRepo(5);
    const id = await reviewTask(5, repo.repo, repo.branch, {
      review_verdict: "approve",
      review_notes: "looked good at the time",
      review_head_sha: "oldshaoldsha", // approved an EARLIER diff than HEAD
      review_cycles: 0,
      pr_url: "https://github.com/x/y/pull/5",
      pr_is_draft: 0, // currently ready
    });

    await maybeAutoReview(id);

    // re-drafted (gh pr ready --undo) and marked draft
    expect(gh.some((a) => a[1] === "ready" && a[2] === "--undo")).toBe(true);
    const t = getTask(id)!;
    expect(t.pr_is_draft).toBe(1);
    expect(t.review_verdict).toBeNull(); // no longer standing-approved
    // evidence kept, marked superseded with the superseding sha
    expect(t.review_notes).toContain("looked good at the time");
    expect(t.review_notes).toContain("superseded by push");
    expect(t.review_cycles).toBe(1); // supersede counts toward the cap
    const kinds = listEvents(30).map((e) => e.kind);
    expect(kinds).toContain("review.verdict_superseded");
    // and a fresh round is started against the new HEAD
    expect(spawnReviewer).toHaveBeenCalledOnce();
    expect(kinds).toContain("review.round_started");
    expect(t.review_head_sha).toBe(repo.headSha);
  });

  it("an approval whose HEAD is unchanged is NOT disturbed", async () => {
    const { maybeAutoReview } = await import("../src/daemon/review.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { _setGhRunner } = await import("../src/daemon/prdraft.js");
    const gh: string[][] = [];
    _setGhRunner(async (args) => {
      gh.push(args);
      return "";
    });
    const repo = makeRepo(6);
    const id = await reviewTask(6, repo.repo, repo.branch, {
      review_verdict: "approve",
      review_head_sha: repo.headSha, // approval matches current HEAD
      pr_url: "https://github.com/x/y/pull/6",
      pr_is_draft: 0,
    });

    await maybeAutoReview(id);

    expect(gh).toHaveLength(0); // no re-draft
    expect(spawnReviewer).not.toHaveBeenCalled();
    expect(getTask(id)?.review_verdict).toBe("approve");
  });

  it("invariant across the lifecycle: approve→ready, then a push→draft again", async () => {
    const { handleVerdict, maybeAutoReview } = await import("../src/daemon/review.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { _setGhRunner } = await import("../src/daemon/prdraft.js");
    _setGhRunner(async (args) => (args[1] === "view" ? "feat: x" : ""));
    const repo = makeRepo(7);
    const id = await reviewTask(7, repo.repo, repo.branch, {
      pr_url: "https://github.com/x/y/pull/7",
      pr_is_draft: 1,
    });

    // Approve current HEAD -> PR becomes non-draft, approved sha recorded.
    await handleVerdict(id, 42, "approve", "verified end to end");
    let t = getTask(id)!;
    expect(t.pr_is_draft).toBe(0); // non-draft IFF current HEAD approved
    expect(t.review_head_sha).toBe(repo.headSha);

    // A new commit lands on the branch after approval.
    repo.commitMore();
    await maybeAutoReview(id);

    t = getTask(id)!;
    expect(t.pr_is_draft).toBe(1); // invariant restored: HEAD no longer approved
    expect(t.review_verdict).toBeNull();
  });
});
