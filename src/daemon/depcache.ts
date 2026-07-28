import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  depCacheDir,
  depCacheKeep,
  depCacheMode,
  type DepCacheMode,
} from "../config.js";
import { logEvent } from "../db/events.js";

/**
 * Shared dependency cache for worker/reviewer worktrees.
 *
 * A fresh git worktree has no node_modules, so every worker and every review
 * cycle used to pay a full `npm ci` before it could typecheck or test. The
 * install is identical whenever the branch's package-lock.json is identical,
 * so we keep one installed tree per (repo, package root, lockfile hash) and
 * materialize it into new worktrees.
 *
 * Two rules keep this honest:
 *  - The cache is keyed by the hash of the LOCKFILE IN THE WORKTREE. A branch
 *    that changes dependencies therefore never matches, and its agent installs
 *    for real — a stale cache can't mask a dependency change.
 *  - Every outcome is logged as an event, so a review can say which
 *    environment it actually ran in.
 *
 * The cache is seeded from an already-installed checkout (normally the repo
 * the worktree was cut from) rather than by running an install here: the daemon
 * must not block a spawn for minutes, and the checkout's tree is a real
 * install of the exact same lockfile.
 */

const LOCKFILE = "package-lock.json";
const MODULES = "node_modules";
const STAGING_PREFIX = ".staging-";
/** Staging dirs older than this are leftovers from a crashed populate. */
const STAGING_TTL_MS = 60 * 60 * 1000;

export type DepPrimeStatus = "linked" | "present" | "miss";

export interface DepPrimeResult {
  /** Package root relative to the worktree: "." or e.g. "web". */
  root: string;
  status: DepPrimeStatus;
  /** Why nothing was linked, for `status: "miss"`. */
  reason?: string;
  mode?: DepCacheMode;
  /** "cache" = reused an existing entry; "seed" = published one first. */
  source?: "cache" | "seed";
  lockHash?: string;
  detail?: string;
}

function sha256(input: Buffer | string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function hashLockfile(file: string): string | undefined {
  try {
    return sha256(fs.readFileSync(file)).slice(0, 24);
  } catch {
    return undefined;
  }
}

/**
 * Package roots in a worktree: the repo root plus any immediate subdirectory
 * with its own lockfile (this repo's `web/`). One level is deliberate — deeper
 * scanning would walk vendored trees for no benefit.
 */
export function packageRoots(worktree: string): string[] {
  const roots: string[] = [];
  if (fs.existsSync(path.join(worktree, LOCKFILE))) roots.push(".");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(worktree, { withFileTypes: true });
  } catch {
    return roots;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === MODULES) {
      continue;
    }
    if (fs.existsSync(path.join(worktree, entry.name, LOCKFILE))) roots.push(entry.name);
  }
  return roots;
}

/** Path key for a repo: readable basename plus a hash so two same-named repos
 *  in different roots never share a cache. */
function repoKey(repo: string): string {
  const resolved = path.resolve(repo);
  return `${path.basename(resolved)}-${sha256(resolved).slice(0, 12)}`;
}

