import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

vi.setConfig({ testTimeout: 15_000 });

let tmpDir: string;
let home: string;

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

/** A real git working tree to stand in for a worker's worktree. */
function initWorkingTree(name: string): string {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-b", "main");
  fs.writeFileSync(path.join(dir, "README.md"), "x\n");
  git(dir, "add", "-A");
  git(dir, "-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-m", "init");
  return dir;
}

function write(p: string, contents: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, contents);
}

/** The single import line (inline `text: @rel` form) written into the index. */
function importPaths(indexBody: string): string[] {
  return indexBody
    .split("\n")
    .filter((l) => l.includes(": @"))
    .map((l) => l.slice(l.indexOf(": @") + 3).trim());
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-ctx-"));
  process.env.CC_DATA_DIR = path.join(tmpDir, "data");
  home = path.join(tmpDir, "home");
  fs.mkdirSync(home, { recursive: true });
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("injectWorkspaceContext", () => {
  it("symlinks the inferred parent workspace file and imports it by relative path", async () => {
    const workspaceFile = path.join(home, "projects", "nylas", "CLAUDE.md");
    write(workspaceFile, "workspace context\n");
    const repo = path.join(home, "projects", "nylas", "svc");
    const wt = initWorkingTree("svc-wt");

    const { injectWorkspaceContext, INJECT_MARKER } = await import(
      "../src/daemon/context.js"
    );
    injectWorkspaceContext(repo, wt, 1, { home });

    const index = path.join(wt, ".claude", "CLAUDE.md");
    expect(fs.existsSync(index)).toBe(true);
    const body = fs.readFileSync(index, "utf8");
    expect(body).toContain(INJECT_MARKER);
    // Import is IN-TREE and relative (not the external absolute path, which
    // does not expand headlessly) — from .claude/CLAUDE.md that is cc-workspace/1.md.
    expect(importPaths(body)).toEqual(["cc-workspace/1.md"]);

    // The in-tree path is a symlink that resolves to the real workspace file.
    const link = path.join(wt, ".claude", "cc-workspace", "1.md");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(workspaceFile));
  });

  it("excludes the index file and the symlink dir from git status", async () => {
    write(path.join(home, "projects", "nylas", "CLAUDE.md"), "ctx\n");
    const repo = path.join(home, "projects", "nylas", "svc");
    const wt = initWorkingTree("svc-wt");

    const { injectWorkspaceContext } = await import("../src/daemon/context.js");
    injectWorkspaceContext(repo, wt, 1, { home });

    expect(fs.existsSync(path.join(wt, ".claude", "cc-workspace", "1.md"))).toBe(true);
    // Nothing injected shows up as a change a worker could commit.
    expect(git(wt, "status", "--porcelain")).toBe("");
  });

  it("does NOT clobber a repo's own committed root ./CLAUDE.md", async () => {
    write(path.join(home, "projects", "nylas", "CLAUDE.md"), "ws\n");
    const repo = path.join(home, "projects", "nylas", "svc");
    const wt = initWorkingTree("svc-wt");
    const repoClaude = path.join(wt, "CLAUDE.md");
    fs.writeFileSync(repoClaude, "REPO OWN CONTENT\n");
    git(wt, "add", "-A");
    git(wt, "-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-m", "add claude");

    const { injectWorkspaceContext } = await import("../src/daemon/context.js");
    injectWorkspaceContext(repo, wt, 1, { home });

    expect(fs.readFileSync(repoClaude, "utf8")).toBe("REPO OWN CONTENT\n");
    expect(fs.existsSync(path.join(wt, ".claude", "CLAUDE.md"))).toBe(true);
    expect(git(wt, "status", "--porcelain")).toBe("");
  });

  it("falls back to CLAUDE.local.md (with a .claude-relative import) when the repo committed its own .claude/CLAUDE.md", async () => {
    write(path.join(home, "projects", "nylas", "CLAUDE.md"), "ws\n");
    const repo = path.join(home, "projects", "nylas", "svc");
    const wt = initWorkingTree("svc-wt");
    const repoDotClaude = path.join(wt, ".claude", "CLAUDE.md");
    write(repoDotClaude, "REPO DOTCLAUDE CONTENT\n");
    git(wt, "add", "-A");
    git(wt, "-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-m", "add dotclaude");

    const { injectWorkspaceContext, INJECT_MARKER } = await import(
      "../src/daemon/context.js"
    );
    injectWorkspaceContext(repo, wt, 1, { home });

    expect(fs.readFileSync(repoDotClaude, "utf8")).toBe("REPO DOTCLAUDE CONTENT\n");
    const local = path.join(wt, "CLAUDE.local.md");
    const body = fs.readFileSync(local, "utf8");
    expect(body).toContain(INJECT_MARKER);
    // From the root CLAUDE.local.md the symlink is under .claude/cc-workspace/.
    expect(importPaths(body)).toEqual([".claude/cc-workspace/1.md"]);
    expect(git(wt, "status", "--porcelain")).toBe("");
  });

  it("does nothing when there is no workspace file to import", async () => {
    const repo = path.join(home, "projects", "nylas", "svc");
    const wt = initWorkingTree("svc-wt");

    const { injectWorkspaceContext } = await import("../src/daemon/context.js");
    injectWorkspaceContext(repo, wt, 1, { home });

    expect(fs.existsSync(path.join(wt, ".claude", "CLAUDE.md"))).toBe(false);
    expect(fs.existsSync(path.join(wt, "CLAUDE.local.md"))).toBe(false);
    expect(fs.existsSync(path.join(wt, ".claude", "cc-workspace"))).toBe(false);
    expect(git(wt, "status", "--porcelain")).toBe("");
  });

  it("honors an explicit context_roots mapping", async () => {
    const explicit = path.join(home, "notes", "nylas.md");
    write(explicit, "explicit ctx\n");
    const repo = path.join(home, "work", "nylas", "svc"); // no inferred parent file
    const wt = initWorkingTree("svc-wt");

    const { injectWorkspaceContext } = await import("../src/daemon/context.js");
    injectWorkspaceContext(repo, wt, 1, {
      home,
      roots: { [path.join(home, "work", "nylas")]: [explicit] },
    });

    const link = path.join(wt, ".claude", "cc-workspace", "1.md");
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(explicit));
  });

  it("symlinks multiple ancestor files, nearest first", async () => {
    write(path.join(home, "projects", "nylas", "CLAUDE.md"), "near\n");
    write(path.join(home, "projects", "CLAUDE.md"), "far\n");
    const repo = path.join(home, "projects", "nylas", "svc");
    const wt = initWorkingTree("svc-wt");

    const { injectWorkspaceContext } = await import("../src/daemon/context.js");
    injectWorkspaceContext(repo, wt, 1, { home });

    const body = fs.readFileSync(path.join(wt, ".claude", "CLAUDE.md"), "utf8");
    expect(importPaths(body)).toEqual(["cc-workspace/1.md", "cc-workspace/2.md"]);
    expect(fs.realpathSync(path.join(wt, ".claude", "cc-workspace", "1.md"))).toBe(
      fs.realpathSync(path.join(home, "projects", "nylas", "CLAUDE.md")),
    );
    expect(fs.realpathSync(path.join(wt, ".claude", "cc-workspace", "2.md"))).toBe(
      fs.realpathSync(path.join(home, "projects", "CLAUDE.md")),
    );
    expect(git(wt, "status", "--porcelain")).toBe("");
  });

  it("is idempotent — refresh rebuilds cleanly without stacking imports or excludes", async () => {
    write(path.join(home, "projects", "nylas", "CLAUDE.md"), "ws\n");
    const repo = path.join(home, "projects", "nylas", "svc");
    const wt = initWorkingTree("svc-wt");

    const { injectWorkspaceContext } = await import("../src/daemon/context.js");
    injectWorkspaceContext(repo, wt, 1, { home });
    injectWorkspaceContext(repo, wt, 1, { home });

    const body = fs.readFileSync(path.join(wt, ".claude", "CLAUDE.md"), "utf8");
    expect(importPaths(body)).toEqual(["cc-workspace/1.md"]);
    // Exactly one symlink survives (stale-free rebuild).
    expect(fs.readdirSync(path.join(wt, ".claude", "cc-workspace"))).toEqual(["1.md"]);
    // git exclude not double-appended.
    const exclude = fs.readFileSync(
      path.resolve(wt, git(wt, "rev-parse", "--git-path", "info/exclude")),
      "utf8",
    );
    expect(exclude.split("\n").filter((l) => l.trim() === "/.claude/CLAUDE.md")).toHaveLength(1);
    expect(
      exclude.split("\n").filter((l) => l.trim() === "/.claude/cc-workspace/"),
    ).toHaveLength(1);
    expect(git(wt, "status", "--porcelain")).toBe("");
  });
});
