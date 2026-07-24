import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-task-resume-"));
  process.env.CC_DATA_DIR = path.join(tmpDir, "data");
  process.env.CC_CLAUDE_PROJECTS = path.join(tmpDir, "claude-projects");
  process.env.CC_CODEX_HOME = path.join(tmpDir, "codex");
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  delete process.env.CC_CLAUDE_PROJECTS;
  delete process.env.CC_CODEX_HOME;
  const { _setGhRunner } = await import("../src/daemon/prdraft.js");
  _setGhRunner(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("resumeArchivedTask", () => {
  it("reopens the same task and carries archived context into either session path", async () => {
    const { createAgent, updateAgent } = await import("../src/db/agents.js");
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { resumeArchivedTask } = await import("../src/daemon/taskresume.js");

    const task = createTask({
      title: "finish rollout",
      prompt: "implement the rollout",
      repo: "/repo",
      dispatch_mode: "orchestrated",
    });
    const sessionId = "aaaa1111-0000-0000-0000-000000000000";
    const transcriptDir = path.join(process.env.CC_CLAUDE_PROJECTS!, "-repo");
    fs.mkdirSync(transcriptDir, { recursive: true });
    fs.writeFileSync(path.join(transcriptDir, `${sessionId}.jsonl`), "");
    const worker = createAgent({
      kind: "worker",
      provider: "claude",
      state: "dead",
      task_id: task.id,
    });
    updateAgent(worker.id, { session_id: sessionId });
    updateTask(task.id, {
      status: "done",
      agent_id: worker.id,
      branch: `agent/task-${task.id}`,
      session_id: sessionId,
      session_provider: "claude",
      result_summary: "implemented version one",
      review_verdict: "approve",
      review_notes: "reviewed version one",
      review_cycles: 2,
      review_head_sha: "abc",
      review_result_hash: "def",
    });

    const result = await resumeArchivedTask(task.id, {
      instructions: "also support the second rollout mode",
    });

    expect(result.task.id).toBe(task.id);
    expect(result.session_mode).toBe("same_provider_session");
    expect(result.task).toMatchObject({
      status: "queued",
      agent_id: null,
      branch: `agent/task-${task.id}`,
      session_id: sessionId,
      session_provider: "claude",
      result_summary: null,
      review_verdict: null,
      review_notes: null,
      review_cycles: 0,
      review_head_sha: null,
      review_result_hash: null,
    });
    expect(result.task.prompt).toContain("implement the rollout");
    expect(result.task.prompt).toContain("implemented version one");
    expect(result.task.prompt).toContain("reviewed version one");
    expect(result.task.prompt).toContain("also support the second rollout mode");
    expect(listEvents(10).map((event) => event.kind)).toContain(
      "task.archived_resumed",
    );
  });

  it("reaps a retained terminal worker before queueing the resumed attempt", async () => {
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const { resumeArchivedTask } = await import("../src/daemon/taskresume.js");
    const task = createTask({
      title: "retained worker",
      prompt: "continue",
      repo: "/repo",
    });
    const worker = createAgent({
      kind: "worker",
      state: "idle",
      task_id: task.id,
    });
    updateTask(task.id, {
      status: "cancelled",
      agent_id: worker.id,
      branch: `agent/task-${task.id}`,
    });

    const result = await resumeArchivedTask(task.id);

    expect(result.killed_agents).toEqual([worker.id]);
    expect(getAgent(worker.id)?.state).toBe("dead");
    expect(result.task).toMatchObject({ status: "queued", agent_id: null });
  });

  it("rotates a terminal PR branch and clears only stale PR/review state", async () => {
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const { resumeArchivedTask } = await import("../src/daemon/taskresume.js");
    const task = createTask({
      title: "follow up merged work",
      prompt: "do the first change",
      repo: "/repo",
      worker_provider: "codex",
    });
    updateTask(task.id, {
      status: "done",
      branch: `agent/task-${task.id}`,
      pr_url: "https://github.com/acme/repo/pull/10",
      pr_state: "merged",
      pr_checks: "pass",
      pr_is_draft: 0,
      human_approved_at: "2026-07-01T00:00:00Z",
      pr_synced_at: "2026-07-01T00:00:00Z",
      jira_key: "ENG-10",
      tokens_used: 1234,
      result_summary: "merged safely",
    });

    const result = await resumeArchivedTask(task.id);

    expect(result.session_mode).toBe("fresh_session");
    expect(result.previous_branch).toBe(`agent/task-${task.id}`);
    expect(result.task).toMatchObject({
      status: "queued",
      branch: `agent/task-${task.id}-resume-1`,
      pr_url: null,
      pr_state: null,
      pr_checks: null,
      pr_is_draft: null,
      human_approved_at: null,
      pr_synced_at: null,
      jira_key: "ENG-10",
      tokens_used: 1234,
      worker_provider: "codex",
    });
    expect(result.task.prompt).toContain(
      "https://github.com/acme/repo/pull/10 (merged)",
    );
  });

  it("refuses to turn an active task into a second concurrent attempt", async () => {
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const {
      resumeArchivedTask,
      TaskResumeValidationError,
    } = await import("../src/daemon/taskresume.js");
    const task = createTask({ title: "active", prompt: "work", repo: "/repo" });
    updateTask(task.id, { status: "in_progress" });

    await expect(resumeArchivedTask(task.id)).rejects.toThrow(
      TaskResumeValidationError,
    );
    await expect(resumeArchivedTask(task.id)).rejects.toThrow(/only archived/);
  });

  it("fails closed when a terminal PR still has uncommitted retained work", async () => {
    const worktree = path.join(tmpDir, "retained-worktree");
    fs.mkdirSync(worktree);
    execFileSync("git", ["-C", worktree, "init", "-b", "main"]);
    fs.writeFileSync(path.join(worktree, "uncommitted.txt"), "keep me");
    const { createTask, getTask, updateTask } = await import(
      "../src/db/tasks.js"
    );
    const { resumeArchivedTask } = await import("../src/daemon/taskresume.js");
    const task = createTask({ title: "dirty", prompt: "work", repo: worktree });
    updateTask(task.id, {
      status: "done",
      worktree,
      branch: `agent/task-${task.id}`,
      pr_url: "https://github.com/acme/repo/pull/4",
      pr_state: "merged",
    });

    await expect(resumeArchivedTask(task.id)).rejects.toThrow(
      /uncommitted changes/,
    );
    expect(getTask(task.id)?.status).toBe("done");
    expect(fs.existsSync(path.join(worktree, "uncommitted.txt"))).toBe(true);
  });

  it("recreates an expired scratch workspace while retaining the task", async () => {
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const {
      allocateScratchWorkspace,
      removeScratchWorkspace,
    } = await import("../src/daemon/workspaces.js");
    const { resumeArchivedTask } = await import("../src/daemon/taskresume.js");
    const oldScratch = allocateScratchWorkspace();
    const task = createTask({
      title: "old investigation",
      prompt: "inspect it",
      repo: oldScratch,
      workspace_kind: "scratch",
      dispatch_mode: "orchestrated",
      open_pr: false,
    });
    updateTask(task.id, {
      status: "cancelled",
      worktree: oldScratch,
      result_summary: "partial findings",
    });
    removeScratchWorkspace(oldScratch);

    const result = await resumeArchivedTask(task.id, {
      instructions: "recheck the current cluster",
    });

    expect(result.task.id).toBe(task.id);
    expect(result.task.repo).not.toBe(oldScratch);
    expect(result.task.worktree).toBeNull();
    expect(fs.statSync(result.task.repo).isDirectory()).toBe(true);
    expect(result.task.prompt).toContain("partial findings");
    expect(result.task.prompt).toContain("recheck the current cluster");
  });

  it("returns a still-open ready PR to draft before reopening work", async () => {
    const calls: string[][] = [];
    const { _setGhRunner } = await import("../src/daemon/prdraft.js");
    _setGhRunner(async (args) => {
      calls.push(args);
      return "";
    });
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const { resumeArchivedTask } = await import("../src/daemon/taskresume.js");
    const task = createTask({ title: "open PR", prompt: "work", repo: "/repo" });
    updateTask(task.id, {
      status: "done",
      branch: `agent/task-${task.id}`,
      pr_url: "https://github.com/acme/repo/pull/5",
      pr_state: "open",
      pr_is_draft: 0,
    });

    const result = await resumeArchivedTask(task.id);

    expect(calls).toContainEqual([
      "pr",
      "ready",
      "--undo",
      "https://github.com/acme/repo/pull/5",
    ]);
    expect(result.task).toMatchObject({
      status: "queued",
      branch: `agent/task-${task.id}`,
      pr_url: "https://github.com/acme/repo/pull/5",
      pr_state: "open",
      pr_is_draft: 1,
    });
  });

  it("exposes the lifecycle through the API and records a main-initiated handoff", async () => {
    const { createAgent } = await import("../src/db/agents.js");
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const { latestTaskEvent } = await import("../src/db/events.js");
    const { buildApp } = await import("../src/daemon/api.js");
    const main = createAgent({ kind: "main", state: "idle" });
    const task = createTask({
      title: "archived API task",
      prompt: "original",
      repo: "/repo",
      dispatch_mode: "orchestrated",
    });
    updateTask(task.id, { status: "cancelled" });

    const response = await buildApp().request(`/api/tasks/${task.id}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instructions: "new requirement",
        agent_id: main.id,
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      task: {
        id: task.id,
        status: "queued",
        prompt: expect.stringContaining("new requirement"),
      },
    });
    expect(
      latestTaskEvent(task.id, ["task.delegated_to_main"]),
    ).toMatchObject({ agent_id: main.id });
  });
});
