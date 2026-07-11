import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-docs-"));
  process.env.CC_DATA_DIR = tmpDir;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("docs store (db + filesystem)", () => {
  it("saves a doc to disk and reads it back with content", async () => {
    const { saveDoc, getDoc } = await import("../src/db/docs.js");
    const { docsDir } = await import("../src/config.js");
    const { doc, created } = saveDoc({
      project: "cogs",
      title: "Cost Data Inventory",
      content: "# Inventory\n\nbilling export is live.",
    });
    expect(created).toBe(true);
    expect(doc.slug).toBe("cost-data-inventory");
    expect(doc.project).toBe("cogs");
    expect(doc.version).toBe(1);
    // the body is a plain file on disk under docsDir/<project>/<slug>.md
    const abs = path.join(docsDir(), doc.file_path);
    expect(fs.readFileSync(abs, "utf8")).toContain("billing export is live");

    const fetched = getDoc(doc.id)!;
    expect(fetched.content).toContain("billing export is live");
  });

  it("fetches by slug within a project", async () => {
    const { saveDoc, getDoc } = await import("../src/db/docs.js");
    saveDoc({ project: "cogs", title: "Usage Inventory", content: "body one" });
    const byId = getDoc("usage-inventory", "cogs");
    expect(byId?.content).toBe("body one");
    expect(getDoc("usage-inventory", "other")).toBeUndefined();
  });

  it("updates in place on an existing slug, bumps version, keeps prior body", async () => {
    const { saveDoc, getDoc } = await import("../src/db/docs.js");
    const { docsDir } = await import("../src/config.js");
    const first = saveDoc({ project: "cogs", title: "Map", content: "v1 body" });
    expect(first.created).toBe(true);

    const second = saveDoc({ project: "cogs", title: "Map", content: "v2 body" });
    expect(second.created).toBe(false);
    expect(second.doc.id).toBe(first.doc.id); // same row, updated in place
    expect(second.doc.version).toBe(2);
    expect(second.doc.updated_at >= first.doc.updated_at).toBe(true);

    // current body is the new one; the prior body is frozen under _versions/
    expect(getDoc(first.doc.id)!.content).toBe("v2 body");
    const priorAbs = path.join(docsDir(), "cogs", "_versions", "map.v1.md");
    // the sidecar keeps the v1 body (with its era's frontmatter prepended)
    expect(fs.readFileSync(priorAbs, "utf8")).toContain("v1 body");
    // and no stale sidecar is left loose in the main project folder
    expect(fs.existsSync(path.join(docsDir(), "cogs", "map.v1.md"))).toBe(false);
  });

  it("writes attachments as sidecar files and records their paths", async () => {
    const { saveDoc } = await import("../src/db/docs.js");
    const { docsDir } = await import("../src/config.js");
    const { doc } = saveDoc({
      project: "cogs",
      title: "Workload Map",
      content: "see the csv",
      attachments: [{ filename: "workload-map.csv", content: "a,b\n1,2\n" }],
    });
    const rels = JSON.parse(doc.attachments!) as string[];
    expect(rels).toContain("cogs/workload-map.csv");
    expect(fs.readFileSync(path.join(docsDir(), rels[0]), "utf8")).toBe("a,b\n1,2\n");
  });

  it("reads an attachment back by filename, scoped to the doc", async () => {
    const { saveDoc, getDocAttachment } = await import("../src/db/docs.js");
    const { doc } = saveDoc({
      project: "cogs",
      title: "Workload Map",
      content: "see the csv",
      attachments: [{ filename: "workload-map.csv", content: "a,b\n1,2\n" }],
    });
    const att = getDocAttachment(doc.id, "workload-map.csv");
    expect(att?.filename).toBe("workload-map.csv");
    expect(att?.content.toString("utf8")).toBe("a,b\n1,2\n");
    // a filename not in the doc's attachment list is not served
    expect(getDocAttachment(doc.id, "other.csv")).toBeUndefined();
  });

  it("refuses to serve a file outside the doc's recorded attachments (traversal)", async () => {
    const { saveDoc, getDocAttachment } = await import("../src/db/docs.js");
    const { doc } = saveDoc({
      project: "cogs",
      title: "Workload Map",
      content: "x",
      attachments: [{ filename: "workload-map.csv", content: "safe\n" }],
    });
    // even a basename that matches nothing, or a traversal attempt, returns undefined
    expect(getDocAttachment(doc.id, "../../../etc/passwd")).toBeUndefined();
    expect(getDocAttachment(doc.id, "workload-map.csv")?.content.toString()).toBe("safe\n");
  });

  it("slugifies project and slug so paths cannot traverse out of docsDir", async () => {
    const { saveDoc } = await import("../src/db/docs.js");
    const { doc } = saveDoc({
      project: "../etc",
      title: "../../secret name!!",
      content: "x",
    });
    expect(doc.project).toBe("etc");
    expect(doc.slug).toBe("secret-name");
    expect(doc.file_path).toBe("etc/secret-name.md");
  });

  it("lists docs by project and by tag", async () => {
    const { saveDoc, listDocs } = await import("../src/db/docs.js");
    saveDoc({ project: "cogs", title: "A", content: "x", tags: "billing,gcp" });
    saveDoc({ project: "cogs", title: "B", content: "y", tags: "usage" });
    saveDoc({ project: "infra", title: "C", content: "z", tags: "billing" });

    expect(listDocs({ project: "cogs" }).length).toBe(2);
    expect(listDocs({ tag: "billing" }).map((d) => d.title).sort()).toEqual(["A", "C"]);
    expect(listDocs().length).toBe(3);
  });
});

