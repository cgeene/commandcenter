import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  _parseMcpListForTest,
  _renderFlattenedMcpForTest,
  _requiredEnvironmentForTest,
  extractInheritedCodexConfig,
  mergeCodexScratchTrust,
  mergeInheritedCodexConfig,
  syncCodexMcpAccess,
} from "../src/daemon/codex-mcp.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-codex-mcp-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env.CC_CODEX_BIN;
  delete process.env.CC_CODEX_HOME;
  delete process.env.CC_CODEX_MCP_SOURCE_HOME;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Codex MCP inheritance", () => {
  it("copies only MCP/plugin tables and keeps the normal Codex state isolated", () => {
    const inherited = extractInheritedCodexConfig(
      [
        'model = "local-default"',
        "[features]",
        "apps = true",
        "[marketplaces.local]",
        'source_type = "local"',
        'source = "/plugins"',
        '[plugins."github@local"]',
        "enabled = true",
        "[mcp_servers.logs]",
        'url = "https://example.invalid/mcp"',
        'bearer_token_env_var = "LOG_TOKEN"',
        "[mcp_servers.local.env]",
        'CODEX_HOME = "/Users/me/.codex"',
        'NODE_REPL_TRUSTED_CODE_PATHS = "/Users/me/.codex"',
        'STARTUP_TIMEOUT = "30"',
        '[projects."/tmp/repo"]',
        'trust_level = "trusted"',
      ].join("\n"),
      "/isolated/codex",
    );

    expect(inherited).toContain("[mcp_servers.logs]");
    expect(inherited).toContain('STARTUP_TIMEOUT = "30"');
    expect(inherited).toContain('CODEX_HOME = "/isolated/codex"');
    expect(inherited).toContain(
      'NODE_REPL_TRUSTED_CODE_PATHS = "/isolated/codex"',
    );
    expect(inherited).not.toContain('model = "local-default"');
    expect(inherited).not.toContain("[features]");
    expect(inherited).not.toContain("[marketplaces.local]");
    expect(inherited).not.toContain('[plugins."github@local"]');
    expect(inherited).not.toContain("/Users/me/.codex");
    expect(inherited).not.toContain("[projects.");
  });

  it("rejects credential values embedded in inherited TOML", () => {
    expect(() =>
      extractInheritedCodexConfig(
        [
          "[mcp_servers.remote]",
          'url = "https://example.invalid/mcp"',
          'http_headers = { Authorization = "secret" }',
        ].join("\n"),
      ),
    ).toThrow(/static HTTP headers/);

    expect(() =>
      extractInheritedCodexConfig(
        [
          "[mcp_servers.local]",
          'command = "node"',
          "[mcp_servers.local.env]",
          'API_TOKEN = "secret"',
        ].join("\n"),
      ),
    ).toThrow(/inline sensitive field/);
  });

  it("replaces only its marked block and fails closed on foreign collisions", () => {
    const first = mergeInheritedCodexConfig(
      '[ui]\nnotifications = true\n',
      '[mcp_servers.one]\ncommand = "one"',
    );
    const second = mergeInheritedCodexConfig(
      first,
      '[mcp_servers.two]\ncommand = "two"',
    );

    expect(second).toContain("[ui]");
    expect(second).toContain("[mcp_servers.two]");
    expect(second).not.toContain("[mcp_servers.one]");
    expect(mergeInheritedCodexConfig(second, "")).toBe(
      '[ui]\nnotifications = true\n',
    );
    expect(() =>
      mergeInheritedCodexConfig(
        '[mcp_servers.manual]\ncommand = "manual"',
        '[mcp_servers.inherited]\ncommand = "inherited"',
      ),
    ).toThrow(/outside Command Center's managed block/);
  });

  it("trusts only explicit scratch projects in a separate managed block", () => {
    const first = mergeCodexScratchTrust(
      '[ui]\nnotifications = true\n',
      ["/private/scratch/task-ABC123"],
    );
    expect(first).toContain("commandcenter:scratch-trust:start");
    expect(first).toContain('[projects."/private/scratch/task-ABC123"]');
    expect(first).toContain('trust_level = "trusted"');
    expect(first).not.toContain('[projects."/private/scratch"]');
    expect(mergeCodexScratchTrust(first, [])).toBe(
      '[ui]\nnotifications = true\n',
    );
    expect(() =>
      mergeCodexScratchTrust(
        '[projects."/private/scratch/task-ABC123"]\ntrust_level = "untrusted"',
        ["/private/scratch/task-ABC123"],
      ),
    ).toThrow(/collides/);
  });

  it("validates effective server names and collects credential variable names", () => {
    const servers = _parseMcpListForTest(
      [
        "harmless warning",
        JSON.stringify([
          {
            name: "logs",
            enabled: true,
            transport: {
              bearer_token_env_var: "LOG_TOKEN",
              env_vars: ["LOG_URL", "CODEX_HOME"],
            },
          },
          {
            name: "disabled",
            enabled: false,
            transport: { bearer_token_env_var: "DISABLED_TOKEN" },
          },
        ]),
      ].join("\n"),
    );
    expect(servers.map((server) => server.name)).toEqual([
      "logs",
      "disabled",
    ]);
    expect(_requiredEnvironmentForTest(servers)).toEqual([
      "LOG_TOKEN",
      "LOG_URL",
    ]);
    expect(() =>
      _parseMcpListForTest(
        JSON.stringify([
          { name: "same", enabled: true },
          { name: "same", enabled: true },
        ]),
      ),
    ).toThrow(/duplicate server name/);
  });

  it("flattens a plugin-provided MCP without enabling the plugin", () => {
    const [server] = _parseMcpListForTest(
      JSON.stringify([
        {
          name: "plugin-tools",
          enabled: true,
          startup_timeout_sec: 10,
          tool_timeout_sec: 60,
          transport: {
            type: "stdio",
            command: "node",
            args: ["server.mjs"],
            cwd: "/source/plugin",
            env: { CODEX_HOME: "/normal/codex", MODE: "safe" },
            env_vars: ["PLUGIN_TOKEN"],
          },
        },
      ]),
    );
    const rendered = _renderFlattenedMcpForTest(server, "/isolated/codex");
    expect(rendered).toContain("[mcp_servers.plugin-tools]");
    expect(rendered).toContain('command = "node"');
    expect(rendered).toContain('env_vars = ["PLUGIN_TOKEN"]');
    expect(rendered).toContain('default_tools_approval_mode = "writes"');
    expect(rendered).toContain('CODEX_HOME = "/isolated/codex"');
    expect(rendered).not.toContain("[plugins.");
    expect(rendered).not.toContain("/normal/codex");
  });

  it("rejects duplicate markers instead of leaving inherited access behind", () => {
    expect(() =>
      mergeInheritedCodexConfig(
        [
          "# commandcenter:inherited-mcp:start",
          "[mcp_servers.one]",
          "# commandcenter:inherited-mcp:end",
          "# commandcenter:inherited-mcp:start",
          "[mcp_servers.two]",
          "# commandcenter:inherited-mcp:end",
        ].join("\n"),
        "",
      ),
    ).toThrow(/markers.*malformed/);
  });

  it("syncs an isolated config and plugin cache without sharing other state", () => {
    const root = tempDir();
    const sourceHome = path.join(root, "source");
    const targetHome = path.join(root, "target");
    fs.mkdirSync(sourceHome, { recursive: true });
    fs.writeFileSync(
      path.join(sourceHome, "config.toml"),
      [
        'model = "must-not-leak"',
        "[marketplaces.local]",
        'source_type = "local"',
        'source = "/plugins"',
        "[mcp_servers.logs]",
        'url = "https://example.invalid/mcp"',
        'bearer_token_env_var = "LOG_TOKEN"',
      ].join("\n"),
    );
    const fakeCodex = path.join(root, "codex");
    fs.writeFileSync(
      fakeCodex,
      [
        "#!/bin/sh",
        "printf '%s\\n' '[{\"name\":\"logs\",\"enabled\":true,\"transport\":{\"bearer_token_env_var\":\"LOG_TOKEN\"}}]'",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.mkdirSync(targetHome, { recursive: true });
    fs.writeFileSync(path.join(targetHome, "config.toml"), "[ui]\nnotifications = true\n");
    process.env.CC_CODEX_BIN = fakeCodex;
    process.env.CC_CODEX_HOME = targetHome;
    process.env.CC_CODEX_MCP_SOURCE_HOME = sourceHome;

    const synced = syncCodexMcpAccess();
    const config = fs.readFileSync(path.join(targetHome, "config.toml"), "utf8");
    expect(synced.serverNames).toEqual(["logs"]);
    expect(synced.requiredEnvVars).toEqual(["LOG_TOKEN"]);
    expect(config).toContain("commandcenter:inherited-mcp:start");
    expect(config).toContain("[mcp_servers.logs]");
    expect(config).toContain("[ui]");
    expect(config).not.toContain("must-not-leak");
    expect(config).not.toContain("[marketplaces.local]");
    expect(fs.existsSync(path.join(targetHome, "plugins"))).toBe(false);
    expect(syncCodexMcpAccess().serverNames).toEqual(["logs"]);
    expect(fs.existsSync(path.join(targetHome, "auth.json"))).toBe(false);
    expect(fs.existsSync(path.join(targetHome, "sessions"))).toBe(false);
  });

  it("restores the prior isolated config when effective parity fails", () => {
    const root = tempDir();
    const sourceHome = path.join(root, "source");
    const targetHome = path.join(root, "target");
    fs.mkdirSync(sourceHome, { recursive: true });
    fs.mkdirSync(targetHome, { recursive: true });
    fs.writeFileSync(
      path.join(sourceHome, "config.toml"),
      '[mcp_servers.logs]\nurl = "https://example.invalid/mcp"\n',
    );
    const prior = "[ui]\nnotifications = true\n";
    fs.writeFileSync(path.join(targetHome, "config.toml"), prior);
    const fakeCodex = path.join(root, "codex");
    fs.writeFileSync(
      fakeCodex,
      [
        "#!/bin/sh",
        'if [ "$(basename "$CODEX_HOME")" = "source" ]; then',
        "  printf '%s\\n' '[{\"name\":\"logs\",\"enabled\":true}]'",
        "else",
        "  printf '%s\\n' '[]'",
        "fi",
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.CC_CODEX_BIN = fakeCodex;
    process.env.CC_CODEX_HOME = targetHome;
    process.env.CC_CODEX_MCP_SOURCE_HOME = sourceHome;

    expect(() => syncCodexMcpAccess()).toThrow(/does not match/);
    expect(fs.readFileSync(path.join(targetHome, "config.toml"), "utf8")).toBe(
      prior,
    );
  });

  it("removes only inherited MCPs when the opt-in is disabled", () => {
    const root = tempDir();
    const targetHome = path.join(root, "target");
    fs.mkdirSync(targetHome, { recursive: true });
    fs.writeFileSync(
      path.join(targetHome, "config.toml"),
      [
        "[ui]",
        "notifications = true",
        "",
        "# commandcenter:inherited-mcp:start",
        "[mcp_servers.logs]",
        'url = "https://example.invalid/mcp"',
        "# commandcenter:inherited-mcp:end",
        "",
      ].join("\n"),
    );
    process.env.CC_CODEX_HOME = targetHome;

    const result = syncCodexMcpAccess();
    expect(result.enabled).toBe(false);
    expect(fs.readFileSync(path.join(targetHome, "config.toml"), "utf8")).toBe(
      "[ui]\nnotifications = true\n",
    );
  });

  it("rejects a symlinked isolated home before writing through it", () => {
    const root = tempDir();
    const target = path.join(root, "normal-home");
    const linked = path.join(root, "isolated-link");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "keep.txt"), "unchanged");
    fs.symlinkSync(target, linked);
    process.env.CC_CODEX_HOME = linked;

    expect(() => syncCodexMcpAccess()).toThrow(/real directory/);
    expect(fs.readFileSync(path.join(target, "keep.txt"), "utf8")).toBe(
      "unchanged",
    );
    expect(fs.existsSync(path.join(target, "config.toml"))).toBe(false);
  });
});
