import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-mem-"));
  process.env.CC_DATA_DIR = tmpDir;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("memories", () => {
  it("stores and searches with relevance ranking", async () => {
    const { addMemory, searchMemories } = await import("../src/db/memories.js");
    addMemory({ text: "the functions repo needs make generate before running tests" });
    addMemory({ text: "uas oauth tokens rotate hourly in staging" });
    addMemory({ text: "dashboard-v3 uses turborepo, build from the root" });

    const hits = searchMemories("how do I run tests in the functions repo");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].text).toContain("make generate");
  });

  it("survives natural-language queries with FTS syntax characters", async () => {
    const { addMemory, searchMemories } = await import("../src/db/memories.js");
    addMemory({ text: "worktree cleanup requires --force sometimes" });
    // quotes, parens, hyphens, colons are all FTS5 syntax — must not throw
    const hits = searchMemories(`what's "worktree" (cleanup) --force repo:functions?`);
    expect(hits.length).toBeGreaterThan(0);
  });

  it("falls back to recent list when the query has no usable terms", async () => {
    const { addMemory, searchMemories } = await import("../src/db/memories.js");
    addMemory({ text: "alpha memory" });
    addMemory({ text: "beta memory" });
    const hits = searchMemories("?? !!");
    expect(hits.length).toBe(2);
  });

  it("deletes memories and keeps the FTS index in sync", async () => {
    const { addMemory, deleteMemory, searchMemories } = await import(
      "../src/db/memories.js"
    );
    const m = addMemory({ text: "ephemeral spanner emulator quirk" });
    expect(searchMemories("spanner emulator").length).toBe(1);
    expect(deleteMemory(m.id)).toBe(true);
    expect(searchMemories("spanner emulator").length).toBe(0);
  });

  it("renders a prompt section only when there are hits", async () => {
    const { addMemory, memorySectionFor } = await import("../src/db/memories.js");
    expect(memorySectionFor("anything at all")).toBe("");
    addMemory({ text: "notetaker builds need docker running" });
    const section = memorySectionFor("fix the notetaker docker build");
    expect(section).toContain("Platform memory");
    expect(section).toContain("docker running");
  });

  it("tags are searchable", async () => {
    const { addMemory, searchMemories } = await import("../src/db/memories.js");
    addMemory({ text: "always run go vet", tags: "repo:uas,linting" });
    expect(searchMemories("linting uas").length).toBe(1);
  });
});
