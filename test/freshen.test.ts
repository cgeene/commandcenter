import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Real git repos (init/clone/commit/push/merge) rather than mocks: the whole
// point of freshening is what git actually does to a branch, and a stubbed git
// would prove nothing about conflicts or the preserved diff. Same timeout
// reasoning as test/worktree.test.ts — these are slow under parallel load.
vi.setConfig({ testTimeout: 30_000 });

vi.mock("../src/daemon/tmux.js", () => ({
  windowExists: () => true,
  sendText: async () => {},
  capturePane: () => "",
  newWindow: () => "cc:1",
  killWindow: () => {},
  paneProcess: () => null,
  listLiveWindowIds: () => [],
}));

let tmpDir: string;
let remoteDir: string;
let repoDir: string;

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function commit(repo: string, message: string): void {
  git(repo, "add", "-A");
  git(repo, "-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-m", message);
}

function write(repo: string, name: string, contents: string): void {
  fs.writeFileSync(path.join(repo, name), contents);
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-freshen-"));
  process.env.CC_DATA_DIR = path.join(tmpDir, "data");
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  const { _resetFreshenState } = await import("../src/daemon/freshen.js");
  _resetFreshenState();

  remoteDir = path.join(tmpDir, "remote.git");
  fs.mkdirSync(remoteDir);
  git(remoteDir, "init", "--bare", "-b", "main");

  repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(repoDir);
  git(repoDir, "init", "-b", "main");
  git(repoDir, "remote", "add", "origin", remoteDir);
  git(repoDir, "config", "user.email", "t@t.com");
  git(repoDir, "config", "user.name", "t");
  write(repoDir, "shared.txt", "base\n");
  commit(repoDir, "chore: initial");
  git(repoDir, "push", "-u", "origin", "main");
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // The git work here is synchronous and can block this worker's event loop for
  // seconds; yield so vitest's worker RPC replies drain (see worktree.test.ts).
  await new Promise((resolve) => setImmediate(resolve));
});

/** A pushed agent branch for `taskId` that changed one file, plus the task row
 *  in the state the freshener expects (parked in review with an open PR). */
async function setupAgentTask(opts: {
  file: string;
  contents: string;
  verifyCmd?: string;
  approved?: boolean;
}) {
  const { createTask, updateTask } = await import("../src/db/tasks.js");
  const task = createTask({
    title: `t-${opts.file}`,
    prompt: "do the thing",
    repo: repoDir,
    verify_cmd: opts.verifyCmd,
  });
  const branch = `agent/task-${task.id}`;
  git(repoDir, "checkout", "-q", "-b", branch);
  write(repoDir, opts.file, opts.contents);
  commit(repoDir, `feat: ${opts.file}`);
  git(repoDir, "push", "-q", "-u", "origin", branch);
  const tip = git(repoDir, "rev-parse", "HEAD");
  git(repoDir, "checkout", "-q", "main");
  updateTask(task.id, {
    status: "review",
    branch,
    pr_url: `https://github.com/o/r/pull/${task.id}`,
    pr_state: "open",
    pr_is_draft: 0,
    result_summary: `added ${opts.file}`,
    ...(opts.approved
      ? { review_verdict: "approve", review_head_sha: tip, review_cycles: 1 }
      : {}),
  });
  return { task: (await import("../src/db/tasks.js")).getTask(task.id)!, branch, tip };
}

/** Move the default branch forward on the remote. */
function advanceMain(file: string, contents: string): string {
  git(repoDir, "checkout", "-q", "main");
  write(repoDir, file, contents);
  commit(repoDir, `feat: main ${file}`);
  git(repoDir, "push", "-q", "origin", "main");
  return git(repoDir, "rev-parse", "HEAD");
}

async function eventKinds(): Promise<string[]> {
  const { listEvents } = await import("../src/db/events.js");
  return listEvents(200).map((e) => e.kind);
}

