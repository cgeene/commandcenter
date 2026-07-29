import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-depcache-"));
  process.env.CC_DATA_DIR = path.join(tmpDir, "data");
  // Symlink mode keeps these tests filesystem-agnostic; the clone path is
  // exercised separately on macOS, where clonefile always works.
  process.env.CC_DEPCACHE_MODE = "symlink";
  delete process.env.CC_DEPCACHE_KEEP;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.CC_DEPCACHE_MODE;
  delete process.env.CC_DEPCACHE_KEEP;
});

/** A package root: package.json + lockfile, and node_modules only if installed. */
function writePackageRoot(dir: string, lock: string, installed: boolean): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "p" }));
  fs.writeFileSync(path.join(dir, "package-lock.json"), lock);
  if (installed) {
    fs.mkdirSync(path.join(dir, "node_modules", "dep"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", "dep", "index.js"), lock);
  }
}

/** Stand-in for the daemon's main checkout: installed, root + web/. */
function installedRepo(name = "repo", lock = "lock-v1"): string {
  const repo = path.join(tmpDir, name);
  writePackageRoot(repo, lock, true);
  writePackageRoot(path.join(repo, "web"), `web-${lock}`, true);
  return repo;
}

/** Stand-in for a fresh worktree: same sources, no node_modules anywhere. */
function bareWorktree(name: string, lock = "lock-v1"): string {
  const dir = path.join(tmpDir, name);
  writePackageRoot(dir, lock, false);
  writePackageRoot(path.join(dir, "web"), `web-${lock}`, false);
  return dir;
}

function depMarker(root: string): string {
  return fs.readFileSync(path.join(root, "node_modules", "dep", "index.js"), "utf8");
}

describe("primeWorktreeDeps", () => {
  it("seeds the cache from the installed checkout and links both package roots", async () => {
    const { primeWorktreeDeps } = await import("../src/daemon/depcache.js");
    const { listEvents } = await import("../src/db/events.js");
    const repo = installedRepo();
    const worktree = bareWorktree("wt-1");

    const results = primeWorktreeDeps(repo, worktree, 1);

    expect(results.map((r) => r.root)).toEqual([".", "web"]);
    expect(results.every((r) => r.status === "linked" && r.source === "seed")).toBe(true);
    expect(depMarker(worktree)).toBe("lock-v1");
    expect(depMarker(path.join(worktree, "web"))).toBe("web-lock-v1");

    const linked = listEvents(20).filter((e) => e.kind === "worktree.deps_linked");
    expect(linked).toHaveLength(2);
    expect(JSON.parse(linked[0].payload!).mode).toBe("symlink");
  });

  it("reuses a published entry for the next worktree, with no installed source left", async () => {
    const { primeWorktreeDeps } = await import("../src/daemon/depcache.js");
    const repo = installedRepo();
    primeWorktreeDeps(repo, bareWorktree("wt-1"), 1);

    // Prove the second worktree is served by the cache and not by the repo.
    fs.rmSync(path.join(repo, "node_modules"), { recursive: true, force: true });
    fs.rmSync(path.join(repo, "web", "node_modules"), { recursive: true, force: true });
    const second = bareWorktree("wt-2");
    const results = primeWorktreeDeps(repo, second, 2);

    expect(results.every((r) => r.status === "linked" && r.source === "cache")).toBe(true);
    expect(depMarker(second)).toBe("lock-v1");
  });

  it("falls back to a real install when the branch changes the lockfile", async () => {
    const { primeWorktreeDeps } = await import("../src/daemon/depcache.js");
    const { listEvents } = await import("../src/db/events.js");
    const repo = installedRepo();
    const worktree = bareWorktree("wt-1");
    // The branch under review bumped a dependency.
    fs.writeFileSync(path.join(worktree, "package-lock.json"), "lock-v2");

    const results = primeWorktreeDeps(repo, worktree, 3);

    const root = results.find((r) => r.root === ".")!;
    expect(root).toMatchObject({ status: "miss", reason: "lockfile-changed" });
    expect(fs.existsSync(path.join(worktree, "node_modules"))).toBe(false);
    // The untouched web/ root still gets its cached deps.
    expect(results.find((r) => r.root === "web")!.status).toBe("linked");

    const uncached = listEvents(20).filter((e) => e.kind === "worktree.deps_uncached");
    expect(uncached).toHaveLength(1);
    expect(JSON.parse(uncached[0].payload!).reason).toBe("lockfile-changed");
  });

  it("reports a miss without an installed source to seed from", async () => {
    const { primeWorktreeDeps } = await import("../src/daemon/depcache.js");
    const repo = path.join(tmpDir, "uninstalled");
    writePackageRoot(repo, "lock-v1", false);
    const worktree = path.join(tmpDir, "wt-1");
    writePackageRoot(worktree, "lock-v1", false);

    expect(primeWorktreeDeps(repo, worktree, 4)).toEqual([
      { root: ".", status: "miss", reason: "no-installed-source", lockHash: expect.any(String) },
    ]);
  });

  it("leaves an already-populated worktree alone", async () => {
    const { primeWorktreeDeps } = await import("../src/daemon/depcache.js");
    const { listEvents } = await import("../src/db/events.js");
    const repo = installedRepo();
    const worktree = path.join(tmpDir, "wt-1");
    writePackageRoot(worktree, "lock-v1", true);
    fs.writeFileSync(path.join(worktree, "node_modules", "dep", "index.js"), "mine");

    expect(primeWorktreeDeps(repo, worktree, 5)).toEqual([{ root: ".", status: "present" }]);
    expect(depMarker(worktree)).toBe("mine");
    expect(listEvents(20).filter((e) => e.kind.startsWith("worktree.deps"))).toHaveLength(0);
  });

  it("does nothing when the cache is turned off", async () => {
    process.env.CC_DEPCACHE_MODE = "off";
    const { primeWorktreeDeps } = await import("../src/daemon/depcache.js");
    const worktree = bareWorktree("wt-1");

    expect(primeWorktreeDeps(installedRepo(), worktree, 6)).toEqual([]);
    expect(fs.existsSync(path.join(worktree, "node_modules"))).toBe(false);
  });

  it.skipIf(process.platform !== "darwin")(
    "clone mode gives the worktree a private copy the cache cannot see",
    async () => {
      process.env.CC_DEPCACHE_MODE = "clone";
      const { primeWorktreeDeps, cacheEntryDir } = await import("../src/daemon/depcache.js");
      const repo = installedRepo();
      const worktree = bareWorktree("wt-1");

      const results = primeWorktreeDeps(repo, worktree, 7);
      expect(results[0]).toMatchObject({ status: "linked", mode: "clone" });
      expect(fs.lstatSync(path.join(worktree, "node_modules")).isSymbolicLink()).toBe(false);

      // An agent that installs anyway must not corrupt the shared cache.
      fs.writeFileSync(path.join(worktree, "node_modules", "dep", "index.js"), "mutated");
      const cached = path.join(
        cacheEntryDir(repo, ".", results[0].lockHash!),
        "node_modules",
        "dep",
        "index.js",
      );
      expect(fs.readFileSync(cached, "utf8")).toBe("lock-v1");
    },
  );
});

describe("publishCacheEntry", () => {
  it("keeps the winner's tree when two populates race, and leaves no staging dirs", async () => {
    const { publishCacheEntry } = await import("../src/daemon/depcache.js");
    const source = path.join(tmpDir, "src");
    writePackageRoot(source, "lock-v1", true);
    const sourceModules = path.join(source, "node_modules");
    const entry = path.join(tmpDir, "cache", "abc123");

    // The competitor publishes while this call is still copying, so the rename
    // below lands on an entry that already exists.
    const afterStage = () => {
      fs.mkdirSync(path.join(entry, "node_modules", "dep"), { recursive: true });
      fs.writeFileSync(path.join(entry, "node_modules", "dep", "index.js"), "winner");
    };

    expect(publishCacheEntry(sourceModules, entry, { afterStage })).toBe("existing");
    expect(depMarker(entry)).toBe("winner");
    expect(fs.readdirSync(path.dirname(entry))).toEqual(["abc123"]);
  });

});

describe("eviction", () => {
  it("keeps the newest generations per package root and drops the rest", async () => {
    process.env.CC_DEPCACHE_KEEP = "2";
    const { primeWorktreeDeps, cacheRootDir } = await import("../src/daemon/depcache.js");
    const repo = installedRepo();
    const current = primeWorktreeDeps(repo, bareWorktree("wt-1"), 1).find((r) => r.root === ".")!;
    const cacheRoot = cacheRootDir(repo, ".");

    // Two earlier lockfile generations, plus a staging dir abandoned by a
    // crashed populate.
    for (const [name, ageMs] of [
      ["older", 60_000],
      ["oldest", 120_000],
    ] as const) {
      const dir = path.join(cacheRoot, name, "node_modules");
      fs.mkdirSync(dir, { recursive: true });
      const when = new Date(Date.now() - ageMs);
      fs.utimesSync(path.join(cacheRoot, name), when, when);
    }
    const staleStaging = path.join(cacheRoot, ".staging-crashed");
    fs.mkdirSync(staleStaging, { recursive: true });
    const longAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(staleStaging, longAgo, longAgo);

    primeWorktreeDeps(repo, bareWorktree("wt-2"), 2);

    // keep=2 means the generation in use plus the most recent other one.
    expect(fs.readdirSync(cacheRoot).sort()).toEqual([current.lockHash, "older"].sort());
  });
});
