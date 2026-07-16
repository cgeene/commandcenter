import fs from "node:fs";
import path from "node:path";
import {
  configuredRepoRoots,
  scratchRetentionDays,
  scratchWorkspacesDir,
} from "../config.js";
import type { Task } from "../db/tasks.js";

const MAX_ROOTS = 10;
const MAX_REPOSITORIES = 500;
const MAX_SCAN_DEPTH = 5;
const MAX_PATH_BYTES = 4096;
const SCRATCH_NAME = /^task-[A-Za-z0-9_-]{6,64}$/;
const SKIP_DIRS = new Set([
  ".codex-worktrees",
  ".commandcenter",
  ".git",
  "node_modules",
  "vendor",
]);

export class WorkspaceValidationError extends Error {}

export interface RepositoryRoot {
  path: string;
  label: string;
}

export interface RepositoryEntry {
  path: string;
  name: string;
  relative_path: string;
  root: string;
}

export interface WorkspaceCatalog {
  roots: RepositoryRoot[];
  repositories: RepositoryEntry[];
  scratch_retention_days: number;
}

function boundedAbsolutePath(value: string, label: string): string {
  if (
    !value ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES ||
    !path.isAbsolute(value)
  ) {
    throw new WorkspaceValidationError(`${label} must be an absolute path`);
  }
  return path.normalize(value);
}

function realDirectory(value: string, label: string): string {
  const normalized = boundedAbsolutePath(value, label);
  let stat: fs.Stats;
  let real: string;
  try {
    stat = fs.lstatSync(normalized);
    real = fs.realpathSync(normalized);
  } catch {
    throw new WorkspaceValidationError(`${label} is unavailable`);
  }
  // Reject a symlink at the selected boundary. Intermediate platform aliases
  // such as macOS /var -> /private/var are canonicalized through realpath;
  // containment checks always compare the resulting real paths.
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new WorkspaceValidationError(`${label} must be a real directory`);
  }
  return real;
}

function containedBy(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function hasGitMarker(dir: string): boolean {
  try {
    const marker = fs.lstatSync(path.join(dir, ".git"));
    return !marker.isSymbolicLink() && (marker.isDirectory() || marker.isFile());
  } catch {
    return false;
  }
}

export function repositoryRoots(): RepositoryRoot[] {
  const configured = configuredRepoRoots();
  if (configured.length > MAX_ROOTS) {
    throw new WorkspaceValidationError("too many repository roots configured");
  }
  const seen = new Set<string>();
  const roots: RepositoryRoot[] = [];
  for (const value of configured) {
    const root = realDirectory(value, "repository root");
    if (seen.has(root)) continue;
    seen.add(root);
    roots.push({ path: root, label: path.basename(root) || root });
  }
  return roots;
}

/** Discover Git roots without following symlinks or descending into repos. */
export function listRepositories(): RepositoryEntry[] {
  const roots = repositoryRoots();
  const repositories: RepositoryEntry[] = [];
  for (const root of roots) {
    const visit = (dir: string, depth: number): void => {
      if (repositories.length >= MAX_REPOSITORIES || depth > MAX_SCAN_DEPTH) return;
      if (hasGitMarker(dir)) {
        const relative = path.relative(root.path, dir) || path.basename(dir);
        repositories.push({
          path: dir,
          name: path.basename(dir),
          relative_path: relative,
          root: root.path,
        });
        return;
      }
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (
          repositories.length >= MAX_REPOSITORIES ||
          !entry.isDirectory() ||
          entry.isSymbolicLink() ||
          entry.name.startsWith(".") ||
          SKIP_DIRS.has(entry.name)
        ) {
          continue;
        }
        visit(path.join(dir, entry.name), depth + 1);
      }
    };
    visit(root.path, 0);
  }
  return repositories.sort(
    (a, b) => a.root.localeCompare(b.root) || a.relative_path.localeCompare(b.relative_path),
  );
}

export function workspaceCatalog(): WorkspaceCatalog {
  return {
    roots: repositoryRoots(),
    repositories: listRepositories(),
    scratch_retention_days: scratchRetentionDays(),
  };
}