describe("docs frontmatter, index, and migration", () => {
  it("writes YAML frontmatter to disk derived from the stored metadata", async () => {
    const { saveDoc } = await import("../src/db/docs.js");
    const { docsDir } = await import("../src/config.js");
    const { doc } = saveDoc({
      project: "cogs",
      title: "Cost: Data Inventory", // colon forces YAML quoting
      content: "# Inventory\n\nbilling export is live.",
      tags: "billing, gcp",
      summary: "one line summary",
    });
    const file = fs.readFileSync(path.join(docsDir(), doc.file_path), "utf8");
    expect(file.startsWith("---\n")).toBe(true);
    expect(file).toContain('title: "Cost: Data Inventory"');
    expect(file).toContain("project: cogs");
    expect(file).toContain("slug: cost-data-inventory");
    expect(file).toContain("- billing");
    expect(file).toContain("- gcp");
    expect(file).toContain("summary: one line summary");
    expect(file).toContain(`version: ${doc.version}`);
    // the body follows the closing delimiter, untouched
    expect(file).toContain("# Inventory\n\nbilling export is live.");
  });

  it("get_doc returns the body WITHOUT the frontmatter duplicated in", async () => {
    const { saveDoc, getDoc } = await import("../src/db/docs.js");
    const body = "# Body\n\nsome prose here.";
    const { doc } = saveDoc({ project: "cogs", title: "T", content: body, tags: "x" });
    const fetched = getDoc(doc.id)!;
    expect(fetched.content).toBe(body);
    expect(fetched.content).not.toContain("title:");
    expect(fetched.content).not.toContain("---");
    // metadata still arrives via the structured columns
    expect(fetched.tags).toBe("x");
  });

  it("indexes only the body in FTS, never the emitted frontmatter", async () => {
    const { saveDoc, searchDocs } = await import("../src/db/docs.js");
    // body has none of the frontmatter key words; the file on disk does
    saveDoc({ project: "cogs", title: "Fox", content: "the quick brown fox" });
    expect(searchDocs("quick").length).toBe(1);
    // "version"/"slug"/"project" appear only as frontmatter keys on disk — if
    // the whole file (not just the body) were indexed, these would match
    expect(searchDocs("version").length).toBe(0);
    expect(searchDocs("slug").length).toBe(0);
  });

  it("regenerates a per-project _index.md, newest first", async () => {
    const { saveDoc } = await import("../src/db/docs.js");
    const { docsDir } = await import("../src/config.js");
    saveDoc({ project: "cogs", title: "First", content: "x", summary: "first summary" });
    saveDoc({ project: "cogs", title: "Second", content: "y", summary: "second summary" });
    const idx = fs.readFileSync(path.join(docsDir(), "cogs", "_index.md"), "utf8");
    expect(idx.startsWith("---\n")).toBe(true);
    expect(idx).toContain("kind: index");
    expect(idx).toContain("[First](first.md) — first summary");
    expect(idx).toContain("[Second](second.md) — second summary");
    // newest (Second) is listed before First
    expect(idx.indexOf("Second")).toBeLessThan(idx.indexOf("First"));
  });

  it("migration adds frontmatter, relocates legacy sidecars, and is idempotent", async () => {
    const { saveDoc, migrateDocsToFrontmatter, getDoc } = await import("../src/db/docs.js");
    const { docsDir } = await import("../src/config.js");
    const first = saveDoc({ project: "cogs", title: "Doc", content: "v1 body" });
    saveDoc({ project: "cogs", title: "Doc", content: "v2 body" }); // freezes v1

    // Degrade to a legacy layout: strip the frontmatter from the main file and
    // move the version sidecar back up to the top level.
    const mainAbs = path.join(docsDir(), "cogs", "doc.md");
    fs.writeFileSync(mainAbs, "v2 body");
    const relocated = path.join(docsDir(), "cogs", "_versions", "doc.v1.md");
    const legacy = path.join(docsDir(), "cogs", "doc.v1.md");
    fs.renameSync(relocated, legacy);

    const r1 = migrateDocsToFrontmatter();
    expect(r1.updated).toBe(1);
    expect(r1.relocated).toBe(1);
    expect(r1.indexed).toBe(1);

    const migrated = fs.readFileSync(mainAbs, "utf8");
    expect(migrated.startsWith("---\n")).toBe(true);
    expect(migrated).toContain("v2 body");
    // sidecar is back under _versions/, gone from the top level
    expect(fs.existsSync(relocated)).toBe(true);
    expect(fs.existsSync(legacy)).toBe(false);
    // updated_at / version untouched by the migration
    expect(getDoc(first.doc.id)!.version).toBe(2);

    // a second run is a no-op
    const r2 = migrateDocsToFrontmatter();
    expect(r2.updated).toBe(0);
    expect(r2.relocated).toBe(0);
  });
});

