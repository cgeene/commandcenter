import { describe, expect, it } from "vitest";
import { resolveWorkspaceImports } from "../src/lib/context-roots.js";

const HOME = "/home/dev";

/** Build an `exists` predicate from a fixed set of present files. */
function existsOf(...present: string[]): (p: string) => boolean {
  const set = new Set(present);
  return (p) => set.has(p);
}

describe("resolveWorkspaceImports — inference", () => {
  it("finds a CLAUDE.md in the repo's parent directory", () => {
    const result = resolveWorkspaceImports({
      repo: "/home/dev/projects/nylas/uas",
      home: HOME,
      roots: {},
      exists: existsOf("/home/dev/projects/nylas/CLAUDE.md"),
    });
    expect(result).toEqual(["/home/dev/projects/nylas/CLAUDE.md"]);
  });

  it("collects every ancestor CLAUDE.md between the repo and $HOME, nearest first", () => {
    const result = resolveWorkspaceImports({
      repo: "/home/dev/projects/nylas/uas",
      home: HOME,
      roots: {},
      exists: existsOf(
        "/home/dev/projects/nylas/CLAUDE.md",
        "/home/dev/projects/CLAUDE.md",
      ),
    });
    expect(result).toEqual([
      "/home/dev/projects/nylas/CLAUDE.md",
      "/home/dev/projects/CLAUDE.md",
    ]);
  });

  it("never imports $HOME's own CLAUDE.md (that is user-scope memory, loaded already)", () => {
    const result = resolveWorkspaceImports({
      repo: "/home/dev/proj",
      home: HOME,
      roots: {},
      // $HOME/CLAUDE.md exists but the repo's parent IS $HOME → not inferred.
      exists: existsOf("/home/dev/CLAUDE.md"),
    });
    expect(result).toEqual([]);
  });

  it("does not infer the repo's OWN CLAUDE.md (it loads from inside the worktree)", () => {
    const result = resolveWorkspaceImports({
      repo: "/home/dev/projects/nylas/uas",
      home: HOME,
      roots: {},
      exists: existsOf("/home/dev/projects/nylas/uas/CLAUDE.md"),
    });
    expect(result).toEqual([]);
  });

  it("infers nothing for a repo outside $HOME (walk requires ancestry under $HOME)", () => {
    const result = resolveWorkspaceImports({
      repo: "/opt/repos/service",
      home: HOME,
      roots: {},
      exists: existsOf("/opt/repos/CLAUDE.md", "/opt/CLAUDE.md"),
    });
    expect(result).toEqual([]);
  });

  it("omits ancestor files that do not exist", () => {
    const result = resolveWorkspaceImports({
      repo: "/home/dev/projects/personal/commandcenter",
      home: HOME,
      roots: {},
      exists: existsOf(), // nothing present
    });
    expect(result).toEqual([]);
  });
});

describe("resolveWorkspaceImports — explicit config", () => {
  it("uses an explicit prefix mapping and puts it ahead of inference", () => {
    const result = resolveWorkspaceImports({
      repo: "/home/dev/projects/nylas/uas",
      home: HOME,
      roots: { "/home/dev/projects/nylas": "/home/dev/notes/nylas.md" },
      exists: existsOf(
        "/home/dev/notes/nylas.md",
        "/home/dev/projects/nylas/CLAUDE.md",
      ),
    });
    expect(result).toEqual([
      "/home/dev/notes/nylas.md",
      "/home/dev/projects/nylas/CLAUDE.md",
    ]);
  });

  it("accepts a list of paths for one prefix", () => {
    const result = resolveWorkspaceImports({
      repo: "/home/dev/projects/nylas/uas",
      home: HOME,
      roots: { "/home/dev/projects/nylas": ["/a/CLAUDE.md", "/b/CLAUDE.md"] },
      exists: existsOf("/a/CLAUDE.md", "/b/CLAUDE.md"),
    });
    expect(result).toEqual(["/a/CLAUDE.md", "/b/CLAUDE.md"]);
  });

  it("enables a repo OUTSIDE $HOME that inference would skip", () => {
    const result = resolveWorkspaceImports({
      repo: "/opt/repos/service",
      home: HOME,
      roots: { "/opt/repos": "/opt/shared/CLAUDE.md" },
      exists: existsOf("/opt/shared/CLAUDE.md"),
    });
    expect(result).toEqual(["/opt/shared/CLAUDE.md"]);
  });

  it("does not apply a prefix the repo is not under", () => {
    const result = resolveWorkspaceImports({
      repo: "/home/dev/projects/other/repo",
      home: HOME,
      roots: { "/home/dev/projects/nylas": "/home/dev/notes/nylas.md" },
      exists: existsOf("/home/dev/notes/nylas.md"),
    });
    expect(result).toEqual([]);
  });

  it("de-duplicates when an explicit path equals an inferred one", () => {
    const result = resolveWorkspaceImports({
      repo: "/home/dev/projects/nylas/uas",
      home: HOME,
      roots: { "/home/dev/projects/nylas": "/home/dev/projects/nylas/CLAUDE.md" },
      exists: existsOf("/home/dev/projects/nylas/CLAUDE.md"),
    });
    expect(result).toEqual(["/home/dev/projects/nylas/CLAUDE.md"]);
  });
});
