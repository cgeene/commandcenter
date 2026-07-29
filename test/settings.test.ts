import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let tmpDir: string;

// Env vars the settings resolvers fall back to — snapshot and restore so a
// test that sets one can't leak into the next.
const ENV_KEYS = [
  "CC_MAIN_MODEL",
  "CC_WORKER_PROVIDER",
  "CC_REVIEWER_PROVIDER",
  "CC_REVIEWER_VARIETY",
  "CC_NTFY_URL",
  "CC_NTFY_TOKEN",
  "CC_JIRA_TOKEN",
  "CC_JIRA_EMAIL",
  "CC_JIRA_BASE_URL",
] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-settings-")));
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

describe("settings store round-trip", () => {
  it("persists and merges partial patches per group", async () => {
    const settings = await import("../src/db/settings.js");

    // Unset → all overrides null.
    expect(settings.getAgentSettings()).toEqual({
      default_main_model: null,
      default_worker_provider: null,
      default_reviewer_provider: null,
      reviewer_variety: null,
      worker_publication_mode: null,
    });

    settings.setAgentSettings({ default_main_model: "opus" });
    settings.setAgentSettings({ reviewer_variety: true });
    // Second patch must merge, not clobber the first.
    expect(settings.getAgentSettings()).toMatchObject({
      default_main_model: "opus",
      reviewer_variety: true,
    });

    settings.setWorkspaceSettings({ worktrees_dir: "/tmp/wt" });
    expect(settings.getWorkspaceSettings().worktrees_dir).toBe("/tmp/wt");

    settings.setNotificationSettings({ ntfy_url: "https://ntfy.sh/x" });
    expect(settings.getNotificationSettings().ntfy_url).toBe("https://ntfy.sh/x");
  });
});

describe("per-event notification toggles", () => {
  it("defaults to the catalog, overrides per event, and clears with null", async () => {
    const settings = await import("../src/db/settings.js");
    const { NOTIFY_EVENT_DEFAULTS } = await import("../src/notify-events.js");

    // Unset → no stored overrides, everything follows the built-in default.
    expect(settings.getNotificationSettings().events).toEqual({});
    expect(settings.resolveNotifyEvents()).toEqual(NOTIFY_EVENT_DEFAULTS);
    expect(settings.resolveNotifyEventEnabled("review_approved_ready")).toBe(true);
    expect(settings.resolveNotifyEventEnabled("task_review_entered")).toBe(false);

    settings.setNotificationSettings({ events: { task_review_entered: true } });
    expect(settings.resolveNotifyEventEnabled("task_review_entered")).toBe(true);

    // A second patch merges key-wise instead of replacing the whole map...
    settings.setNotificationSettings({ events: { escalation: false } });
    expect(settings.resolveNotifyEventEnabled("task_review_entered")).toBe(true);
    expect(settings.resolveNotifyEventEnabled("escalation")).toBe(false);
    // ...and does not disturb the sibling fields in the group.
    settings.setNotificationSettings({ ntfy_url: "https://ntfy.sh/x" });
    expect(settings.getNotificationSettings().ntfy_url).toBe("https://ntfy.sh/x");
    expect(settings.resolveNotifyEventEnabled("escalation")).toBe(false);

    // null clears the override back to the built-in default.
    settings.setNotificationSettings({ events: { escalation: null } });
    expect(settings.getNotificationSettings().events).not.toHaveProperty("escalation");
    expect(settings.resolveNotifyEventEnabled("escalation")).toBe(true);
  });

  it("ignores a stored key that is no longer in the catalog", async () => {
    const settings = await import("../src/db/settings.js");
    settings.setNotificationSettings({
      // Simulate a settings blob written by an older release.
      events: { retired_event: true } as never,
    });
    expect(settings.getNotificationSettings().events).toEqual({});
  });

  it("round-trips through the API and rejects an unknown event key", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const app = buildApp();

    const ok = await app.request("/api/settings/notifications", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: { task_completed: true, escalation: null } }),
    });
    expect(ok.status).toBe(200);

    const get = await (await app.request("/api/settings")).json();
    expect(get.notifications.stored.events).toEqual({ task_completed: true });
    expect(get.notifications.effective.events.task_completed).toBe(true);
    expect(get.notifications.effective.events.escalation).toBe(true);
    expect(get.notifications.effective.events.task_review_entered).toBe(false);
    // The catalog ships with the settings so the UI can render + label it.
    expect(
      get.notify_event_choices.find(
        (e: { key: string }) => e.key === "review_approved_ready",
      ),
    ).toMatchObject({ category: "action", default_enabled: true });

    const bad = await app.request("/api/settings/notifications", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: { not_an_event: true } }),
    });
    expect(bad.status).toBe(400);
  });
});

