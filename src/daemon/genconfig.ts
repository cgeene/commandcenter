import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  baseUrl,
  codexHome,
  codexProfile,
  dataDir,
} from "../config.js";

/**
 * Per-agent generated Claude Code config. Each worker gets its own settings
 * file passed via --settings — we never touch ~/.claude/settings.json, which
 * is documented to corrupt under concurrent claude launches.
 */

function configDir(sub: string): string {
  const dir = path.join(dataDir(), sub);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Hook command: forward the hook's stdin JSON to agentd. Always exits 0 so a
 *  daemon outage can never block the agent's own work. */
export function hookCommand(agentId: number): string {
  return `curl -sf -m 5 -X POST ${baseUrl()}/api/hooks/agent/${agentId} -H 'Content-Type: application/json' --data-binary @- >/dev/null 2>&1 || true`;
}

export function writeSettingsFile(
  tag: string,
  agentId: number,
  permissions?: { allow?: string[]; deny?: string[] },
): string {
  const hook = [{ hooks: [{ type: "command", command: hookCommand(agentId) }] }];
  const settings = {
    permissions: {
      allow: ["mcp__cc", ...(permissions?.allow ?? [])],
      ...(permissions?.deny?.length ? { deny: permissions.deny } : {}),
    },
    hooks: { SessionStart: hook, Stop: hook, Notification: hook },
  };
  const file = path.join(configDir("settings"), `${tag}.json`);
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  return file;
}

/** Path to the built MCP server entrypoint (dist/mcp/index.js). */
export function mcpEntryPath(): string {
  const pkgRoot = fileURLToPath(new URL("../..", import.meta.url));
  const entry = path.join(pkgRoot, "dist", "mcp", "index.js");
  if (!fs.existsSync(entry)) {
    throw new Error(`MCP server not built at ${entry} — run: npm run build`);
  }
  return entry;
}

export function writeMcpConfigFile(
  tag: string,
  env: Record<string, string>,
): string {
  const config = {
    mcpServers: {
      cc: {
        command: process.execPath,
        args: [mcpEntryPath()],
        env: { CC_URL: baseUrl(), ...env },
      },
    },
  };
  const file = path.join(configDir("mcp"), `${tag}.json`);
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  return file;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Path to the built Codex hook bridge. */
export function codexHookEntryPath(): string {
  const pkgRoot = fileURLToPath(new URL("../..", import.meta.url));
  const entry = path.join(pkgRoot, "dist", "scripts", "codex-hook.js");
  if (!fs.existsSync(entry)) {
    throw new Error(`Codex hook bridge not built at ${entry} — run: npm run build`);
  }
  return entry;
}

export interface CodexConfigFiles {
  home: string;
  profile: string;
  profileFile: string;
  hooksFile: string;
}

/**
 * Generate a dedicated Codex home for Command Center. The hook definition is
 * deliberately static: worker identity comes from the process environment,
 * so Codex only needs a one-time trust review for this exact hook hash.
 */
export function writeCodexConfig(): CodexConfigFiles {
  const home = codexHome();
  const profile = codexProfile();
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });

  const profileFile = path.join(home, `${profile}.config.toml`);
  const profileToml = [
    'approval_policy = "on-request"',
    'sandbox_mode = "workspace-write"',
    "",
    "[sandbox_workspace_write]",
    "network_access = false",
    "",
    "[features]",
    "hooks = true",
    "",
    "[mcp_servers.cc]",
    `command = ${tomlString(process.execPath)}`,
    `args = [${tomlString(mcpEntryPath())}]`,
    "required = true",
    'default_tools_approval_mode = "auto"',
    'env_vars = ["CC_ROLE", "CC_AGENT_ID", "CC_TASK_ID"]',
    "",
    "[mcp_servers.cc.env]",
    `CC_URL = ${tomlString(baseUrl())}`,
    "",
  ].join("\n");
  fs.writeFileSync(profileFile, profileToml, { mode: 0o600 });

  const hook = {
    type: "command",
    command: `${shellQuote(process.execPath)} ${shellQuote(codexHookEntryPath())}`,
    timeout: 10,
  };
  const hooksFile = path.join(home, "hooks.json");
  fs.writeFileSync(
    hooksFile,
    JSON.stringify(
      {
        hooks: {
          SessionStart: [{ hooks: [hook] }],
          PermissionRequest: [{ hooks: [hook] }],
          Stop: [{ hooks: [hook] }],
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  return { home, profile, profileFile, hooksFile };
}
