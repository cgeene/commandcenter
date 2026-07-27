import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let launchFailure = false;
const newWindow = vi.fn((_name: string, _cwd: string, _command: string) => {
  if (launchFailure) throw new Error("provider process failed");
  return "cc:@resumed";
});
let transcriptAvailable = true;

vi.mock("../src/daemon/tmux.js", () => ({
  newWindow: (name: string, cwd: string, command: string) =>
    newWindow(name, cwd, command),
  windowExists: () => false,
  killWindow: vi.fn(),
}));

vi.mock("../src/daemon/genconfig.js", () => ({
  writeCodexConfig: () => ({
    profileFile: "/tmp/commandcenter.config.toml",
    inheritedMcpEnvVars: [],
  }),
  writeMcpConfigFile: () => "/tmp/commandcenter.mcp.json",
  writeSettingsFile: () => "/tmp/commandcenter.settings.json",
}));

vi.mock("../src/daemon/transcript.js", () => ({
  findProviderTranscript: () =>
    transcriptAvailable ? "/tmp/preserved-session.jsonl" : undefined,
}));

vi.mock("../src/daemon/worktree.js", () => ({
  createWorktree: (
    repo: string,
    taskId: number,
    _provider: string,
    _publicationMode: string,
    branch?: string,
  ) => ({
    dir: repo,
    branch: branch ?? `agent/task-${taskId}`,
  }),
  createReviewWorktree: vi.fn(),
  createSnapshotReviewWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  reviewWorktreeDir: vi.fn(),
  git: vi.fn(() => ""),
}));

let tmpDir: string;

async function approvedTask() {
  const repo = path.join(tmpDir, "repo");
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "before\n");

  const { createAgent, updateAgent } = await import("../src/db/agents.js");
  const { createTask, updateTask } = await import("../src/db/tasks.js");
  const task = createTask({
    title: "approved change",
    prompt: "change tracked.txt",
    repo,
    worker_provider: "codex",
    model: "gpt-5.6-sol",
    reasoning_effort: "high",
    publication_mode: "human",
    dispatch_mode: "orchestrated",
    open_pr: false,
  });
  const branch = `agent/task-${task.id}`;
  const worktree = repo;
  fs.writeFileSync(path.join(worktree, "tracked.txt"), "approved\n");

  const previousWorker = createAgent({
    kind: "worker",
    provider: "codex",
    model: "gpt-5.6-sol",
    reasoning_effort: "high",
    state: "dead",
    task_id: task.id,
  });
  const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  updateAgent(previousWorker.id, {
    session_id: sessionId,
    transcript_path: "/tmp/preserved-session.jsonl",
  });
  updateTask(task.id, {
    status: "review",
    agent_id: previousWorker.id,
    worktree,
    branch,
    session_id: sessionId,
    session_provider: "codex",
    result_summary: "changed tracked.txt and verified it",
    review_notes: "approved after checking the exact snapshot",
    review_snapshot_base: "base-snapshot",
    review_snapshot_tree: "approved-tree",
  });
  const approved = updateTask(task.id, {
    review_verdict: "approve",
    publication_state: "awaiting_human",
  })!;
  return { approved, previousWorker, sessionId };
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-worker-resume-"));
  process.env.CC_DATA_DIR = path.join(tmpDir, "data");
  process.env.CC_CODEX_HOME = path.join(tmpDir, "codex");
  transcriptAvailable = true;
  launchFailure = false;
  newWindow.mockClear();
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  delete process.env.CC_CODEX_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("approved worker resume", () => {
  it("invalidates approval and resumes the same managed provider session", async () => {
    const { createAgent } = await import("../src/db/agents.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { listEvents } = await import("../src/db/events.js");
    const { buildApp } = await import("../src/daemon/api.js");
    const { approved, previousWorker, sessionId } = await approvedTask();
    const main = createAgent({ kind: "main", state: "idle" });

    const response = await buildApp().request(
      `/api/tasks/${approved.id}/resume-worker`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          instructions: "also verify the empty-input case",
          agent_id: main.id,
        }),
      },
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      previous_status: "review",
      previous_agent_id: previousWorker.id,
      session_mode: "same_provider_session",
      task: {
        id: approved.id,
        status: "in_progress",
        session_id: sessionId,
        review_verdict: null,
        review_notes: null,
        result_summary: null,
        publication_state: "editing",
        review_snapshot_base: null,
        review_snapshot_tree: null,
      },
      agent: {
        provider: "codex",
        state: "spawning",
      },
    });
    const reopened = getTask(approved.id)!;
    expect(reopened.prompt).toContain("changed tracked.txt and verified it");
    expect(reopened.prompt).toContain("approved after checking the exact snapshot");
    expect(reopened.prompt).toContain("also verify the empty-input case");
    expect(String(newWindow.mock.calls[0]?.[2])).toContain(
      `resume '${sessionId}'`,
    );
    expect(
      listEvents(20).find(
        (event) => event.kind === "task.worker_resume_requested",
      ),
    ).toMatchObject({ agent_id: main.id, task_id: approved.id });
    expect(listEvents(20).map((event) => event.kind)).toContain(
      "task.worker_resumed",
    );
  });

  it("uses a fresh session fallback while retaining the approved handoff", async () => {
    const { resumeReviewedWorker } = await import(
      "../src/daemon/taskresume.js"
    );
    const { approved } = await approvedTask();
    transcriptAvailable = false;

    const result = await resumeReviewedWorker(approved.id);

    expect(result.session_mode).toBe("fresh_session");
    expect(String(newWindow.mock.calls[0]?.[2])).not.toContain(" resume ");
    expect(result.task.prompt).toContain("Previously approved result");
  });

  it("refuses a direct spawn from review with an actionable conflict", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const { approved } = await approvedTask();

    const response = await buildApp().request("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task_id: approved.id }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: `task ${approved.id} is review; only queued/claimed tasks can be spawned`,
    });
  });

  it("refuses to replace a live task agent", async () => {
    const { createAgent } = await import("../src/db/agents.js");
    const { getTask } = await import("../src/db/tasks.js");
    const { resumeReviewedWorker } = await import(
      "../src/daemon/taskresume.js"
    );
    const { approved } = await approvedTask();
    createAgent({
      kind: "reviewer",
      state: "working",
      task_id: approved.id,
    });

    await expect(resumeReviewedWorker(approved.id)).rejects.toThrow(
      /still has a live reviewer/,
    );
    expect(getTask(approved.id)).toMatchObject({
      status: "review",
      review_verdict: "approve",
      publication_state: "awaiting_human",
    });
    expect(newWindow).not.toHaveBeenCalled();
  });

  it("leaves a safely reopened task queued when the provider cannot launch", async () => {
    const { getTask } = await import("../src/db/tasks.js");
    const { buildApp } = await import("../src/daemon/api.js");
    const { approved } = await approvedTask();
    launchFailure = true;

    const response = await buildApp().request(
      `/api/tasks/${approved.id}/resume-worker`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error:
        "the task was safely reopened, but its worker could not start; it remains queued for retry",
    });
    expect(getTask(approved.id)).toMatchObject({
      status: "queued",
      agent_id: null,
      review_verdict: null,
      result_summary: null,
      publication_state: "editing",
    });
  });
});
