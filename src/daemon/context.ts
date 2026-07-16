import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { contextRoots } from "../config.js";
import { resolveWorkspaceImports } from "../lib/context-roots.js";
import { logEvent } from "../db/events.js";
import { type AgentProvider } from "../providers.js";

/**
 * Injecting workspace-level CLAUDE.md context into worker/reviewer worktrees.
 *
 * Workers run in a linked git worktree under ~/.commandcenter/worktrees, so
 * Claude Code's CLAUDE.md discovery (which walks UP from the working dir)
 * never passes through the repo's real parent directories — a workspace file
 * like ~/projects/nylas/CLAUDE.md is never loaded.
 *
 * We fix that by importing the discovered workspace file(s) with Claude Code's
 * `@path` syntax, so edits to the source propagate live instead of being
 * copied and going stale. But two things had to be verified empirically
 * against Claude Code v2.1.209 (headless `claude -p`), because both silently
 * defeat the naive approach:
 *
 *   1. An `@import` of an ABSOLUTE path OUTSIDE the project tree does NOT
 *      expand into the loaded context in headless runs — external imports
 *      require an approval that `-p` can't grant, so the content is dropped.
 *      (An `@path` alone on its own line is also not treated as an import;
 *      it must be inline after text on the same line.)
 *   2. An import of an IN-TREE path DOES expand with no approval — including
 *      when that in-tree path is a SYMLINK pointing at an external file. The
 *      symlink is followed to the live source, giving us both headless
 *      loading and live propagation.
 *
 * So we symlink each workspace file into a worktree-owned subdirectory
 * (.claude/cc-workspace/) and import the symlinks by RELATIVE path from a
 * small index file. Everything we create is added to the worktree's git
 * exclude so a worker never commits it into the repo.
 */

/** Stable substring identifying the index file WE wrote, so refreshes
 *  overwrite our own file but never a repo's committed CLAUDE.md in the slot. */
export const INJECT_MARKER = "commandcenter: injected workspace context";

/** Index-file slots, in priority order. Both are loaded by Claude Code
 *  ALONGSIDE a repo's own root ./CLAUDE.md (they don't clobber it). We only
 *  take a slot the repo hasn't committed. `.claude/CLAUDE.md` is preferred
 *  (subdir-isolated, current); `CLAUDE.local.md` is the fallback. */
const SLOTS = [path.join(".claude", "CLAUDE.md"), "CLAUDE.local.md"];

/** Worktree-owned dir holding the symlinks to the workspace files. Named so a
 *  repo is exceedingly unlikely to collide with it, and excluded wholesale. */
const LINK_DIR = path.join(".claude", "cc-workspace");

/** Build the index-file body. `relImports` are paths relative to the index
 *  file's own directory (imports resolve relative to the containing file). */