async function eventPayload(kind: string): Promise<Record<string, unknown>> {
  const { listEvents } = await import("../src/db/events.js");
  const event = listEvents(200).find((e) => e.kind === kind);
  return event?.payload ? (JSON.parse(event.payload) as Record<string, unknown>) : {};
}

describe("freshenPass — clean merge", () => {
  it("pushes the merge commit, preserves the diff against main, and carries the approval", async () => {
    const { freshenPass } = await import("../src/daemon/freshen.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { task, branch, tip } = await setupAgentTask({
      file: "feature.txt",
      contents: "feature\n",
      verifyCmd: "true",
      approved: true,
    });
    advanceMain("other.txt", "other\n");

    await freshenPass({ spawn: () => expect.unreachable("no respawn expected") });

    const newTip = git(repoDir, "rev-parse", `origin/${branch}`);
    expect(newTip).not.toBe(tip);
    // A real merge commit (two parents), with main's tip as an ancestor.
    expect(git(repoDir, "rev-list", "--parents", "-n", "1", newTip).split(" ")).toHaveLength(3);
    expect(() =>
      git(repoDir, "merge-base", "--is-ancestor", "origin/main", newTip),
    ).not.toThrow();
    // The reviewed content is untouched: the branch's diff against main is still
    // exactly its own change, which is why the approval may be carried forward.
    expect(git(repoDir, "diff", "--name-only", "origin/main", newTip)).toBe("feature.txt");
    // Local ref followed the push, so a respawn/reviewer sees the merged state.
    expect(git(repoDir, "rev-parse", branch)).toBe(newTip);

    const fresh = getTask(task.id)!;
    expect(fresh.status).toBe("review");
    expect(fresh.review_verdict).toBe("approve");
    expect(fresh.review_head_sha).toBe(newTip); // approval carried to the merge
    expect(fresh.pr_is_draft).toBe(0); // never re-drafted for a mechanical merge

    expect(await eventKinds()).toContain("pr.freshened");
    expect(await eventPayload("pr.freshened")).toMatchObject({
      approval_carried: true,
      local_ref_synced: true,
      verified: true,
    });

    // The human was already told this PR is mergeable; a carried approval must
    // not re-announce it just because the HEAD moved.
    const { notifyLatched } = await import("../src/db/notifylatch.js");
    const { approvedReadyLatchKey } = await import("../src/daemon/review.js");
    expect(notifyLatched(approvedReadyLatchKey(task.id, newTip))).toBe(true);
  });

  it("leaves the carried approval alone when the review loop looks again", async () => {
    const { freshenPass } = await import("../src/daemon/freshen.js");
    const { maybeAutoReview } = await import("../src/daemon/review.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { task } = await setupAgentTask({
      file: "feature.txt",
      contents: "feature\n",
      approved: true,
    });
    advanceMain("other.txt", "other\n");

    await freshenPass({ spawn: () => expect.unreachable("no respawn expected") });
    await maybeAutoReview(task.id);

    const fresh = getTask(task.id)!;
    expect(fresh.review_verdict).toBe("approve"); // not superseded by our merge
    expect(fresh.review_cycles).toBe(1); // no extra round burned
    expect(fresh.pr_is_draft).toBe(0);
    expect(await eventKinds()).not.toContain("review.verdict_superseded");
    expect(await eventKinds()).not.toContain("review.round_started");
  });

  it("does nothing at all when the branch already contains main", async () => {
    const { freshenPass } = await import("../src/daemon/freshen.js");
    const { branch, tip } = await setupAgentTask({ file: "a.txt", contents: "a\n" });

    await freshenPass({ spawn: () => expect.unreachable("no respawn expected") });

    expect(git(repoDir, "rev-parse", `origin/${branch}`)).toBe(tip);
    expect(await eventKinds()).not.toContain("pr.freshen_attempt");
  });
});

