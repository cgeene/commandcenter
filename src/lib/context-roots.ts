import path from "node:path";

/**
 * Pure resolution of the workspace-level CLAUDE.md files that a repo should
 * import. Dependency-free (path only) so it can be unit-tested with a fake
 * filesystem — the daemon passes real `fs.existsSync` and `os.homedir()`.
 *
 * Two sources, unioned with explicit config taking precedence in ordering:
 *
 *  1. Explicit `context_roots` config: a map of directory-prefix ->
 *     CLAUDE.md path(s). Every prefix the repo path sits under contributes
 *     its configured paths. This lets a workspace file live anywhere, or a
 *     repo outside $HOME opt in.
 *
 *  2. Inference: the CLAUDE.md files in the repo's ANCESTOR directories,
 *     starting at the repo's parent and walking up, but only while the
 *     ancestor is strictly inside $HOME — i.e. up to, but never into, $HOME
 *     itself. ($HOME's own CLAUDE.md and ~/.claude/CLAUDE.md are already
 *     loaded by Claude Code as user-scope memory, and the repo's own
 *     CLAUDE.md loads from inside the worktree, so neither is inferred here.)
 *     A repo outside $HOME infers nothing — use explicit config for those.
 *
 * The repo's own CLAUDE.md is deliberately excluded (the walk begins at the
 * parent) because it lives in the worktree and Claude Code discovers it there.
 */
export interface ResolveWorkspaceImportsArgs {
  /** Absolute path to the repository (the ORIGINAL checkout, not the worktree). */
  repo: string;
  /** Absolute path to $HOME — the inference ceiling. */
  home: string;
  /** Parsed `context_roots` config: directory-prefix -> CLAUDE.md path(s).
   *  A bare string is treated as a single-element list. */
  roots: Record<string, string | string[]>;
  /** Existence predicate (real: fs.existsSync). Only existing files survive. */
  exists: (p: string) => boolean;
}

/** child === base, or child is nested somewhere beneath base. */
function isUnderOrEqual(child: string, base: string): boolean {
  return child === base || child.startsWith(base + path.sep);
}

/** child is nested strictly beneath base (never equal to it). */
function isStrictlyUnder(child: string, base: string): boolean {
  return child !== base && child.startsWith(base + path.sep);
}

/**
 * Ordered, de-duplicated list of absolute CLAUDE.md paths the repo should
 * import — explicit-config matches first (so they win on ordering), then
 * inferred ancestors, then filtered to files that actually exist.
 */
export function resolveWorkspaceImports(args: ResolveWorkspaceImportsArgs): string[] {
  const { roots, exists } = args;
  const repo = path.resolve(args.repo);
  const home = path.resolve(args.home);

  const candidates: string[] = [];

  // 1. Explicit config — any configured prefix the repo sits under contributes.
  for (const [prefix, paths] of Object.entries(roots)) {
    if (isUnderOrEqual(repo, path.resolve(prefix))) {
      const list = Array.isArray(paths) ? paths : [paths];
      for (const p of list) candidates.push(path.resolve(p));
    }
  }

  // 2. Inference — ancestor CLAUDE.md files strictly between the repo and $HOME.
  let cur = path.dirname(repo);
  while (isStrictlyUnder(cur, home)) {
    candidates.push(path.join(cur, "CLAUDE.md"));
    const parent = path.dirname(cur);
    if (parent === cur) break; // filesystem-root guard (defensive)
    cur = parent;
  }

  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of candidates) {
    if (seen.has(p)) continue;
    seen.add(p);
    if (exists(p)) result.push(p);
  }
  return result;
}
