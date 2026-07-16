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
  it("accepts a valid agent patch and round-trips via GET", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const app = buildApp();
    const res = await app.request("/api/settings/agents", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ default_main_model: "opus", reviewer_variety: true }),
    });
    expect(res.status).toBe(200);

    const get = await (await app.request("/api/settings")).json();
    expect(get.agents.stored.default_main_model).toBe("opus");
    expect(get.agents.effective.default_main_model).toBe("opus");
    expect(get.agents.stored.reviewer_variety).toBe(true);
  });

  it("rejects a model outside the allow-list", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const res = await buildApp().request("/api/settings/agents", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ default_main_model: "gpt-4" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid provider", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const res = await buildApp().request("/api/settings/agents", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ default_worker_provider: "gemini" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a relative workspace path", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const res = await buildApp().request("/api/settings/workspace", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worktrees_dir: "relative/path" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an absolute path that does not exist", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const res = await buildApp().request("/api/settings/workspace", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ main_workspace_dir: path.join(tmpDir, "nope") }),
    });
    expect(res.status).toBe(400);
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

  it("rejects a non-http ntfy URL", async () => {
    const { buildApp } = await import("../src/daemon/api.js");
    const res = await buildApp().request("/api/settings/notifications", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ntfy_url: "ftp://bad" }),
    });
    expect(res.status).toBe(400);
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
