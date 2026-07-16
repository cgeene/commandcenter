import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let tmpDir: string;
let root: string;

function gitRepo(relative: string): string {
  const repo = path.join(root, relative);
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  return repo;
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-workspaces-"));
  tmpDir = fs.realpathSync(tmpDir);
  root = path.join(tmpDir, "repos");
  fs.mkdirSync(root);
  process.env.CC_DATA_DIR = path.join(tmpDir, "data");
  process.env.CC_REPO_ROOTS = root;
  delete process.env.CC_REPO_ROOT;
  delete process.env.CC_SCRATCH_DIR;
  delete process.env.CC_SCRATCH_RETENTION_DAYS;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  delete process.env.CC_REPO_ROOTS;
  delete process.env.CC_REPO_ROOT;
  delete process.env.CC_SCRATCH_DIR;
  delete process.env.CC_SCRATCH_RETENTION_DAYS;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("repository workspace catalog", () => {
  it("discovers nested Git roots and ignores generated, hidden, and symlinked paths", async () => {
    const a = gitRepo("notetaker");
    const b = gitRepo("platform/unicorn-k8s");
    gitRepo(".codex-worktrees/ignored");
    const outside = path.join(tmpDir, "outside");
    fs.mkdirSync(path.join(outside, ".git"), { recursive: true });
    fs.symlinkSync(outside, path.join(root, "linked-repo"));

    const { listRepositories } = await import("../src/daemon/workspaces.js");
    expect(listRepositories().map((repo) => repo.path)).toEqual([a, b]);
  });

  it("accepts only canonical Git roots contained by the configured root", async () => {
    const repo = gitRepo("commandcenter");
    const outside = path.join(tmpDir, "outside");
    fs.mkdirSync(path.join(outside, ".git"), { recursive: true });
    const linked = path.join(root, "linked");
    fs.symlinkSync(repo, linked);

    const { resolveAllowedRepository } = await import("../src/daemon/workspaces.js");
    expect(resolveAllowedRepository(repo)).toBe(repo);
    expect(() => resolveAllowedRepository(path.join(repo, "subdir"))).toThrow();
    expect(() => resolveAllowedRepository(outside)).toThrow(/not an allowed Git root/);
    expect(() => resolveAllowedRepository(linked)).toThrow(/real directory/);
  });

  it("never treats a portfolio root itself as a writable child repository", async () => {
    fs.mkdirSync(path.join(root, ".git"));
    const { resolvePortfolioChildRepository } = await import(
      "../src/daemon/workspaces.js"
    );
    expect(() => resolvePortfolioChildRepository(root, root)).toThrow(
      /outside the parent repository root/,
    );
  });
});

describe("scratch workspace lifecycle", () => {
  it("allocates an empty private directory and rejects unmanaged paths", async () => {
    const {
      allocateScratchWorkspace,
      listScratchWorkspaces,
      validateScratchWorkspace,
    } = await import("../src/daemon/workspaces.js");
    const scratch = allocateScratchWorkspace();
    expect(fs.readdirSync(scratch)).toEqual([]);
    expect(fs.statSync(scratch).mode & 0o777).toBe(0o700);
    expect(listScratchWorkspaces()).toEqual([scratch]);
    expect(validateScratchWorkspace(scratch)).toBe(scratch);
    expect(() => validateScratchWorkspace(root)).toThrow(/managed root/);
  });

  it("rejects a symlinked scratch root without changing its target", async () => {
    const target = path.join(tmpDir, "scratch-target");
    const linked = path.join(tmpDir, "scratch-link");
    fs.mkdirSync(target, { mode: 0o755 });
    fs.chmodSync(target, 0o755);
    fs.symlinkSync(target, linked);
    process.env.CC_SCRATCH_DIR = linked;

    const { allocateScratchWorkspace } = await import(
      "../src/daemon/workspaces.js"
    );
    expect(() => allocateScratchWorkspace()).toThrow(/real directory/);
    expect(fs.statSync(target).mode & 0o777).toBe(0o755);
  });

  it("prunes only terminal scratch tasks after the retention window", async () => {
    const { createTask, listTasks, updateTask } = await import("../src/db/tasks.js");
    const { allocateScratchWorkspace, pruneScratchWorkspaces } = await import(
      "../src/daemon/workspaces.js"
    );
    const doneDir = allocateScratchWorkspace();
    const activeDir = allocateScratchWorkspace();
    const done = createTask({
      title: "done",
      prompt: "x",
      repo: doneDir,
      workspace_kind: "scratch",
      open_pr: false,
    });
    createTask({
      title: "active",
      prompt: "x",
      repo: activeDir,
      workspace_kind: "scratch",
      open_pr: false,
    });
    updateTask(done.id, { status: "done" });

    const removed = pruneScratchWorkspaces(
      listTasks(),
      new Date(Date.now() + 8 * 24 * 60 * 60 * 1000),
    );
    expect(removed).toEqual([doneDir]);
    expect(fs.existsSync(doneDir)).toBe(false);
    expect(fs.existsSync(activeDir)).toBe(true);
  });
});
