import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The "immutable review snapshot" tests build a real repo + bare remote and
// push to it. Alone they are 3-9s; under full-suite parallel load they have
// been measured past 16s, so the per-test 15s budgets they used to carry were
// still too tight. File-wide budget, same as worktree.test.ts.
vi.setConfig({ testTimeout: 30_000 });

let tmpDir: string;

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

/** Repo with a bare origin and one tracked commit. Built in ONE subprocess:
 *  inside a vitest worker each fork costs ~120-160ms, and this used to spend
 *  ten of them per test. */
function initRepo(): string {
  const repo = path.join(tmpDir, "repo");
  execFileSync(
    "sh",
    [
      "-eu",
      "-c",
      `mkdir -p "$REMOTE" "$REPO"
       git -C "$REMOTE" init -q --bare -b main
       git -C "$REPO" init -q -b main
       git -C "$REPO" config user.email test@example.com
       git -C "$REPO" config user.name Test
       git -C "$REPO" remote add origin "$REMOTE"
       printf 'one\n' > "$REPO/tracked.txt"
       git -C "$REPO" add tracked.txt
       git -C "$REPO" commit -q -m initial
       git -C "$REPO" push -q -u origin main`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, REPO: repo, REMOTE: path.join(tmpDir, "remote.git") },
    },
  );
  return repo;
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-publication-"));
  process.env.CC_DATA_DIR = path.join(tmpDir, "data");
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  const { _setGhRunner } = await import("../src/daemon/prdraft.js");
  _setGhRunner(null);
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

describe("local publication setting", () => {
  it("defaults to agent and snapshots the effective mode onto new tasks", async () => {
    const settings = await import("../src/db/settings.js");
    const { createTask } = await import("../src/db/tasks.js");

    expect(settings.resolveWorkerPublicationMode()).toBe("agent");
    const original = createTask({ title: "a", prompt: "x", repo: "/r" });
    expect(original).toMatchObject({
      publication_mode: "agent",
      publication_state: null,
    });

    settings.setAgentSettings({ worker_publication_mode: "human" });
    const personal = createTask({ title: "h", prompt: "x", repo: "/r" });
    expect(personal).toMatchObject({
      publication_mode: "human",
      publication_state: "editing",
    });

    settings.setAgentSettings({ worker_publication_mode: "agent" });
    expect((await import("../src/db/tasks.js")).getTask(personal.id)?.publication_mode)
      .toBe("human");
    expect(createTask({ title: "new", prompt: "x", repo: "/r" }).publication_mode)
      .toBe("agent");
  });
});

