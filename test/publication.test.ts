import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let tmpDir: string;

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function initRepo(): string {
  const repo = path.join(tmpDir, "repo");
  const remote = path.join(tmpDir, "remote.git");
  fs.mkdirSync(remote);
  git(remote, "init", "--bare", "-b", "main");
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo]);
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "remote", "add", "origin", remote);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "one\n");
  git(repo, "add", "tracked.txt");
  git(repo, "commit", "-m", "initial");
  git(repo, "push", "-u", "origin", "main");
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
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
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
    expect(() =>
      confirmHumanPublication(task.id, "https://github.com/x/y/pull/1")
    ).toThrow(/commit and push the unchanged approved working tree/);

    git(repo, "add", "-A");
    git(repo, "commit", "-m", "feat: human commit");
    expect(() =>
      confirmHumanPublication(task.id, "https://github.com/x/y/pull/1")
    ).toThrow(/commit and push the unchanged approved working tree/);
    git(repo, "push", "-u", "origin", `agent/task-${task.id}`);
    const published = confirmHumanPublication(
      task.id,
      "https://github.com/x/y/pull/1",
    );
    expect(published).toMatchObject({
      status: "review",
      publication_state: "published",
      pr_url: "https://github.com/x/y/pull/1",
      review_snapshot_base: null,
      review_snapshot_tree: null,
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