describe("docs FTS search", () => {
  it("ranks title/tag matches over body matches", async () => {
    const { saveDoc, searchDocs } = await import("../src/db/docs.js");
    saveDoc({
      project: "cogs",
      title: "GKE cost allocation labels",
      content: "some unrelated prose about clusters",
    });
    saveDoc({
      project: "cogs",
      title: "Notetaker usage",
      content: "mentions gke cost allocation once in passing",
    });
    const hits = searchDocs("gke cost allocation");
    expect(hits.length).toBe(2);
    expect(hits[0].title).toBe("GKE cost allocation labels");
  });

  it("searches the body text", async () => {
    const { saveDoc, searchDocs } = await import("../src/db/docs.js");
    saveDoc({ project: "cogs", title: "Inventory", content: "spanner_uas_grants table" });
    expect(searchDocs("spanner grants").length).toBe(1);
  });

  it("can scope search to a project", async () => {
    const { saveDoc, searchDocs } = await import("../src/db/docs.js");
    saveDoc({ project: "cogs", title: "billing export doc", content: "x" });
    saveDoc({ project: "infra", title: "billing export doc", content: "y" });
    expect(searchDocs("billing export").length).toBe(2);
    expect(searchDocs("billing export", 10, "cogs").length).toBe(1);
    expect(searchDocs("billing export", 10, "cogs")[0].project).toBe("cogs");
  });

  it("survives natural-language queries with FTS syntax characters", async () => {
    const { saveDoc, searchDocs } = await import("../src/db/docs.js");
    saveDoc({ project: "cogs", title: "worktree cleanup", content: "needs --force" });
    expect(() =>
      searchDocs(`what's "cost" (allocation) --force project:cogs?`),
    ).not.toThrow();
  });

  it("keeps the FTS index in sync on update and delete", async () => {
    const { saveDoc, searchDocs, deleteDoc } = await import("../src/db/docs.js");
    const { doc } = saveDoc({ project: "cogs", title: "Doc", content: "alpha keyword" });
    expect(searchDocs("alpha").length).toBe(1);
    // updating replaces the indexed body — old term gone, new term found
    saveDoc({ project: "cogs", title: "Doc", content: "beta keyword" });
    expect(searchDocs("alpha").length).toBe(0);
    expect(searchDocs("beta").length).toBe(1);
    // deleting removes it from the index entirely
    expect(deleteDoc(doc.id)).toBe(true);
    expect(searchDocs("beta").length).toBe(0);
  });
});