function rootKey(root: string): string {
  return root === "." ? "root" : root.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

/** Where all lockfile generations for one package root live. */
export function cacheRootDir(repo: string, root: string): string {
  return path.join(depCacheDir(), repoKey(repo), rootKey(root));
}

/** One generation: `<cacheRootDir>/<lockHash>/node_modules`. */
export function cacheEntryDir(repo: string, root: string, lockHash: string): string {
  return path.join(cacheRootDir(repo, root), lockHash);
}

/** Copy-on-write clone. Fails (rather than falling back to a real copy) when
 *  the filesystem has no clonefile support — the caller decides what that means. */
function cloneTree(src: string, dest: string): boolean {
  try {
    execFileSync("cp", ["-Rc", src, dest], { stdio: "ignore" });
    return true;
  } catch {
    fs.rmSync(dest, { recursive: true, force: true });
    return false;
  }
}

/** Clone if the filesystem supports it, otherwise a plain recursive copy.
 *  Only used when populating the cache — a once-per-lockfile cost. */
function copyTree(src: string, dest: string): void {
  if (cloneTree(src, dest)) return;
  // -R copies symlinks as symlinks on both BSD and GNU cp, which matters:
  // node_modules/.bin is entirely relative symlinks.
  execFileSync("cp", ["-R", src, dest], { stdio: "ignore" });
}

export interface PublishHooks {
  /** Test seam: runs after the staging copy is complete but before the atomic
   *  rename, so the lost-the-race branch can be exercised deterministically. */
  afterStage?: () => void;
}

/**
 * Publish an installed node_modules as the cache entry for a lockfile hash.
 *
 * Concurrency-safe by construction: the copy lands in a private staging dir
 * and only becomes visible via one atomic rename, so a reader can never see a
 * half-populated entry. Two populates of the same hash race harmlessly — the
 * loser discards its staging copy and keeps the winner's tree, which is an
 * install of the identical lockfile either way.
 */
export function publishCacheEntry(
  sourceModules: string,
  entryDir: string,
  hooks?: PublishHooks,
): "published" | "existing" {
  if (fs.existsSync(path.join(entryDir, MODULES))) return "existing";
  const parent = path.dirname(entryDir);
  fs.mkdirSync(parent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(parent, STAGING_PREFIX));
  try {
    copyTree(sourceModules, path.join(staging, MODULES));
    hooks?.afterStage?.();
    try {
      fs.renameSync(staging, entryDir);
      return "published";
    } catch (err) {
      if (fs.existsSync(path.join(entryDir, MODULES))) return "existing";
      throw err;
    }
  } finally {
    // No-op after a successful rename; cleans up the copy otherwise.
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Put the cached tree in the worktree. Symlink mode shares one tree; clone
 *  mode gives the worktree a private copy-on-write copy. */
function materialize(cached: string, target: string, mode: DepCacheMode): boolean {
  if (mode === "symlink") {
    fs.symlinkSync(cached, target, "dir");
    return true;
  }
  const staging = `${target}.cc-staging-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  if (!cloneTree(cached, staging)) return false;
  fs.renameSync(staging, target);
  return true;
}

function mtimeMs(target: string): number {
  try {
    return fs.statSync(target).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Keep the newest `depCacheKeep()` generations for a package root (always
 * including the one just used) and delete the rest, plus any staging dir left
 * behind by a crashed populate.
 */
export function evictOldGenerations(cacheRoot: string, keepHash: string, now: number): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(cacheRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed: string[] = [];
  const generations: { name: string; mtime: number }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(cacheRoot, entry.name);
    if (entry.name.startsWith(STAGING_PREFIX)) {
      if (now - mtimeMs(full) > STAGING_TTL_MS) {
        fs.rmSync(full, { recursive: true, force: true });
        removed.push(entry.name);
      }
      continue;
    }
    if (entry.name === keepHash) continue;
    generations.push({ name: entry.name, mtime: mtimeMs(full) });
  }
  generations.sort((a, b) => b.mtime - a.mtime);
  // The generation just used is kept implicitly, so it takes one of the slots.
  for (const stale of generations.slice(Math.max(0, depCacheKeep() - 1))) {
    fs.rmSync(path.join(cacheRoot, stale.name), { recursive: true, force: true });
    removed.push(stale.name);
  }
  return removed;
}

function primeRoot(
  repo: string,
  worktree: string,
  root: string,
  mode: DepCacheMode,
): DepPrimeResult {
  const target = path.join(worktree, root, MODULES);
  if (fs.existsSync(target)) return { root, status: "present" };

  const lockHash = hashLockfile(path.join(worktree, root, LOCKFILE));
  if (!lockHash) return { root, status: "miss", reason: "no-lockfile" };

  const entry = cacheEntryDir(repo, root, lockHash);
  const cached = path.join(entry, MODULES);
  let source: "cache" | "seed" = "cache";

  if (!fs.existsSync(cached)) {
    const sourceModules = path.join(repo, root, MODULES);
    const sourceHash = hashLockfile(path.join(repo, root, LOCKFILE));
    if (!fs.existsSync(sourceModules) || !sourceHash) {
      return { root, status: "miss", reason: "no-installed-source", lockHash };
    }
    if (sourceHash !== lockHash) {
      // The branch changed its dependencies. Nothing we hold is an install of
      // THIS lockfile, so the agent must run a real one.
      return { root, status: "miss", reason: "lockfile-changed", lockHash };
    }
    source = "seed";
    publishCacheEntry(sourceModules, entry);
  }

  if (!materialize(cached, target, mode)) {
    return { root, status: "miss", reason: "clone-unsupported", lockHash };
  }
  const now = Date.now();
  try {
    // Freshen so eviction is least-recently-used, not least-recently-created.
    fs.utimesSync(entry, new Date(now), new Date(now));
  } catch {
    // A cache entry we cannot stamp is still usable.
  }
  evictOldGenerations(path.dirname(entry), lockHash, now);
  return { root, status: "linked", mode, source, lockHash };
}

/**
 * Give a freshly created worktree its dependencies from the shared cache when
 * the branch's lockfiles match an install we already have. Best-effort by
 * design: any failure leaves node_modules absent, which is exactly the old
 * behavior (the agent installs), so this can never break a spawn.
 */
export function primeWorktreeDeps(
  repo: string,
  worktree: string,
  taskId: number,
): DepPrimeResult[] {
  const mode = depCacheMode();
  if (mode === "off") return [];
  const results: DepPrimeResult[] = [];
  for (const root of packageRoots(worktree)) {
    let result: DepPrimeResult;
    try {
      result = primeRoot(repo, worktree, root, mode);
    } catch (err) {
      result = { root, status: "miss", reason: "error", detail: String(err) };
    }
    results.push(result);
    if (result.status === "linked") {
      logEvent("worktree.deps_linked", {
        taskId,
        payload: {
          root: result.root,
          mode: result.mode,
          source: result.source,
          lockfile_hash: result.lockHash,
        },
      });
    } else if (result.status === "miss" && result.reason !== "no-lockfile") {
      // Worth recording: the agent is about to pay for a real install, and a
      // "lockfile-changed" miss means this worktree's deps differ from the
      // rest of the fleet's.
      logEvent("worktree.deps_uncached", {
        taskId,
        payload: { root: result.root, reason: result.reason, detail: result.detail },
      });
    }
  }
  return results;
}

/** True when any package root in the worktree has dependencies in place — used
 *  to tell an agent it does not need to install. */
export function worktreeHasDeps(worktree: string): boolean {
  return packageRoots(worktree).some((root) =>
    fs.existsSync(path.join(worktree, root, MODULES)),
  );
}