describe("freshenPass — conflict", () => {
  it("pushes nothing and respawns the worker with the standard conflict brief", async () => {
    const { freshenPass } = await import("../src/daemon/freshen.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { task, branch, tip } = await setupAgentTask({
      file: "shared.txt",
      contents: "branch side\n",
    });
    advanceMain("shared.txt", "main side\n");

    const spawned: number[] = [];
    await freshenPass({ spawn: (id) => spawned.push(id) });

    expect(git(repoDir, "rev-parse", `origin/${branch}`)).toBe(tip); // nothing pushed
    expect(spawned).toEqual([task.id]);

    const fresh = getTask(task.id)!;
    expect(fresh.status).toBe("queued"); // requeued so the worker can be spawned
    expect(fresh.agent_id).toBeNull();
    // The standardized brief, appended to the prompt so it reaches both a fresh
    // and a resumed session.
    expect(fresh.prompt).toContain("do the thing");
    expect(fresh.prompt).toContain("Integration fix round 1");
    expect(fresh.prompt).toContain("ALREADY COMPLETE");
    expect(fresh.prompt).toContain("git merge origin/main");
    expect(fresh.prompt).toContain("never a rebase");
    expect(fresh.prompt).toContain("keeping BOTH sides' intent");
    expect(fresh.prompt).toContain("`shared.txt`");
    expect(fresh.prompt).toContain(`git push origin ${branch}`);
    expect(fresh.prompt).toContain("added shared.txt"); // its own result summary

    expect(await eventPayload("pr.freshen_conflict")).toMatchObject({
      conflicts: ["shared.txt"],
      respawned: true,
    });
    // The throwaway merge tree never survives a failed attempt.
    expect(fs.existsSync(path.join(tmpDir, "data", "worktrees"))).toBe(true);
    expect(
      fs
        .readdirSync(path.join(tmpDir, "data", "worktrees"))
        .filter((d) => d.endsWith("-freshen")),
    ).toEqual([]);
  });
});

describe("freshenPass — verification", () => {
  it("does not push when the merged tree fails the task's verify command", async () => {
    const { freshenPass } = await import("../src/daemon/freshen.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { task, branch, tip } = await setupAgentTask({
      file: "feature.txt",
      contents: "feature\n",
      verifyCmd: "echo boom >&2; exit 1",
    });
    advanceMain("other.txt", "other\n");

    const spawned: number[] = [];
    await freshenPass({ spawn: (id) => spawned.push(id) });

    expect(git(repoDir, "rev-parse", `origin/${branch}`)).toBe(tip); // nothing pushed
    expect(spawned).toEqual([task.id]);
    const fresh = getTask(task.id)!;
    expect(fresh.prompt).toContain("verification FAILED");
    expect(fresh.prompt).toContain("boom");
    expect(await eventPayload("pr.freshen_verify_failed")).toMatchObject({
      respawned: true,
    });
    expect(await eventKinds()).not.toContain("pr.freshened");
  });

  it("throws the merge away when the task moves on while verification runs", async () => {
    const { freshenPass } = await import("../src/daemon/freshen.js");
    const { updateTask } = await import("../src/db/tasks.js");
    const { task, branch, tip } = await setupAgentTask({
      file: "feature.txt",
      contents: "feature\n",
      verifyCmd: "true",
    });
    advanceMain("other.txt", "other\n");

    await freshenPass({
      spawn: () => expect.unreachable("no respawn expected"),
      // The human merged the PR (or cancelled the task) mid-verification.
      runVerify: async () => {
        updateTask(task.id, { status: "done", pr_state: "merged" });
        return { ok: true, output: "" };
      },
    });

    expect(git(repoDir, "rev-parse", `origin/${branch}`)).toBe(tip); // nothing pushed
    expect(await eventKinds()).toContain("pr.freshen_abandoned");
    expect(await eventKinds()).not.toContain("pr.freshened");
  });
});

