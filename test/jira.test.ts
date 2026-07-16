import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let tmpDir: string;

// JIRA secrets are env-only; snapshot/restore so a test can't leak into the next.
const ENV_KEYS = ["CC_JIRA_BASE_URL", "CC_JIRA_EMAIL", "CC_JIRA_TOKEN"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-jira-")));
  process.env.CC_DATA_DIR = path.join(tmpDir, "data");
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("tasksNeedingJiraSync", () => {
  it("includes a ticketed task whose status has never been synced (NULL-check regression)", async () => {
    const { createTask, updateTask, tasksNeedingJiraSync } = await import(
      "../src/db/tasks.js"
    );
    const t = createTask({ title: "t", prompt: "x", repo: "/r" });
    // jira_key set, jira_state + jira_status_category still NULL — the
    // NULL NOT IN (...) / NULL != ... trap. Must still be a candidate.
    updateTask(t.id, { jira_key: "EN-1" });
    expect(tasksNeedingJiraSync().map((x) => x.id)).toEqual([t.id]);
  });

  it("excludes tasks with no ticket yet (jira_key IS NULL)", async () => {
    const { createTask, tasksNeedingJiraSync } = await import("../src/db/tasks.js");
    createTask({ title: "no ticket", prompt: "x", repo: "/r" });
    expect(tasksNeedingJiraSync()).toEqual([]);
  });

  it("drops terminal states out of the poll set (done, will not do, done-category)", async () => {
    const { createTask, updateTask, tasksNeedingJiraSync } = await import(
      "../src/db/tasks.js"
    );
    const active = createTask({ title: "active", prompt: "x", repo: "/r" });
    updateTask(active.id, { jira_key: "EN-10", jira_state: "in progress", jira_status_category: "indeterminate" });

    const done = createTask({ title: "done", prompt: "x", repo: "/r" });
    updateTask(done.id, { jira_key: "EN-11", jira_state: "done", jira_status_category: "done" });

    const wontDo = createTask({ title: "wont", prompt: "x", repo: "/r" });
    updateTask(wontDo.id, { jira_key: "EN-12", jira_state: "will not do", jira_status_category: "done" });

    // A custom terminal status name we don't hardcode, caught by the category.
    const categoryDone = createTask({ title: "cat", prompt: "x", repo: "/r" });
    updateTask(categoryDone.id, {
      jira_key: "EN-13",
      jira_state: "shipped",
      jira_status_category: "done",
    });

    expect(tasksNeedingJiraSync().map((x) => x.id)).toEqual([active.id]);
  });
});

describe("tasksNeedingJiraCreate", () => {
  async function seed() {
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    return { createTask, updateTask };
  }

  it("selects a PR-bearing, ticketless task in an enabled repo", async () => {
    const { createTask, updateTask } = await seed();
    const t = createTask({ title: "t", prompt: "x", repo: "/enabled" });
    updateTask(t.id, { pr_url: "https://gh/pr/1" });
    const { tasksNeedingJiraCreate } = await import("../src/db/tasks.js");
    expect(tasksNeedingJiraCreate(["/enabled"]).map((x) => x.id)).toEqual([t.id]);
  });

  it("excludes doc-only tasks via the open_pr != 0 gate", async () => {
    const { createTask, updateTask } = await seed();
    const t = createTask({ title: "doc", prompt: "x", repo: "/enabled", open_pr: false });
    // Even with a pr_url present, open_pr = 0 structurally excludes it.
    updateTask(t.id, { pr_url: "https://gh/pr/2" });
    const { tasksNeedingJiraCreate } = await import("../src/db/tasks.js");
    expect(tasksNeedingJiraCreate(["/enabled"])).toEqual([]);
  });

  it("excludes tasks with no pr_url", async () => {
    const { createTask } = await seed();
    createTask({ title: "nopr", prompt: "x", repo: "/enabled" });
    const { tasksNeedingJiraCreate } = await import("../src/db/tasks.js");
    expect(tasksNeedingJiraCreate(["/enabled"])).toEqual([]);
  });

  it("excludes tasks that already have a ticket (jira_key idempotency guard)", async () => {
    const { createTask, updateTask } = await seed();
    const t = createTask({ title: "has key", prompt: "x", repo: "/enabled" });
    updateTask(t.id, { pr_url: "https://gh/pr/3", jira_key: "EN-99" });
    const { tasksNeedingJiraCreate } = await import("../src/db/tasks.js");
    expect(tasksNeedingJiraCreate(["/enabled"])).toEqual([]);
  });

  it("excludes cancelled and failed tasks", async () => {
    const { createTask, updateTask } = await seed();
    const cancelled = createTask({ title: "c", prompt: "x", repo: "/enabled" });
    updateTask(cancelled.id, { pr_url: "https://gh/pr/4", status: "cancelled" });
    const failed = createTask({ title: "f", prompt: "x", repo: "/enabled" });
    updateTask(failed.id, { pr_url: "https://gh/pr/5", status: "failed" });
    const { tasksNeedingJiraCreate } = await import("../src/db/tasks.js");
    expect(tasksNeedingJiraCreate(["/enabled"])).toEqual([]);
  });

  it("excludes tasks whose repo is not in the enabled list", async () => {
    const { createTask, updateTask } = await seed();
    const t = createTask({ title: "t", prompt: "x", repo: "/disabled" });
    updateTask(t.id, { pr_url: "https://gh/pr/6" });
    const { tasksNeedingJiraCreate } = await import("../src/db/tasks.js");
    expect(tasksNeedingJiraCreate(["/enabled"])).toEqual([]);
    // ...but included once its repo is enabled.
    expect(tasksNeedingJiraCreate(["/enabled", "/disabled"]).map((x) => x.id)).toEqual([t.id]);
  });

  it("returns nothing when no repos are enabled (empty gate)", async () => {
    const { createTask, updateTask } = await seed();
    const t = createTask({ title: "t", prompt: "x", repo: "/enabled" });
    updateTask(t.id, { pr_url: "https://gh/pr/7" });
    const { tasksNeedingJiraCreate } = await import("../src/db/tasks.js");
    expect(tasksNeedingJiraCreate([])).toEqual([]);
  });
});

describe("JiraConfig store", () => {
  it("defaults to disabled with an empty repo map", async () => {
    const settings = await import("../src/db/settings.js");
    expect(settings.getJiraConfig()).toEqual({
      enabled: false,
      repos: {},
      classifier_model: "sonnet",
    });
  });

  it("round-trips and merges stored-over-defaults so old configs gain new fields", async () => {
    const settings = await import("../src/db/settings.js");
    // Simulate an older stored config that predates classifier_model.
    settings.setJiraConfig({
      enabled: true,
      repos: { "/enabled": { enabled: true, project: "EN" } },
    });
    const cfg = settings.getJiraConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.repos["/enabled"]).toEqual({ enabled: true, project: "EN" });
    // The new field is filled from defaults on read.
    expect(cfg.classifier_model).toBe("sonnet");
  });

  it("jiraEnabledRepos reflects the master switch and per-repo opt-in", async () => {
    const settings = await import("../src/db/settings.js");
    // Master off → no enabled repos even if a repo is marked enabled.
    settings.setJiraConfig({
      enabled: false,
      repos: { "/a": { enabled: true, project: "EN" } },
    });
    expect(settings.jiraEnabledRepos()).toEqual([]);

    settings.setJiraConfig({
      enabled: true,
      repos: {
        "/a": { enabled: true, project: "EN" },
        "/b": { enabled: false, project: "UN" },
      },
    });
    expect(settings.jiraEnabledRepos()).toEqual(["/a"]);
  });
});

describe("JIRA token never leaks", () => {
  it("is readable server-side from env but never appears in stored config, settings GET, or events", async () => {
    const SECRET = "jira_tk_super_secret_value_123";
    process.env.CC_JIRA_TOKEN = SECRET;
    process.env.CC_JIRA_EMAIL = "bot@nylas.com";

    const config = await import("../src/config.js");
    const settings = await import("../src/db/settings.js");

    // Server-side read point sees the secret.
    expect(config.jiraToken()).toBe(SECRET);

    // Storing behavior config must never absorb the token.
    settings.setJiraConfig({ enabled: true, repos: { "/r": { enabled: true, project: "EN" } } });
    expect(JSON.stringify(settings.getJiraConfig())).not.toContain(SECRET);

    // The full settings GET response never carries it.
    const { buildApp } = await import("../src/daemon/api.js");
    const getBody = await (await buildApp().request("/api/settings")).text();
    expect(getBody).not.toContain(SECRET);

    // No event payload carries it.
    const { listEvents } = await import("../src/db/events.js");
    for (const e of listEvents()) {
      expect(e.payload ?? "").not.toContain(SECRET);
    }
  });
});