describe("env-fallback precedence (setting > env > default)", () => {
  it("resolveMainModel prefers DB, then env, then the fable default", async () => {
    const settings = await import("../src/db/settings.js");

    // No DB, no env → hardcoded default.
    expect(settings.resolveMainModel()).toBe("fable");

    // Env overrides the default.
    process.env.CC_MAIN_MODEL = "sonnet";
    expect(settings.resolveMainModel()).toBe("sonnet");

    // DB override wins over env.
    settings.setAgentSettings({ default_main_model: "opus" });
    expect(settings.resolveMainModel()).toBe("opus");
  });

  it("resolveWorkerProvider prefers DB, then env, then claude", async () => {
    const settings = await import("../src/db/settings.js");
    expect(settings.resolveWorkerProvider()).toBe("claude");
    process.env.CC_WORKER_PROVIDER = "codex";
    expect(settings.resolveWorkerProvider()).toBe("codex");
    settings.setAgentSettings({ default_worker_provider: "claude" });
    expect(settings.resolveWorkerProvider()).toBe("claude");
  });

  it("resolveReviewerVariety prefers DB, then env, then false", async () => {
    const settings = await import("../src/db/settings.js");
    expect(settings.resolveReviewerVariety()).toBe(false);
    process.env.CC_REVIEWER_VARIETY = "true";
    expect(settings.resolveReviewerVariety()).toBe(true);
    // An explicit false override must beat a truthy env var.
    settings.setAgentSettings({ reviewer_variety: false });
    expect(settings.resolveReviewerVariety()).toBe(false);
  });

  it("resolveMainWorkspaceDir defaults to $HOME and can be overridden", async () => {
    const settings = await import("../src/db/settings.js");
    expect(settings.resolveMainWorkspaceDir()).toBe(os.homedir());
    settings.setWorkspaceSettings({ main_workspace_dir: tmpDir });
    expect(settings.resolveMainWorkspaceDir()).toBe(tmpDir);
  });

  it("resolveNtfy* prefer DB, then env", async () => {
    const settings = await import("../src/db/settings.js");
    expect(settings.resolveNtfyUrl()).toBeUndefined();
    expect(settings.resolveNtfyToken()).toBeUndefined();
    process.env.CC_NTFY_URL = "https://ntfy.sh/env";
    process.env.CC_NTFY_TOKEN = "env-token";
    expect(settings.resolveNtfyUrl()).toBe("https://ntfy.sh/env");
    expect(settings.resolveNtfyToken()).toBe("env-token");
    settings.setNotificationSettings({ ntfy_url: "https://ntfy.sh/db", ntfy_token: "db-token" });
    expect(settings.resolveNtfyUrl()).toBe("https://ntfy.sh/db");
    expect(settings.resolveNtfyToken()).toBe("db-token");
  });
});