export function renderInjectedFile(relImports: string[], repo: string): string {
  const lines = [
    `${INJECT_MARKER} — managed by the commandcenter platform, do not edit.`,
    `This is a git worktree of ${repo}, which runs outside the repo's real`,
    "parent directories, so Claude Code never discovers the workspace-level",
    "CLAUDE.md file(s) that live above the repo. Each is symlinked into",
    ".claude/cc-workspace/ and imported live below — edit the SOURCE files;",
    "changes propagate. This file and the symlinks are git-excluded, never committed.",
    "",
    // Inline `text: @path` form — a bare `@path` on its own line does NOT import.
    ...relImports.map((p) => `Workspace context (imported live): @${p}`),
    "",
  ];
  return lines.join("\n");
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

/** True if the file exists and was written by us (carries the marker). */
function isOurs(abs: string): boolean {
  try {
    return fs.readFileSync(abs, "utf8").includes(INJECT_MARKER);
  } catch {
    return false;
  }
}

/**
 * Pick a slot for the index file: the first candidate that is either free or
 * already one of ours (refresh case). A slot occupied by the repo's own
 * committed file is skipped so we never clobber it. Returns null if every
 * candidate is a foreign committed file.
 */
function pickSlot(worktreeDir: string): { abs: string; rel: string } | null {
  for (const rel of SLOTS) {
    const abs = path.join(worktreeDir, rel);
    if (!fs.existsSync(abs) || isOurs(abs)) return { abs, rel };
  }
  return null;
}

/** gitignore-style path, always forward-slashed and anchored to the repo root. */
function excludePattern(rel: string, isDir = false): string {
  const p = "/" + rel.split(path.sep).join("/");
  return isDir ? p + "/" : p;
}

/**
 * Add patterns to the worktree's git exclude file so a worker never commits
 * the injected artifacts. `--git-path info/exclude` resolves to the file git
 * actually consults for the worktree. Idempotent.
 */
function addGitExclude(worktreeDir: string, patterns: string[]): void {
  const raw = git(worktreeDir, "rev-parse", "--git-path", "info/exclude").trim();
  const excludeFile = path.resolve(worktreeDir, raw);

  let existing = "";
  try {
    existing = fs.readFileSync(excludeFile, "utf8");
  } catch {
    // no exclude file yet
  }
  const present = new Set(existing.split("\n").map((l) => l.trim()));
  const missing = patterns.filter((p) => !present.has(p));
  if (missing.length === 0) return;

  fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  const header = existing.includes("# commandcenter injected context")
    ? ""
    : "# commandcenter injected context (not part of the repo)\n";
  fs.appendFileSync(excludeFile, prefix + header + missing.join("\n") + "\n");
}

/**
 * Symlink each workspace file into the worktree's LINK_DIR and return the
 * import paths RELATIVE to the index file's directory. The dir is wiped and
 * rebuilt each time so a refresh never leaves stale links behind.
 */
function linkWorkspaceFiles(
  worktreeDir: string,
  slotDirAbs: string,
  imports: string[],
): string[] {
  const linkDirAbs = path.join(worktreeDir, LINK_DIR);
  fs.rmSync(linkDirAbs, { recursive: true, force: true });
  fs.mkdirSync(linkDirAbs, { recursive: true });

  return imports.map((target, i) => {
    const linkAbs = path.join(linkDirAbs, `${i + 1}.md`);
    fs.symlinkSync(target, linkAbs);
    // Relative to the index file so `@<rel>` resolves in-tree (no approval)
    // and follows the symlink to the live source.
    return path.relative(slotDirAbs, linkAbs).split(path.sep).join("/");
  });
}

export interface InjectOptions {
  /** Override $HOME (tests). Defaults to os.homedir(). */
  home?: string;
  /** Override parsed context_roots (tests). Defaults to config.contextRoots(). */
  roots?: Record<string, string | string[]>;
}

/**
 * Write (or refresh) the worktree-local workspace-context import for `repo`'s
 * worktree at `worktreeDir`. No-op when there is no workspace file to import.
 * Never throws — a failure here must not break worktree creation / a spawn —
 * it logs a loud platform event instead.
 */
export function injectWorkspaceContext(
  repo: string,
  worktreeDir: string,
  taskId: number,
  provider: AgentProvider = "claude",
  opts?: InjectOptions,
): void {
  try {
    const imports = resolveWorkspaceImports({
      repo,
      home: opts?.home ?? os.homedir(),
      roots: opts?.roots ?? contextRoots(),
      exists: fs.existsSync,
    });
    if (imports.length === 0) return; // nothing above this repo to import

    // Codex discovers AGENTS.md hierarchically and has no `@import` — and the
    // worktree lives outside the workspace ancestor tree, so discovery never
    // reaches the workspace file. It needs the content materialized in-tree.
    if (provider === "codex") {
      injectCodexContext(repo, worktreeDir, taskId, imports);
      return;
    }

    const slot = pickSlot(worktreeDir);
    if (!slot) {
      logEvent("worktree.context_inject_skipped", {
        taskId,
        payload: { reason: "no-free-slot", imports },
      });
      return;
    }

    const relImports = linkWorkspaceFiles(
      worktreeDir,
      path.dirname(slot.abs),
      imports,
    );
    fs.mkdirSync(path.dirname(slot.abs), { recursive: true });
    fs.writeFileSync(slot.abs, renderInjectedFile(relImports, repo));
    addGitExclude(worktreeDir, [
      excludePattern(slot.rel),
      excludePattern(LINK_DIR, true),
    ]);
    logEvent("worktree.context_injected", {
      taskId,
      payload: { slot: slot.rel, imports },
    });
  } catch (err) {
    logEvent("worktree.context_inject_failed", {
      taskId,
      payload: { error: String(err) },
    });
  }
}

/** Worktree-root slot Codex discovers by walking up from its cwd. */
const CODEX_SLOT = "AGENTS.md";

/**
 * Codex path: materialize the workspace context into a worktree-root AGENTS.md.
 * Codex cannot follow Claude's live `@import` symlink trick, so this is a COPY
 * — it refreshes on the next spawn/resume rather than propagating live. We only
 * take the slot when the repo hasn't committed its own AGENTS.md (never clobber
 * it; log a loud skip instead), and git-exclude ours so a worker never commits
 * it. `imports` are absolute paths to the workspace context file(s) discovered
 * above the repo (the same set Claude imports).
 */
function injectCodexContext(
  repo: string,
  worktreeDir: string,
  taskId: number,
  imports: string[],
): void {
  const abs = path.join(worktreeDir, CODEX_SLOT);
  if (fs.existsSync(abs) && !isOurs(abs)) {
    logEvent("worktree.context_inject_skipped", {
      taskId,
      payload: { reason: "agents-md-occupied", provider: "codex", imports },
    });
    return;
  }
  const header = [
    `${INJECT_MARKER} — managed by the commandcenter platform, do not edit.`,
    `This is a git worktree of ${repo}, which runs outside the repo's real`,
    "parent directories, so the workspace-level context file(s) above the repo",
    "are copied in below for Codex (which discovers AGENTS.md hierarchically but",
    "cannot import external paths live). Edit the SOURCE workspace files; this",
    "copy refreshes on the next spawn/resume. This file is git-excluded, never",
    "committed.",
    "",
  ].join("\n");
  const sections = imports.map((p) => {
    let body = "";
    try {
      body = fs.readFileSync(p, "utf8").trim();
    } catch {
      body = "(workspace file unreadable at inject time)";
    }
    return `<!-- workspace context: ${p} -->\n${body}`;
  });
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${header}\n${sections.join("\n\n")}\n`);
  addGitExclude(worktreeDir, [excludePattern(CODEX_SLOT)]);
  logEvent("worktree.context_injected", {
    taskId,
    payload: { slot: CODEX_SLOT, provider: "codex", imports },
  });
}