describe("docs HTTP API", () => {
  async function app() {
    const { buildApp } = await import("../src/daemon/api.js");
    return buildApp();
  }

  it("POST creates a doc (201) then updates it in place (200)", async () => {
    const a = await app();
    const create = await a.request("/api/docs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "cogs", title: "T", content: "one" }),
    });
    expect(create.status).toBe(201);
    const doc = (await create.json()) as { id: number; version: number };
    expect(doc.version).toBe(1);

    const update = await a.request("/api/docs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "cogs", title: "T", content: "two" }),
    });
    expect(update.status).toBe(200);
    expect(((await update.json()) as { version: number }).version).toBe(2);
  });

  it("GET lists, searches, and fetches one doc by id and slug", async () => {
    const a = await app();
    await a.request("/api/docs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "cogs",
        title: "Billing Export",
        content: "gcp billing export lives in costs-reporting",
      }),
    });

    const list = (await (await a.request("/api/docs?project=cogs")).json()) as unknown[];
    expect(list.length).toBe(1);

    const search = (await (
      await a.request("/api/docs?q=billing%20export")
    ).json()) as { slug: string }[];
    expect(search[0].slug).toBe("billing-export");

    const byId = (await (await a.request("/api/docs/1")).json()) as {
      content: string;
    };
    expect(byId.content).toContain("costs-reporting");

    const bySlug = (await (
      await a.request("/api/docs/billing-export?project=cogs")
    ).json()) as { content: string };
    expect(bySlug.content).toContain("costs-reporting");

    expect((await a.request("/api/docs/does-not-exist")).status).toBe(404);
  });

  it("GET serves a doc's attachment as a download and 404s unknown names", async () => {
    const a = await app();
    await a.request("/api/docs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "cogs",
        title: "Workload Map",
        content: "see the csv",
        attachments: [{ filename: "workload-map.csv", content: "a,b\n1,2\n" }],
      }),
    });
    const ok = await a.request("/api/docs/1/attachments/workload-map.csv");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-disposition")).toContain("workload-map.csv");
    expect(await ok.text()).toBe("a,b\n1,2\n");

    expect((await a.request("/api/docs/1/attachments/missing.csv")).status).toBe(404);
  });

  it("logs a doc.saved event", async () => {
    const a = await app();
    await a.request("/api/docs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "cogs", title: "T", content: "x" }),
    });
    const { listEvents } = await import("../src/db/events.js");
    expect(listEvents(10).map((e) => e.kind)).toContain("doc.saved");
  });
});

describe("doc-store prompt guidance", () => {
  it("tells workers to save research findings to the doc store, not the repo", async () => {
    const { _buildWorkerPromptForTest } = await import("../src/daemon/spawn.js");
    const { createTask } = await import("../src/db/tasks.js");
    const task = createTask({ title: "investigate X", prompt: "research it", repo: "/r" });
    const prompt = _buildWorkerPromptForTest(task, "agent/task-1");
    expect(prompt).toContain("save_doc");
    expect(prompt).toMatch(/NOT committed to the repo|not committed/i);
  });

  it("tells reviewers they can read saved docs via get_doc/list_docs", async () => {
    const { buildReviewerPrompt } = await import("../src/prompts/reviewer.js");
    const { createTask } = await import("../src/db/tasks.js");
    const task = createTask({ title: "t", prompt: "p", repo: "/r" });
    const prompt = buildReviewerPrompt(task);
    expect(prompt).toContain("list_docs");
    expect(prompt).toContain("get_doc");
  });
});