describe("provider publication boundaries", () => {
  it("changes prompts and Claude permissions only for human-mode tasks", async () => {
    const { createTask } = await import("../src/db/tasks.js");
    const {
      _buildWorkerAllowForTest,
      _buildWorkerDenyForTest,
      _buildWorkerPromptForTest,
      _buildReviewerDenyForTest,
    } = await import("../src/daemon/spawn.js");
    const branch = "agent/task-9";
    const agent = createTask({
      title: "agent",
      prompt: "x",
      repo: "/r",
      publication_mode: "agent",
    });
    const human = createTask({
      title: "human",
      prompt: "x",
      repo: "/r",
      publication_mode: "human",
    });

    expect(_buildWorkerPromptForTest(agent, branch)).toContain(
      "Commit your work",
    );
    expect(_buildWorkerAllowForTest(agent, branch)).toContain(
      `Bash(git push -u origin ${branch})`,
    );

    const humanPrompt = _buildWorkerPromptForTest(human, branch);
    expect(humanPrompt).toContain("Leave every change uncommitted");
    expect(humanPrompt).toContain("independent review");
    expect(_buildWorkerAllowForTest(human, branch)).not.toContain(
      `Bash(git push -u origin ${branch})`,
    );
    expect(_buildWorkerDenyForTest(human)).toEqual(
      expect.arrayContaining([
        "Bash(git commit*)",
        "Bash(git push*)",
        "Bash(git merge*)",
        "Bash(gh pr create*)",
      ]),
    );
    expect(_buildReviewerDenyForTest(agent)).not.toContain(
      "Bash(gh pr create*)",
    );
    expect(_buildReviewerDenyForTest(human)).toEqual(
      expect.arrayContaining([
        "Bash(git merge*)",
        "Bash(gh api*)",
        "Bash(gh pr create*)",
      ]),
    );
  });

  it("uses structured Codex decisions without keyword false positives", async () => {
    const { codexPermissionDecision } = await import("../src/codex-policy.js");
    const payload = (command: string) => ({
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command },
    });
    const human = {
      taskId: "12",
      workspaceKind: "repo" as const,
      publicationMode: "human" as const,
      role: "worker" as const,
    };
    const agent = { ...human, publicationMode: "agent" as const };
    const agentReviewer = { ...agent, role: "reviewer" as const };
    const humanReviewer = { ...human, role: "reviewer" as const };

    expect(codexPermissionDecision(payload("git commit -m x"), human)?.behavior)
      .toBe("deny");
    expect(codexPermissionDecision(payload("gh pr create --draft"), human)?.behavior)
      .toBe("deny");
    expect(codexPermissionDecision(payload("echo 'git push && git merge'"), human))
      .toBeUndefined();
    expect(codexPermissionDecision(payload("git status --short"), human))
      .toBeUndefined();
    expect(
      codexPermissionDecision(
        payload("bash -lc 'git commit -m hidden'"),
        human,
      )?.behavior,
    ).toBe("deny");
    expect(
      codexPermissionDecision(
        payload("git -c alias.publish=push publish origin main"),
        human,
      )?.behavior,
    ).toBe("deny");
    expect(
      codexPermissionDecision(
        payload("gh api -X POST repos/x/y/pulls"),
        human,
      )?.behavior,
    ).toBe("deny");
    expect(
      codexPermissionDecision(
        {
          hook_event_name: "PreToolUse",
          tool_name: "mcp__github__create_pull_request",
          tool_input: {},
        },
        human,
      )?.behavior,
    ).toBe("deny");

    expect(
      codexPermissionDecision(
        payload("git push -u origin agent/task-12"),
        agent,
      )?.behavior,
    ).toBe("allow");
    expect(
      codexPermissionDecision(
        payload("git push -u origin agent/task-12 && gh pr merge 9"),
        agent,
      )?.behavior,
    ).toBe("deny");
    expect(
      codexPermissionDecision(
        payload("echo $(git push -u origin agent/task-12)"),
        agent,
      )?.behavior,
    ).toBe("deny");
    expect(
      codexPermissionDecision(payload("gh api repos/x/y/pulls/1"), agentReviewer),
    ).toBeUndefined();
    expect(
      codexPermissionDecision(payload("gh api repos/x/y/pulls/1"), humanReviewer)
        ?.behavior,
    ).toBe("deny");
  });
});