describe("settings API validation", () => {
  // Every settings PATCH rejection, one row each. These were ten tests spread
  // across two describes, all the same three lines with a different bad literal:
  // the validator is one shared code path and what matters is that each field's
  // rule is enforced at the boundary rather than written through to the store.
  it("rejects an invalid value on every settings group", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const app = buildApp();
    for (const { why, group, body } of [
      { why: "a model outside the allow-list", group: "agents", body: { default_main_model: "gpt-4" } },
      { why: "an invalid worker provider", group: "agents", body: { default_worker_provider: "gemini" } },
      { why: "an invalid publication mode", group: "agents", body: { worker_publication_mode: "automatic" } },
      { why: "a relative workspace path", group: "workspace", body: { worktrees_dir: "relative/path" } },
      { why: "an absolute path that does not exist", group: "workspace", body: { main_workspace_dir: path.join(tmpDir, "nope") } },
      { why: "a non-http ntfy URL", group: "notifications", body: { ntfy_url: "ftp://bad" } },
      { why: "a project key violating ^[A-Z][A-Z0-9]+$", group: "jira", body: { repos: { "acme/api": { enabled: true, project: "en-lower" } } } },
      { why: "a classifier model outside the allow-list", group: "jira", body: { classifier_model: "gpt-4" } },
      { why: "a repo key that is neither an existing path nor owner/name", group: "jira", body: { repos: { "not a repo key": { enabled: true, project: "EN" } } } },
      { why: "a relative path repo key that does not exist", group: "jira", body: { repos: { [path.join(tmpDir, "nope")]: { enabled: true, project: "EN" } } } },
    ]) {
      const res = await app.request(`/api/settings/${group}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status, `${group}: ${why}`).toBe(400);
    }
  });

  it("accepts a valid agent patch and round-trips via GET", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const app = buildApp();
    const res = await app.request("/api/settings/agents", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        default_main_model: "opus",
        reviewer_variety: true,
        worker_publication_mode: "human",
      }),
    });
    expect(res.status).toBe(200);

    const get = await (await app.request("/api/settings")).json();
    expect(get.agents.stored.default_main_model).toBe("opus");
    expect(get.agents.effective.default_main_model).toBe("opus");
    expect(get.agents.stored.reviewer_variety).toBe(true);
    expect(get.agents.stored.worker_publication_mode).toBe("human");
    expect(get.agents.effective.worker_publication_mode).toBe("human");
  });

  it("accepts an existing absolute directory and clears with null", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const app = buildApp();
    const set = await app.request("/api/settings/workspace", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ main_workspace_dir: tmpDir }),
    });
    expect(set.status).toBe(200);
    let get = await (await app.request("/api/settings")).json();
    expect(get.workspace.stored.main_workspace_dir).toBe(tmpDir);

    // Blank clears the override back to the default ($HOME).
    await app.request("/api/settings/workspace", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ main_workspace_dir: "" }),
    });
    get = await (await app.request("/api/settings")).json();
    expect(get.workspace.stored.main_workspace_dir).toBeNull();
    expect(get.workspace.effective.main_workspace_dir).toBe(os.homedir());
  });

});

describe("JIRA settings", () => {
  it("defaults to off, empty repos, and the sonnet classifier", async () => {
    const settings = await import("../src/db/settings.js");
    expect(settings.getJiraConfig()).toEqual({
      enabled: false,
      repos: {},
      classifier_model: "sonnet",
    });
    // No enabled repos while the master switch is off.
    expect(settings.jiraEnabledRepos()).toEqual([]);
  });

  it("round-trips a config and derives jiraEnabledRepos from the toggles", async () => {
    const settings = await import("../src/db/settings.js");
    settings.setJiraConfig({
      enabled: true,
      repos: {
        "owner/on": { enabled: true, project: "EN" },
        "owner/off": { enabled: false, project: "UN" },
      },
    });
    // A second partial patch must merge at the top level, not clobber repos.
    settings.setJiraConfig({ default_assignee_account_id: "acct-123" });
    const cfg = settings.getJiraConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.default_assignee_account_id).toBe("acct-123");
    expect(Object.keys(cfg.repos)).toHaveLength(2);
    // Only the enabled repo is a create candidate.
    expect(settings.jiraEnabledRepos()).toEqual(["owner/on"]);
  });

  it("returns no enabled repos once the master switch is off", async () => {
    const settings = await import("../src/db/settings.js");
    settings.setJiraConfig({
      enabled: false,
      repos: { "owner/on": { enabled: true, project: "EN" } },
    });
    expect(settings.jiraEnabledRepos()).toEqual([]);
  });

  it("GET exposes token presence, never the token value", async () => {
    const SECRET = "jira_tok_super_secret_9999";
    process.env.CC_JIRA_TOKEN = SECRET;
    process.env.CC_JIRA_EMAIL = "owner@example.com";
    const { buildApp } = await import("../src/daemon/api.js");
    const res = await buildApp().request("/api/settings");
    const body = await res.text();
    expect(body).not.toContain(SECRET);
    const parsed = JSON.parse(body);
    expect(parsed.jira.token_set).toBe(true);
    expect(parsed.jira.email).toBe("owner@example.com");
    expect(parsed.jira.stored).not.toHaveProperty("token");
    expect(parsed.jira.stored).not.toHaveProperty("ntfy_token");
  });

  it("reports token unset when CC_JIRA_TOKEN is absent", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const parsed = await (await buildApp().request("/api/settings")).json();
    expect(parsed.jira.token_set).toBe(false);
  });

  it("accepts a valid JIRA patch and round-trips via GET (default OFF per repo)", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const app = buildApp();
    const res = await app.request("/api/settings/jira", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        classifier_model: "haiku",
        default_assignee_account_id: "acct-42",
        repos: {
          "acme/api": {
            enabled: false,
            project: "EN",
            projects: ["EN", "UN"],
            issue_types: ["Task", "Story"],
            labels: ["backend"],
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    const get = await (await app.request("/api/settings")).json();
    expect(get.jira.stored.enabled).toBe(true);
    expect(get.jira.stored.classifier_model).toBe("haiku");
    expect(get.jira.stored.default_assignee_account_id).toBe("acct-42");
    // Per-repo opt-in defaults OFF even when the master switch is on.
    expect(get.jira.stored.repos["acme/api"].enabled).toBe(false);
    expect(get.jira.stored.repos["acme/api"].projects).toEqual(["EN", "UN"]);
  });

  it("accepts an absolute existing directory as a repo key", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const res = await buildApp().request("/api/settings/jira", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repos: { [tmpDir]: { enabled: true, project: "EN" } },
      }),
    });
    expect(res.status).toBe(200);
  });

  it("clears default_assignee_account_id when sent null", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const app = buildApp();
    await app.request("/api/settings/jira", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ default_assignee_account_id: "acct-99" }),
    });
    await app.request("/api/settings/jira", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ default_assignee_account_id: null }),
    });
    const settings = await import("../src/db/settings.js");
    expect(settings.getJiraConfig().default_assignee_account_id).toBeUndefined();
  });
});

describe("ntfy token never leaks", () => {
  it("stores the token but never returns it in GET or PATCH responses", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const app = buildApp();
    const SECRET = "tk_super_secret_value_123";

    const patch = await app.request("/api/settings/notifications", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ntfy_url: "https://ntfy.sh/topic", ntfy_token: SECRET }),
    });
    expect(patch.status).toBe(200);
    const patchBody = await patch.text();
    expect(patchBody).not.toContain(SECRET);
    expect(JSON.parse(patchBody).notifications.ntfy_token_set).toBe(true);

    const getRes = await app.request("/api/settings");
    const getBody = await getRes.text();
    expect(getBody).not.toContain(SECRET);
    const parsed = JSON.parse(getBody);
    expect(parsed.notifications.ntfy_token_set).toBe(true);
    expect(parsed.notifications.stored).not.toHaveProperty("ntfy_token");

    // The secret is genuinely persisted — the resolver (server-side) sees it.
    const settings = await import("../src/db/settings.js");
    expect(settings.resolveNtfyToken()).toBe(SECRET);
  });

  it("does not log the token value in the settings.config event", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const { listEvents } = await import("../src/db/events.js");
    const SECRET = "tk_do_not_log_me";
    await buildApp().request("/api/settings/notifications", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ntfy_token: SECRET }),
    });
    const events = listEvents().filter((e) => e.kind === "settings.config");
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.payload ?? "").not.toContain(SECRET);
    }
  });
});

describe("the effective ntfy URL never leaves the daemon", () => {
  // A topic URL is publish capability: anything that can read it can page the
  // operator. Only its presence may cross the boundary.
  const ENV_URL = "https://ntfy.example/env-only-secret-topic";

  it("GET reports presence, never the resolved URL", async () => {
    process.env.CC_NTFY_URL = ENV_URL;
    const { buildApp } = await import("../src/daemon/api.js");
    const body = await (await buildApp().request("/api/settings")).text();

    expect(body).not.toContain(ENV_URL);
    const parsed = JSON.parse(body);
    expect(parsed.notifications.effective.ntfy_url_set).toBe(true);
    expect(parsed.notifications.effective).not.toHaveProperty("ntfy_url");
    // No stored override, so the editable field is correctly empty.
    expect(parsed.notifications.stored.ntfy_url).toBeNull();
  });

  it("PATCH echoes presence only, and the stored override stays readable", async () => {
    process.env.CC_NTFY_URL = ENV_URL;
    const { buildApp } = await import("../src/daemon/api.js");
    const STORED = "https://ntfy.example/db-topic";
    const res = await buildApp().request("/api/settings/notifications", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ntfy_url: STORED }),
    });
    expect(res.status).toBe(200);
    const body = await res.text();

    expect(body).not.toContain(ENV_URL);
    const parsed = JSON.parse(body);
    expect(parsed.notifications.effective.ntfy_url_set).toBe(true);
    expect(parsed.notifications.effective).not.toHaveProperty("ntfy_url");
    expect(parsed.notifications.stored.ntfy_url).toBe(STORED);
  });

  it("reports no URL configured when neither the DB nor the env has one", async () => {
    delete process.env.CC_NTFY_URL;
    const { buildApp } = await import("../src/daemon/api.js");
    const parsed = await (await buildApp().request("/api/settings")).json();
    expect(parsed.notifications.effective.ntfy_url_set).toBe(false);
  });
});
