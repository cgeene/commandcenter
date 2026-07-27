import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const newWindow = vi.fn(
  (_name: string, _cwd: string, _command: string) => "cc:@review",
);

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
  findProviderTranscript: () => undefined,
}));

let tmpDir: string;

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
  }).trim();
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-spawn-"));
  process.env.CC_DATA_DIR = path.join(tmpDir, "data");
  newWindow.mockClear();
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("manual human-publication review", () => {
  it("pins and materializes the current uncommitted tree before spawning", async () => {
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    fs.writeFileSync(path.join(repo, "tracked.txt"), "before\n");
    git(repo, "add", "tracked.txt");
    git(repo, "commit", "-m", "initial");

    const { createTask, getTask, updateTask } = await import(
      "../src/db/tasks.js"
    );
    const { spawnReviewer } = await import("../src/daemon/spawn.js");
    const task = createTask({
      title: "manual review",
      prompt: "change the file",
      repo,
      publication_mode: "human",
    });
    const branch = `agent/task-${task.id}`;
    git(repo, "checkout", "-b", branch);
    fs.writeFileSync(path.join(repo, "tracked.txt"), "after\n");
    updateTask(task.id, {
      status: "review",
      worktree: repo,
      branch,
      result_summary: "updated tracked.txt",
    });

    spawnReviewer(task.id);

    const updated = getTask(task.id)!;
    expect(updated).toMatchObject({
      publication_state: "reviewing",
      review_verdict: null,
    });
    expect(updated.review_snapshot_tree).toMatch(/^[0-9a-f]{40,64}$/);
    const reviewerDir = newWindow.mock.calls[0]?.[1];
    expect(fs.readFileSync(path.join(reviewerDir, "tracked.txt"), "utf8")).toBe(
      "after\n",
    );
  });
});
