import { describe, expect, it } from "vitest";
import { resolveWorkspaceImports } from "../src/lib/context-roots.js";

const HOME = "/home/dev";

/** Build an `exists` predicate from a fixed set of present files. */
function existsOf(...present: string[]): (p: string) => boolean {
  const set = new Set(present);
  return (p) => set.has(p);
}

describe("resolveWorkspaceImports", () => {
  // A pure function of (repo, home, roots, exists): one table, one row per rule.
  // Explicit mappings come first and inference follows, de-duplicated — order is
  // part of the contract because the nearest workspace file should win.
  it("resolves the workspace files a repo imports, explicit before inferred", () => {
    for (const { why, repo, roots, present, imports } of [
      {
        why: "a CLAUDE.md in the repo's parent directory",
        repo: "/home/dev/projects/nylas/uas",
        roots: {},
        present: ["/home/dev/projects/nylas/CLAUDE.md"],
        imports: ["/home/dev/projects/nylas/CLAUDE.md"],
      },
      {
        why: "every ancestor between the repo and $HOME, nearest first",
        repo: "/home/dev/projects/nylas/uas",
        roots: {},
        present: ["/home/dev/projects/nylas/CLAUDE.md", "/home/dev/projects/CLAUDE.md"],
        imports: ["/home/dev/projects/nylas/CLAUDE.md", "/home/dev/projects/CLAUDE.md"],
      },
      {
        // $HOME/CLAUDE.md exists but the repo's parent IS $HOME — user-scope
        // memory is already loaded, so it is never imported as a workspace file.
        why: "never $HOME's own CLAUDE.md",
        repo: "/home/dev/proj",
        roots: {},
        present: ["/home/dev/CLAUDE.md"],
        imports: [],
      },
      {
        why: "never the repo's OWN CLAUDE.md (it loads from inside the worktree)",
        repo: "/home/dev/projects/nylas/uas",
        roots: {},
        present: ["/home/dev/projects/nylas/uas/CLAUDE.md"],
        imports: [],
      },
      {
        why: "nothing inferred for a repo outside $HOME (the walk requires ancestry)",
        repo: "/opt/repos/service",
        roots: {},
        present: ["/opt/repos/CLAUDE.md", "/opt/CLAUDE.md"],
        imports: [],
      },
      {
        why: "ancestor files that do not exist are omitted",
        repo: "/home/dev/projects/personal/commandcenter",
        roots: {},
        present: [],
        imports: [],
      },
      {
        why: "an explicit prefix mapping, ahead of inference",
        repo: "/home/dev/projects/nylas/uas",
        roots: { "/home/dev/projects/nylas": "/home/dev/notes/nylas.md" },
        present: ["/home/dev/notes/nylas.md", "/home/dev/projects/nylas/CLAUDE.md"],
        imports: ["/home/dev/notes/nylas.md", "/home/dev/projects/nylas/CLAUDE.md"],
      },
      {
        why: "a list of paths for one prefix",
        repo: "/home/dev/projects/nylas/uas",
        roots: { "/home/dev/projects/nylas": ["/a/CLAUDE.md", "/b/CLAUDE.md"] },
        present: ["/a/CLAUDE.md", "/b/CLAUDE.md"],
        imports: ["/a/CLAUDE.md", "/b/CLAUDE.md"],
      },
      {
        why: "an explicit mapping enables a repo OUTSIDE $HOME that inference skips",
        repo: "/opt/repos/service",
        roots: { "/opt/repos": "/opt/shared/CLAUDE.md" },
        present: ["/opt/shared/CLAUDE.md"],
        imports: ["/opt/shared/CLAUDE.md"],
      },
      {
        why: "a prefix the repo is not under does not apply",
        repo: "/home/dev/projects/other/repo",
        roots: { "/home/dev/projects/nylas": "/home/dev/notes/nylas.md" },
        present: ["/home/dev/notes/nylas.md"],
        imports: [],
      },
      {
        why: "an explicit path equal to an inferred one is de-duplicated",
        repo: "/home/dev/projects/nylas/uas",
        roots: { "/home/dev/projects/nylas": "/home/dev/projects/nylas/CLAUDE.md" },
        present: ["/home/dev/projects/nylas/CLAUDE.md"],
        imports: ["/home/dev/projects/nylas/CLAUDE.md"],
      },
    ] as const) {
      const result = resolveWorkspaceImports({
        repo,
        home: HOME,
        roots: roots as Record<string, string | string[]>,
        exists: existsOf(...present),
      });
      expect(result, why).toEqual([...imports]);
    }
  });
});