describe("immutable review snapshot", () => {
  async function setupHumanTask(openPr = true) {
    const repo = initRepo();
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const task = createTask({
      title: "snapshot",
      prompt: "change files",
      repo,
      open_pr: openPr,
      publication_mode: "human",
    });
    const branch = `agent/task-${task.id}`;
    git(repo, "checkout", "-b", branch);
    updateTask(task.id, {
      status: "review",
      worktree: repo,
      branch,
      result_summary: "changed tracked and new files",
    });
    fs.writeFileSync(path.join(repo, "tracked.txt"), "two\n");
    fs.writeFileSync(path.join(repo, "new.txt"), "new\n");
    return { repo, task: (await import("../src/db/tasks.js")).getTask(task.id)! };
  }

  it("captures tracked and untracked files without changing the real index or branch", async () => {
    const { repo, task } = await setupHumanTask();
    const {
      captureReviewSnapshot,
      snapshotHasChanges,
    } = await import("../src/daemon/reviewsnapshot.js");
    const { createSnapshotReviewWorktree } = await import(
      "../src/daemon/worktree.js"
    );
    const { taskDiff } = await import("../src/daemon/review.js");

    const headBefore = git(repo, "rev-parse", "HEAD");
    const statusBefore = git(repo, "status", "--porcelain");
    const captured = captureReviewSnapshot(task.id);

    expect(git(repo, "rev-parse", "HEAD")).toBe(headBefore);
    expect(git(repo, "status", "--porcelain")).toBe(statusBefore);
    expect(git(repo, "cat-file", "-t", captured.review_snapshot_tree!)).toBe(
      "tree",
    );
    expect(snapshotHasChanges(captured)).toBe(true);

    const reviewDir = createSnapshotReviewWorktree(
      repo,
      task.id,
      captured.review_snapshot_base!,
      captured.review_snapshot_tree!,
    );
    expect(fs.readFileSync(path.join(reviewDir, "tracked.txt"), "utf8")).toBe(
      "two\n",
    );
    expect(fs.readFileSync(path.join(reviewDir, "new.txt"), "utf8")).toBe("new\n");
    const diff = taskDiff(captured);
    expect(diff.diff).toContain("two");
    expect(diff.diff).toContain("new.txt");
  });

  it("runs reviewer approval before human commit and validates the exact committed tree", async () => {
    const { repo, task } = await setupHumanTask();
    const { captureReviewSnapshot } = await import(
      "../src/daemon/reviewsnapshot.js"
    );
    const { confirmHumanPublication, handleVerdict } = await import(
      "../src/daemon/review.js"
    );
    const { getTask } = await import("../src/db/tasks.js");
    captureReviewSnapshot(task.id);

    await handleVerdict(task.id, 99, "approve", "snapshot is correct");
    expect(getTask(task.id)).toMatchObject({
      status: "review",
      review_verdict: "approve",
      publication_state: "awaiting_human",
    });
    await expect(
      confirmHumanPublication(task.id, "https://github.com/x/y/pull/1"),
    ).rejects.toThrow(/commit and push the unchanged approved working tree/);

    git(repo, "add", "-A");
    git(repo, "commit", "-m", "feat: human commit");
    await expect(
      confirmHumanPublication(task.id, "https://github.com/x/y/pull/1"),
    ).rejects.toThrow(/commit and push the unchanged approved working tree/);
    git(repo, "push", "-u", "origin", `agent/task-${task.id}`);
    const ghCalls: string[][] = [];
    const { _setGhRunner } = await import("../src/daemon/prdraft.js");
    _setGhRunner(async (args) => {
      ghCalls.push(args);
      return args[1] === "view" ? "feat: human commit" : "";
    });
    const published = await confirmHumanPublication(
      task.id,
      "https://github.com/x/y/pull/1",
    );
    expect(published).toMatchObject({
      status: "review",
      publication_state: "published",
      pr_is_draft: 0,
      pr_url: "https://github.com/x/y/pull/1",
      review_snapshot_base: null,
      review_snapshot_tree: null,
    });
    expect(ghCalls[0]).toEqual([
      "pr",
      "ready",
      "https://github.com/x/y/pull/1",
    ]);
  });

  it("retains the approved snapshot when the draft PR cannot be marked ready", async () => {
    const { repo, task } = await setupHumanTask();
    const { captureReviewSnapshot } = await import(
      "../src/daemon/reviewsnapshot.js"
    );
    const { confirmHumanPublication, handleVerdict } = await import(
      "../src/daemon/review.js"
    );
    const { getTask } = await import("../src/db/tasks.js");
    const { _setGhRunner } = await import("../src/daemon/prdraft.js");
    const captured = captureReviewSnapshot(task.id);
    await handleVerdict(task.id, 99, "approve", "snapshot is correct");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "feat: human commit");
    git(repo, "push", "-u", "origin", `agent/task-${task.id}`);
    _setGhRunner(async () => {
      throw new Error("GitHub unavailable");
    });

    await expect(
      confirmHumanPublication(task.id, "https://github.com/x/y/pull/1"),
    ).rejects.toThrow(/could not be marked ready/);
    expect(getTask(task.id)).toMatchObject({
      status: "review",
      publication_state: "awaiting_human",
      review_verdict: "approve",
      review_snapshot_base: captured.review_snapshot_base,
      review_snapshot_tree: captured.review_snapshot_tree,
      pr_url: null,
    });
  });

  it("returns rejected snapshots to the uncommitted worker loop", async () => {
    const { task } = await setupHumanTask();
    const { captureReviewSnapshot } = await import(
      "../src/daemon/reviewsnapshot.js"
    );
    const { handleVerdict } = await import("../src/daemon/review.js");
    const { getTask } = await import("../src/db/tasks.js");
    captureReviewSnapshot(task.id);

    await handleVerdict(task.id, 99, "reject", "new file needs validation");
    expect(getTask(task.id)).toMatchObject({
      status: "queued",
      publication_state: "editing",
      review_snapshot_base: null,
      review_snapshot_tree: null,
      review_cycles: 1,
    });
  });

  it("ignores approval when the worker tree changed during review", async () => {
    const { repo, task } = await setupHumanTask();
    const { captureReviewSnapshot } = await import(
      "../src/daemon/reviewsnapshot.js"
    );
    const { handleVerdict } = await import("../src/daemon/review.js");
    const { getTask } = await import("../src/db/tasks.js");
    captureReviewSnapshot(task.id);
    fs.writeFileSync(path.join(repo, "tracked.txt"), "three\n");

    await handleVerdict(task.id, 99, "approve", "old snapshot looks fine");

    expect(getTask(task.id)).toMatchObject({
      status: "review",
      review_verdict: null,
      publication_state: "editing",
      review_snapshot_base: null,
      review_snapshot_tree: null,
    });
  });

  it("clears a pinned approval candidate when the task is requeued", async () => {
    const { task } = await setupHumanTask();
    const { captureReviewSnapshot } = await import(
      "../src/daemon/reviewsnapshot.js"
    );
    const { buildApp } = await import("../src/daemon/api.js");
    const { getTask } = await import("../src/db/tasks.js");
    captureReviewSnapshot(task.id);

    const response = await buildApp().request(`/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "queued" }),
    });

    expect(response.status).toBe(200);
    expect(getTask(task.id)).toMatchObject({
      status: "queued",
      publication_state: "editing",
      review_verdict: null,
      review_snapshot_base: null,
      review_snapshot_tree: null,
    });
  });
});

describe("human attention handoff", () => {
  it("surfaces only reviewer-approved snapshots to the human", async () => {
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const { deriveAttention } = await import("../src/daemon/attention.js");
    const task = createTask({
      title: "ready",
      prompt: "x",
      repo: "/r",
      publication_mode: "human",
    });
    updateTask(task.id, {
      status: "review",
      review_verdict: "approve",
      publication_state: "awaiting_human",
      review_snapshot_tree: "a".repeat(40),
    });
    const items = deriveAttention({
      now: new Date("2026-07-23T12:00:00Z"),
      isPrOpen: () => true,
    });
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "publish_task",
          task_id: task.id,
          title: expect.stringContaining("Review and publish"),
        }),
      ]),
    );
  });
});

describe("human publication API guardrails", () => {
  it("does not let the generic task update bypass review and publication", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const { createTask, getTask, updateTask } = await import(
      "../src/db/tasks.js"
    );
    const task = createTask({
      title: "guarded",
      prompt: "x",
      repo: "/r",
      publication_mode: "human",
    });
    updateTask(task.id, { status: "review" });

    const response = await buildApp().request(`/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error:
        "human-publication tasks must pass review and be confirmed as published",
    });
    expect(getTask(task.id)?.status).toBe("review");
  });

  it("rejects non-canonical pull request URLs", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const task = createTask({
      title: "url",
      prompt: "x",
      repo: "/r",
      publication_mode: "human",
    });
    updateTask(task.id, {
      status: "review",
      review_verdict: "approve",
      publication_state: "awaiting_human",
    });

    const response = await buildApp().request(`/api/tasks/${task.id}/publication`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pr_url: "https://example.com/not-a-pr" }),
    });

    expect(response.status).toBe(400);
  });
});