describe("freshenPass — storm control", () => {
  it("halts and notifies once when a PR keeps needing freshening without merging", async () => {
    const { freshenPass } = await import("../src/daemon/freshen.js");
    const { logEvent, listEvents } = await import("../src/db/events.js");
    const { setIntegrationSettings } = await import("../src/db/settings.js");
    setIntegrationSettings({ freshen_max_attempts: 2 });
    const { task, branch, tip } = await setupAgentTask({
      file: "shared.txt",
      contents: "branch side\n",
    });
    advanceMain("shared.txt", "main side\n");
    logEvent("pr.freshen_attempt", { taskId: task.id });
    logEvent("pr.freshen_attempt", { taskId: task.id });

    await freshenPass({ spawn: () => expect.unreachable("must not respawn once halted") });
    await freshenPass({ spawn: () => expect.unreachable("must not respawn once halted") });

    expect(git(repoDir, "rev-parse", `origin/${branch}`)).toBe(tip);
    const halts = listEvents(200).filter((e) => e.kind === "pr.freshen_halted");
    expect(halts).toHaveLength(1); // said once, not every pass
    expect(
      listEvents(200).filter((e) => e.kind === "pr.freshen_attempt"),
    ).toHaveLength(2); // no new attempts were made
  });

  it("queues a merge burst instead of freshening every stale PR at once", async () => {
    const { freshenPass } = await import("../src/daemon/freshen.js");
    const { setIntegrationSettings } = await import("../src/db/settings.js");
    const { listEvents } = await import("../src/db/events.js");
    setIntegrationSettings({ freshen_per_pass_limit: 1 });
    await setupAgentTask({ file: "one.txt", contents: "1\n" });
    await setupAgentTask({ file: "two.txt", contents: "2\n" });
    await setupAgentTask({ file: "three.txt", contents: "3\n" });
    advanceMain("other.txt", "other\n");

    await freshenPass({ spawn: () => expect.unreachable("no respawn expected") });

    expect(listEvents(200).filter((e) => e.kind === "pr.freshened")).toHaveLength(1);
    expect(listEvents(200).filter((e) => e.kind === "pr.freshen_deferred")).toHaveLength(2);

    // The deferred ones are picked up by the following pass.
    await freshenPass({ spawn: () => expect.unreachable("no respawn expected") });
    expect(listEvents(200).filter((e) => e.kind === "pr.freshened")).toHaveLength(2);
  });

  it("is disabled by the auto_freshen switch", async () => {
    const { freshenPass } = await import("../src/daemon/freshen.js");
    const { setIntegrationSettings } = await import("../src/db/settings.js");
    setIntegrationSettings({ auto_freshen: false });
    const { branch, tip } = await setupAgentTask({ file: "a.txt", contents: "a\n" });
    advanceMain("other.txt", "other\n");

    await freshenPass();

    expect(git(repoDir, "rev-parse", `origin/${branch}`)).toBe(tip);
    expect(await eventKinds()).not.toContain("pr.freshen_attempt");
  });
});