/** Canonicalize a browser/agent selection and fail closed outside allow-listed roots. */
export function resolveAllowedRepository(value: string): string {
  const candidate = realDirectory(value, "repository");
  const roots = repositoryRoots();
  if (roots.length === 0) {
    throw new WorkspaceValidationError("no repository roots are configured");
  }
  if (!roots.some((root) => containedBy(candidate, root.path)) || !hasGitMarker(candidate)) {
    throw new WorkspaceValidationError("repository is not an allowed Git root");
  }
  return candidate;
}

/** Resolve a portfolio child and enforce that it stays under its parent root. */
export function resolvePortfolioChildRepository(
  value: string,
  parentRoot: string,
): string {
  const candidate = resolveAllowedRepository(value);
  const root = resolvePortfolioRoot(parentRoot);
  if (candidate === root || !containedBy(candidate, root)) {
    throw new WorkspaceValidationError(
      "child repository is outside the parent repository root",
    );
  }
  return candidate;
}

export function resolvePortfolioRoot(value?: string): string {
  const roots = repositoryRoots();
  if (roots.length === 0) {
    throw new WorkspaceValidationError("no repository roots are configured");
  }
  if (!value) {
    if (roots.length !== 1) {
      throw new WorkspaceValidationError("select a repository root");
    }
    return roots[0].path;
  }
  const selected = realDirectory(value, "repository root");
  if (!roots.some((root) => root.path === selected)) {
    throw new WorkspaceValidationError("repository root is not allowed");
  }
  return selected;
}

function ensureScratchRoot(): string {
  const configured = boundedAbsolutePath(scratchWorkspacesDir(), "scratch root");
  if (fs.existsSync(configured)) {
    const stat = fs.lstatSync(configured);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new WorkspaceValidationError("scratch root must be a real directory");
    }
  } else {
    fs.mkdirSync(configured, { recursive: true, mode: 0o700 });
  }
  const real = realDirectory(configured, "scratch root");
  fs.chmodSync(real, 0o700);
  return real;
}

export function allocateScratchWorkspace(): string {
  const root = ensureScratchRoot();
  const dir = fs.mkdtempSync(path.join(root, "task-"));
  fs.chmodSync(dir, 0o700);
  return validateScratchWorkspace(dir);
}

export function validateScratchWorkspace(value: string): string {
  const root = ensureScratchRoot();
  const dir = realDirectory(value, "scratch workspace");
  if (
    path.dirname(dir) !== root ||
    !SCRATCH_NAME.test(path.basename(dir))
  ) {
    throw new WorkspaceValidationError("scratch workspace is outside its managed root");
  }
  return dir;
}

export function listScratchWorkspaces(): string[] {
  const root = ensureScratchRoot();
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        SCRATCH_NAME.test(entry.name),
    )
    .map((entry) => validateScratchWorkspace(path.join(root, entry.name)))
    .sort();
}

export function removeScratchWorkspace(value: string): void {
  const dir = validateScratchWorkspace(value);
  fs.rmSync(dir, { recursive: true, force: false });
}

/** Remove only expired, terminal or orphaned Command Center-owned scratch dirs. */
export function pruneScratchWorkspaces(
  tasks: Task[],
  now = new Date(),
): string[] {
  const cutoff = now.getTime() - scratchRetentionDays() * 24 * 60 * 60 * 1000;
  const protectedPaths = new Set(
    tasks
      .filter(
        (task) =>
          task.workspace_kind === "scratch" &&
          (!["done", "failed", "cancelled"].includes(task.status) ||
            Date.parse(task.updated_at) >= cutoff),
      )
      .map((task) => task.repo),
  );
  const removed: string[] = [];
  for (const dir of listScratchWorkspaces()) {
    if (protectedPaths.has(dir)) continue;
    const task = tasks.find(
      (candidate) => candidate.workspace_kind === "scratch" && candidate.repo === dir,
    );
    const age = task ? Date.parse(task.updated_at) : fs.statSync(dir).mtimeMs;
    if (age >= cutoff) continue;
    removeScratchWorkspace(dir);
    removed.push(dir);
  }
  return removed;
}
