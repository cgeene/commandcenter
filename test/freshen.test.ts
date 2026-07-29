import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Two fixtures, deliberately. `freshenCandidates`, `mergeNudgePass` and the
// `auto_freshen` switch are pure database predicates — freshenPass does no git
// at all until a candidate survives them — so those cases build no repo and run
// in microseconds. Only the cases whose subject IS what git does to a branch (a
// real merge commit, a real conflict, a push that must not happen) pay for a
// real remote.
//
// Fixture git is issued as one batched `sh -c` script rather than a call per
// command: inside a vitest worker each execFileSync fork costs ~160ms (it
// copies the worker's heap page tables), so the invocation COUNT — not git
// itself — was this file's dominant cost.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

vi.mock("../src/daemon/tmux.js", () => ({
  windowExists: () => true,
  sendText: async () => {},
  capturePane: () => "",
  newWindow: () => "cc:1",
  killWindow: () => {},
  paneProcess: () => null,
  listWindows: () => ({ live: [], dead: [], server: "running" }),
}));

let tmpDir: string;
let remoteDir: string;
let repoDir: string;
let notifyModule: typeof import("../src/daemon/notify.js");
const realFetch = globalThis.fetch;

/** Titles of the pushes produced so far. ntfy is configured so "and does NOT
 *  notify" assertions are real rather than vacuously true for want of a URL;
 *  dispatch is daemon-only, so a test run records the pushes instead of sending
 *  them (see test/notify-dispatch-guard.test.ts). */
function pushTitles(): string[] {
  return notifyModule.recordedPushes().map((push) => push.title);
}

/** Just the "approved — PR ready to merge" pushes, so a test that also provokes
 *  a merge nudge still counts the latch it cares about. */
function readyPushes(): string[] {
  return pushTitles().filter((title) => title.includes("ready to merge"));
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

/** Run several git commands in ONE subprocess. Returns trimmed stdout, so a
 *  script ending in `echo "$SHA"` hands the sha back. */
function gitScript(script: string, env: Record<string, string>): string {
  return execFileSync("sh", ["-eu", "-c", script], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  }).trim();
}

/** Per-test data dir, notify recorder and freshen latch. No git. */
async function resetRuntime(): Promise<void> {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-freshen-"));
  process.env.CC_DATA_DIR = path.join(tmpDir, "data");
  process.env.CC_NTFY_URL = "https://ntfy.test/cc";
  globalThis.fetch = vi.fn(async () => new Response("ok")) as unknown as typeof fetch;
  notifyModule = await import("../src/daemon/notify.js");
  notifyModule.clearRecordedPushes();
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  const { _resetFreshenState } = await import("../src/daemon/freshen.js");
  _resetFreshenState();
}