describe("freshenCandidates — guard rails", () => {
  it("never touches a branch that is not this task's agent branch", async () => {
    const { freshenPass, freshenCandidates } = await import("../src/daemon/freshen.js");
    const { updateTask } = await import("../src/db/tasks.js");
    const { task } = await setupAgentTask({ file: "a.txt", contents: "a\n" });
    advanceMain("other.txt", "other\n");
    // A hand-made branch, and another task's branch: both are off limits.
    git(repoDir, "branch", "feature/manual", `agent/task-${task.id}`);
    git(repoDir, "push", "-q", "origin", "feature/manual");
    updateTask(task.id, { branch: "feature/manual" });
    expect(freshenCandidates()).toEqual([]);

    updateTask(task.id, { branch: `agent/task-${task.id + 99}` });
    expect(freshenCandidates()).toEqual([]);

    await freshenPass({ spawn: () => expect.unreachable("no respawn expected") });
    expect(git(repoDir, "rev-parse", "origin/feature/manual")).toBe(
      git(repoDir, "rev-parse", `origin/agent/task-${task.id}`),
    );
    expect(await eventKinds()).not.toContain("pr.freshen_attempt");
  });

  it("skips a task whose worker or reviewer is still live", async () => {
    const { freshenCandidates } = await import("../src/daemon/freshen.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { task } = await setupAgentTask({ file: "a.txt", contents: "a\n" });
    expect(freshenCandidates().map((t) => t.id)).toEqual([task.id]);
    createAgent({ kind: "reviewer", state: "working", task_id: task.id });
    expect(freshenCandidates()).toEqual([]);
  });

  it("skips merged/closed PRs, branch-only tasks, and human-publication tasks", async () => {
    const { freshenCandidates } = await import("../src/daemon/freshen.js");
    const { updateTask } = await import("../src/db/tasks.js");
    const { task } = await setupAgentTask({ file: "a.txt", contents: "a\n" });
    for (const patch of [
      { pr_state: "merged" },
      { pr_state: "closed" },
      { pr_state: null },
      { open_pr: 0 },
      { publication_mode: "human" as const },
      { status: "in_progress" as const },
    ]) {
      updateTask(task.id, patch);
      expect(freshenCandidates()).toEqual([]);
      updateTask(task.id, {
        pr_state: "open",
        open_pr: 1,
        publication_mode: "agent",
        status: "review",
      });
    }
    expect(freshenCandidates().map((t) => t.id)).toEqual([task.id]);
  });
});

describe("mergeNudgePass", () => {
  it("nudges once when an approved PR waits while other tasks in the repo are active", async () => {
    const { mergeNudgePass } = await import("../src/daemon/freshen.js");
    const { createTask } = await import("../src/db/tasks.js");
    const { logEvent, listEvents } = await import("../src/db/events.js");
    const { task } = await setupAgentTask({
      file: "a.txt",
      contents: "a\n",
      approved: true,
    });
    logEvent("review.approved", { taskId: task.id });

    // Nothing else in the repo: waiting costs nobody anything.
    mergeNudgePass(new Date(Date.now() + 10 * 60 * 60_000));
    expect(listEvents(50).filter((e) => e.kind === "pr.merge_nudge")).toHaveLength(0);

    createTask({ title: "next", prompt: "x", repo: repoDir });
    // Inside the window still says nothing.
    mergeNudgePass(new Date());
    expect(listEvents(50).filter((e) => e.kind === "pr.merge_nudge")).toHaveLength(0);

    const later = new Date(Date.now() + 10 * 60 * 60_000);
    mergeNudgePass(later);
    mergeNudgePass(later);
    expect(listEvents(50).filter((e) => e.kind === "pr.merge_nudge")).toHaveLength(1);
  });

  it("stays silent for a draft PR, an unapproved task, or a disabled window", async () => {
    const { mergeNudgePass } = await import("../src/daemon/freshen.js");
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { setIntegrationSettings } = await import("../src/db/settings.js");
    const { task } = await setupAgentTask({
      file: "a.txt",
      contents: "a\n",
      approved: true,
    });
    createTask({ title: "next", prompt: "x", repo: repoDir });
    const later = new Date(Date.now() + 10 * 60 * 60_000);

    updateTask(task.id, { pr_is_draft: 1 });
    mergeNudgePass(later);
    updateTask(task.id, { pr_is_draft: 0, review_verdict: null });
    mergeNudgePass(later);
    updateTask(task.id, { review_verdict: "approve" });
    setIntegrationSettings({ merge_nudge_minutes: null });
    mergeNudgePass(later);
    expect(listEvents(50).filter((e) => e.kind === "pr.merge_nudge")).toHaveLength(0);
  });
});

describe("integrationPass", () => {
  it("swallows failures and never runs two passes at once", async () => {
    const { integrationPass } = await import("../src/daemon/freshen.js");
    const { updateTask } = await import("../src/db/tasks.js");
    const { task } = await setupAgentTask({ file: "a.txt", contents: "a\n" });
    // A repo path that no longer exists: every git call throws.
    updateTask(task.id, { repo: path.join(tmpDir, "gone") });

    await expect(integrationPass()).resolves.toBeUndefined();
    expect(await eventKinds()).toContain("pr.freshen_error");
  });
});