async function teardownRuntime(): Promise<void> {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  globalThis.fetch = realFetch;
  delete process.env.CC_NTFY_URL;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // The git work here is synchronous and can block this worker's event loop for
  // seconds; yield so vitest's worker RPC replies drain (see worktree.test.ts).
  await new Promise((resolve) => setImmediate(resolve));
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

async function countEvents(kind: string): Promise<number> {
  const { listEvents } = await import("../src/db/events.js");
  return listEvents(200).filter((e) => e.kind === kind).length;
}

// ---------------------------------------------------------------------------
// Gating, nudges and error handling: pure database predicates, no repo built.
// ---------------------------------------------------------------------------

describe("freshen gating, nudges and error handling", () => {
  beforeEach(resetRuntime);
  afterEach(teardownRuntime);

  /** A task row in the state the freshener expects: parked in review with an
   *  open non-draft PR on its own agent branch. No git anywhere. */
  async function reviewTask(patch: Record<string, unknown> = {}) {
    const { createTask, updateTask, getTask } = await import("../src/db/tasks.js");
    const task = createTask({ title: "t", prompt: "do the thing", repo: tmpDir });
    updateTask(task.id, {
      status: "review",
      branch: `agent/task-${task.id}`,
      pr_url: `https://github.com/o/r/pull/${task.id}`,
      pr_state: "open",
      pr_is_draft: 0,
      result_summary: "did it",
      ...patch,
    });
    return getTask(task.id)!;
  }

  it("only ever considers this task's own agent branch", async () => {
    const { freshenCandidates } = await import("../src/daemon/freshen.js");
    const { updateTask } = await import("../src/db/tasks.js");
    const task = await reviewTask();
    expect(freshenCandidates().map((t) => t.id)).toEqual([task.id]);

    for (const branch of [
      "feature/manual", // a hand-made branch
      `agent/task-${task.id + 99}`, // another task's branch
      "main",
      null,
    ]) {
      updateTask(task.id, { branch });
      expect(freshenCandidates(), `branch ${branch}`).toEqual([]);
    }
    updateTask(task.id, { branch: `agent/task-${task.id}` });
    expect(freshenCandidates().map((t) => t.id)).toEqual([task.id]);
    // The resume-suffixed form of this task's branch is still its own.
    updateTask(task.id, { branch: `agent/task-${task.id}-resume-2` });
    expect(freshenCandidates().map((t) => t.id)).toEqual([task.id]);
  });

  it("skips a task whose worker or reviewer is still live", async () => {
    const { freshenCandidates } = await import("../src/daemon/freshen.js");
    const { createAgent } = await import("../src/db/agents.js");
    const task = await reviewTask();
    expect(freshenCandidates().map((t) => t.id)).toEqual([task.id]);
    createAgent({ kind: "reviewer", state: "working", task_id: task.id });
    expect(freshenCandidates()).toEqual([]);
  });

  it("skips merged/closed PRs, branch-only tasks, and human-publication tasks", async () => {
    const { freshenCandidates } = await import("../src/daemon/freshen.js");
    const { updateTask } = await import("../src/db/tasks.js");
    const task = await reviewTask();
    for (const patch of [
      { pr_state: "merged" },
      { pr_state: "closed" },
      { pr_state: null },
      { open_pr: 0 },
      { publication_mode: "human" as const },
      { status: "in_progress" as const },
    ]) {
      updateTask(task.id, patch);
      expect(freshenCandidates(), JSON.stringify(patch)).toEqual([]);
      updateTask(task.id, {
        pr_state: "open",
        open_pr: 1,
        publication_mode: "agent",
        status: "review",
      });
    }
    expect(freshenCandidates().map((t) => t.id)).toEqual([task.id]);
  });

  it("is disabled by the auto_freshen switch", async () => {
    const { freshenPass } = await import("../src/daemon/freshen.js");
    const { setIntegrationSettings } = await import("../src/db/settings.js");
    const { updateTask } = await import("../src/db/tasks.js");
    const task = await reviewTask();
    // A repo path that does not exist, so the first git call freshenPass makes
    // is guaranteed to fail loudly. With the switch off it must never get that
    // far; with it on the error proves the task really was a live candidate and
    // the silence above was the switch, not an empty queue.
    updateTask(task.id, { repo: path.join(tmpDir, "gone") });

    setIntegrationSettings({ auto_freshen: false });
    await freshenPass({ spawn: () => expect.unreachable("no respawn expected") });
    expect(await eventKinds()).toEqual([]);

    setIntegrationSettings({ auto_freshen: true });
    await freshenPass({ spawn: () => expect.unreachable("no respawn expected") });
    expect(await eventKinds()).toContain("pr.freshen_error");
  });

  it("swallows failures and never runs two passes at once", async () => {
    const { integrationPass } = await import("../src/daemon/freshen.js");
    const { updateTask } = await import("../src/db/tasks.js");
    const task = await reviewTask();
    updateTask(task.id, { repo: path.join(tmpDir, "gone") });

    await expect(integrationPass()).resolves.toBeUndefined();
    expect(await eventKinds()).toContain("pr.freshen_error");
  });

  it("nudges once when an approved PR waits while its repo moves on", async () => {
    const { mergeNudgePass } = await import("../src/daemon/freshen.js");
    const { createTask } = await import("../src/db/tasks.js");
    const { logEvent } = await import("../src/db/events.js");
    const task = await reviewTask({ review_verdict: "approve", review_cycles: 1 });
    logEvent("review.approved", { taskId: task.id });
    const later = new Date(Date.now() + 10 * 60 * 60_000);

    // Nothing else in the repo: waiting costs nobody anything.
    mergeNudgePass(later);
    expect(await countEvents("pr.merge_nudge")).toBe(0);

    createTask({ title: "next", prompt: "x", repo: tmpDir });
    mergeNudgePass(new Date()); // inside the window: still silent
    expect(await countEvents("pr.merge_nudge")).toBe(0);

    mergeNudgePass(later);
    mergeNudgePass(later);
    expect(await countEvents("pr.merge_nudge")).toBe(1); // said once, not per pass
    expect(pushTitles()).toEqual([
      `task #${task.id} — approved PR waiting while its repo moves on`,
    ]);
  });

  it("stays silent for a draft PR, an unapproved task, or a disabled window", async () => {
    const { mergeNudgePass } = await import("../src/daemon/freshen.js");
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const { logEvent } = await import("../src/db/events.js");
    const { setIntegrationSettings } = await import("../src/db/settings.js");
    const task = await reviewTask({ review_verdict: "approve", review_cycles: 1 });
    logEvent("review.approved", { taskId: task.id });
    createTask({ title: "next", prompt: "x", repo: tmpDir });
    const later = new Date(Date.now() + 10 * 60 * 60_000);

    updateTask(task.id, { pr_is_draft: 1 });
    mergeNudgePass(later);
    updateTask(task.id, { pr_is_draft: 0, review_verdict: null });
    mergeNudgePass(later);
    updateTask(task.id, { review_verdict: "approve" });
    setIntegrationSettings({ merge_nudge_minutes: null });
    mergeNudgePass(later);
    expect(await countEvents("pr.merge_nudge")).toBe(0);

    // ...and the same row DOES nudge once the three blockers are lifted, so the
    // silence above is the guards and not a broken fixture.
    setIntegrationSettings({ merge_nudge_minutes: 60 });
    mergeNudgePass(later);
    expect(await countEvents("pr.merge_nudge")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// What git actually does to the branch: real bare remote, real merges.
// ---------------------------------------------------------------------------

describe("freshenPass — real git", () => {
  beforeEach(async () => {
    await resetRuntime();
    remoteDir = path.join(tmpDir, "remote.git");
    repoDir = path.join(tmpDir, "repo");
    gitScript(
      `mkdir -p "$REMOTE" "$REPO"
       git -C "$REMOTE" init -q --bare -b main
       git -C "$REPO" init -q -b main
       git -C "$REPO" remote add origin "$REMOTE"
       git -C "$REPO" config user.email t@t.com
       git -C "$REPO" config user.name t
       printf 'base\n' > "$REPO/shared.txt"
       git -C "$REPO" add -A
       git -C "$REPO" commit -q -m 'chore: initial'
       git -C "$REPO" push -q -u origin main`,
      { REMOTE: remoteDir, REPO: repoDir },
    );
  });
  afterEach(teardownRuntime);

  /** A pushed agent branch for a new task that changed one file, plus the task
   *  row in the state the freshener expects (parked in review with an open PR). */
  async function setupAgentTask(opts: {
    file: string;
    contents: string;
    verifyCmd?: string;
    approved?: boolean;
  }) {
    const { createTask, updateTask, getTask } = await import("../src/db/tasks.js");
    const task = createTask({
      title: `t-${opts.file}`,
      prompt: "do the thing",
      repo: repoDir,
      verify_cmd: opts.verifyCmd,
    });
    const branch = `agent/task-${task.id}`;
    const tip = gitScript(
      `git -C "$REPO" checkout -q -b "$BRANCH"
       printf '%s' "$CONTENTS" > "$REPO/$FILE"
       git -C "$REPO" add -A
       git -C "$REPO" commit -q -m "feat: $FILE"
       git -C "$REPO" push -q -u origin "$BRANCH"
       TIP=$(git -C "$REPO" rev-parse HEAD)
       git -C "$REPO" checkout -q main
       echo "$TIP"`,
      { REPO: repoDir, BRANCH: branch, FILE: opts.file, CONTENTS: opts.contents },
    );
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
    return { task: getTask(task.id)!, branch, tip };
  }

  /** Move the default branch forward on the remote. */
  function advanceMain(file: string, contents: string): void {
    gitScript(
      `git -C "$REPO" checkout -q main
       printf '%s' "$CONTENTS" > "$REPO/$FILE"
       git -C "$REPO" add -A
       git -C "$REPO" commit -q -m "feat: main $FILE"
       git -C "$REPO" push -q origin main`,
      { REPO: repoDir, FILE: file, CONTENTS: contents },
    );
  }

  it("pushes the merge commit, preserves the diff against main, and carries the approval", async () => {
    const { freshenPass, mergeNudgePass } = await import("../src/daemon/freshen.js");
    const { createTask, getTask } = await import("../src/db/tasks.js");
    const { logEvent } = await import("../src/db/events.js");
    const { notifyApprovedReady, maybeAutoReview } = await import(
      "../src/daemon/review.js"
    );
    const { task, branch, tip } = await setupAgentTask({
      file: "feature.txt",
      contents: "feature\n",
      verifyCmd: "true",
      approved: true,
    });
    // What approval time really does: the ready-to-merge push goes out for the
    // approved SHA, claiming its latch. That is the precondition for carrying
    // the latch forward below.
    notifyApprovedReady(getTask(task.id)!);
    expect(readyPushes()).toHaveLength(1);

    // A contender in the same repo, and one nudge already spent, so the
    // post-freshen nudge assertion below is about the key and not about an
    // unnudgeable row.
    logEvent("review.approved", { taskId: task.id });
    createTask({ title: "next", prompt: "x", repo: repoDir });
    const later = new Date(Date.now() + 10 * 60 * 60_000);
    mergeNudgePass(later);
    expect(await countEvents("pr.merge_nudge")).toBe(1);

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

    // The human was already told this PR is mergeable, so the latch is carried
    // onto the merge SHA and the standing-state sweep stays silent rather than
    // re-announcing the same PR because its HEAD moved.
    const { notifyLatched } = await import("../src/db/notifylatch.js");
    const { approvedReadyLatchKey } = await import("../src/daemon/review.js");
    expect(notifyLatched(approvedReadyLatchKey(task.id, newTip))).toBe(true);
    notifyApprovedReady(getTask(task.id)!);
    expect(readyPushes()).toHaveLength(1); // still just the approval-time push

    // The review loop looking again must not supersede the carried approval or
    // burn a round on our own merge commit.
    await maybeAutoReview(task.id);
    const after = getTask(task.id)!;
    expect(after.review_verdict).toBe("approve");
    expect(after.review_cycles).toBe(1);
    expect(after.pr_is_draft).toBe(0);
    expect(await eventKinds()).not.toContain("review.verdict_superseded");
    expect(await eventKinds()).not.toContain("review.round_started");

    // Freshening advanced review_head_sha onto the merge commit for the SAME
    // approval, so anything SHA-keyed would page the human again per re-merge.
    mergeNudgePass(later);
    expect(await countEvents("pr.merge_nudge")).toBe(1);
    expect(pushTitles().filter((t) => t.includes("approved PR waiting"))).toHaveLength(1);
  });

  it("does not swallow the ready-to-merge push that was never delivered", async () => {
    // The PR is approved but stuck as a draft (`gh pr ready` failed), so
    // notifyApprovedReady dispatched NOTHING and no latch exists for the
    // approved SHA. Freshening must not claim a latch on the merge SHA for a
    // push the human never got — the sweep after a manual ready-flip is exactly
    // what is supposed to deliver it.
    const { freshenPass } = await import("../src/daemon/freshen.js");
    const { notifyApprovedReady } = await import("../src/daemon/review.js");
    const { getTask, updateTask } = await import("../src/db/tasks.js");
    const { task, branch, tip } = await setupAgentTask({
      file: "feature.txt",
      contents: "feature\n",
      approved: true,
    });
    updateTask(task.id, { pr_is_draft: 1 });
    notifyApprovedReady(getTask(task.id)!); // no-op: a draft PR is not mergeable
    expect(pushTitles()).toEqual([]);
    advanceMain("other.txt", "other\n");

    await freshenPass({ spawn: () => expect.unreachable("no respawn expected") });

    const newTip = git(repoDir, "rev-parse", `origin/${branch}`);
    expect(newTip).not.toBe(tip);
    expect(getTask(task.id)!.review_head_sha).toBe(newTip); // approval carried

    // The human flips the PR ready by hand; prsync records it and re-derives the
    // standing state. The push must land — exactly once.
    updateTask(task.id, { pr_is_draft: 0 });
    notifyApprovedReady(getTask(task.id)!);
    notifyApprovedReady(getTask(task.id)!);
    expect(pushTitles()).toEqual([
      `task #${task.id} reviewed & approved — PR ready to merge`,
    ]);
  });

  // Both no-push outcomes in ONE pass. They were two tests paying for two
  // fixtures and two real merges to prove the same rule -- freshening pushes
  // NOTHING unless the merge is clean AND verification passes -- and running
  // them together additionally proves one task's failure does not contaminate
  // the other's handling, which is what a pass actually does in production.
  // The default freshen_per_pass_limit is 2, so both are processed.
  it("pushes nothing and respawns the worker, for a conflict and for a failed verify", async () => {
    const { freshenPass } = await import("../src/daemon/freshen.js");
    const { getTask } = await import("../src/db/tasks.js");
    // main moves shared.txt, which conflicts with the first branch and merges
    // cleanly into the second (whose own change is feature.txt).
    const conflicted = await setupAgentTask({
      file: "shared.txt",
      contents: "branch side\n",
    });
    const verifyFailed = await setupAgentTask({
      file: "feature.txt",
      contents: "feature\n",
      verifyCmd: "echo boom >&2; exit 1",
    });
    advanceMain("shared.txt", "main side\n");

    const spawned: number[] = [];
    await freshenPass({ spawn: (id) => spawned.push(id) });

    // Neither branch moved on origin, and both workers were handed back the work.
    for (const { branch, tip } of [conflicted, verifyFailed]) {
      expect(git(repoDir, "rev-parse", `origin/${branch}`), branch).toBe(tip);
    }
    expect([...spawned].sort()).toEqual(
      [conflicted.task.id, verifyFailed.task.id].sort(),
    );
    expect(await eventKinds()).not.toContain("pr.freshened");

    // The conflict side: requeued, with the standardized brief appended to the
    // prompt so it reaches both a fresh and a resumed session.
    const c = getTask(conflicted.task.id)!;
    expect(c.status).toBe("queued"); // requeued so the worker can be spawned
    expect(c.agent_id).toBeNull();
    expect(c.prompt).toContain("do the thing");
    expect(c.prompt).toContain("Integration fix round 1");
    expect(c.prompt).toContain("ALREADY COMPLETE");
    expect(c.prompt).toContain("git merge origin/main");
    expect(c.prompt).toContain("never a rebase");
    expect(c.prompt).toContain("keeping BOTH sides' intent");
    expect(c.prompt).toContain("`shared.txt`");
    expect(c.prompt).toContain(`git push origin ${conflicted.branch}`);
    expect(c.prompt).toContain("added shared.txt"); // its own result summary
    expect(await eventPayload("pr.freshen_conflict")).toMatchObject({
      conflicts: ["shared.txt"],
      respawned: true,
    });

    // The verify side: a different brief, carrying the failure output.
    const v = getTask(verifyFailed.task.id)!;
    expect(v.prompt).toContain("verification FAILED");
    expect(v.prompt).toContain("boom");
    expect(await eventPayload("pr.freshen_verify_failed")).toMatchObject({
      respawned: true,
    });

    // The throwaway merge tree never survives a failed attempt, either kind.
    expect(
      fs
        .readdirSync(path.join(tmpDir, "data", "worktrees"))
        .filter((d) => d.endsWith("-freshen")),
    ).toEqual([]);
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

  it("halts and notifies once when a PR keeps needing freshening without merging", async () => {
    const { freshenPass } = await import("../src/daemon/freshen.js");
    const { logEvent } = await import("../src/db/events.js");
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
    expect(await countEvents("pr.freshen_halted")).toBe(1); // said once, not every pass
    expect(await countEvents("pr.freshen_attempt")).toBe(2); // no new attempts were made
  });

  it("never halts a PR that is already up to date, however many freshens it took", async () => {
    // The cap is on a PR that KEEPS NEEDING freshening. Clean re-merges followed
    // by a human who has not merged yet is the happy path, and it must not turn
    // into "the platform stopped re-merging its PR" on the next poll.
    const { freshenPass } = await import("../src/daemon/freshen.js");
    const { logEvent } = await import("../src/db/events.js");
    const { setIntegrationSettings } = await import("../src/db/settings.js");
    setIntegrationSettings({ freshen_max_attempts: 2 });
    const { task, branch, tip } = await setupAgentTask({
      file: "feature.txt",
      contents: "feature\n",
    });
    // At (and over) the cap, but the branch needs nothing: main has not moved
    // past it.
    logEvent("pr.freshen_attempt", { taskId: task.id });
    logEvent("pr.freshen_attempt", { taskId: task.id });
    logEvent("pr.freshen_attempt", { taskId: task.id });

    await freshenPass({ spawn: () => expect.unreachable("no respawn expected") });
    await freshenPass({ spawn: () => expect.unreachable("no respawn expected") });

    // A branch that already contains main is left completely alone — no push,
    // and no attempt recorded against its cap.
    expect(git(repoDir, "rev-parse", `origin/${branch}`)).toBe(tip);
    expect(await countEvents("pr.freshen_halted")).toBe(0);
    expect(await countEvents("pr.freshen_attempt")).toBe(3); // still just the seeded ones
    expect(pushTitles()).toEqual([]); // and no "stopped re-merging" page

    // Once main DOES move past it, the cap applies as normal.
    advanceMain("other.txt", "other\n");
    await freshenPass({ spawn: () => expect.unreachable("no respawn expected") });
    expect(await countEvents("pr.freshen_halted")).toBe(1);
    expect(pushTitles()).toEqual([`task #${task.id} — stopped re-merging its PR`]);
  });

  it("queues a merge burst instead of freshening every stale PR at once", async () => {
    const { freshenPass } = await import("../src/daemon/freshen.js");
    const { setIntegrationSettings } = await import("../src/db/settings.js");
    setIntegrationSettings({ freshen_per_pass_limit: 1 });
    await setupAgentTask({ file: "one.txt", contents: "1\n" });
    await setupAgentTask({ file: "two.txt", contents: "2\n" });
    advanceMain("other.txt", "other\n");

    await freshenPass({ spawn: () => expect.unreachable("no respawn expected") });

    expect(await countEvents("pr.freshened")).toBe(1);
    expect(await countEvents("pr.freshen_deferred")).toBe(1);

    // The deferred one is picked up by the following pass.
    await freshenPass({ spawn: () => expect.unreachable("no respawn expected") });
    expect(await countEvents("pr.freshened")).toBe(2);
  });
});
