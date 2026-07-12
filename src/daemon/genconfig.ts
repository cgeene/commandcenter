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

const OWNED_CODEX_PROFILE_SECTIONS = new Set([
  "sandbox_workspace_write",
  "features",
  "mcp_servers.cc",
  "mcp_servers.cc.env",
]);

/** Codex appends trust and TUI state to the selected profile. Replace only
 * Command Center's generated prefix; wiping the foreign tail would invalidate
 * hook/project trust on every worker spawn. */
function mergeCodexProfile(generated: string, existing?: string): string {
  if (!existing) return generated;
  const lines = existing.split("\n");
  const foreignStart = lines.findIndex((line) => {
    const match = /^\[([^\]]+)]\s*$/.exec(line.trim());
    return Boolean(match && !OWNED_CODEX_PROFILE_SECTIONS.has(match[1]));
  });
  if (foreignStart === -1) return generated;
  const runtimeState = lines.slice(foreignStart).join("\n").trim();
  return runtimeState ? `${generated.trimEnd()}\n\n${runtimeState}\n` : generated;
}

export const _mergeCodexProfileForTest = mergeCodexProfile;

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
  rulesFile: string;
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
  fs.chmodSync(home, 0o700);

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
    // The cc server is role-scoped by CC_ROLE/agent/task identity and exposes
    // only Command Center operations appropriate to that worker. Approve its
    // tools directly so completing a task never stalls on its own result call.
    'default_tools_approval_mode = "approve"',
    'env_vars = ["CC_ROLE", "CC_AGENT_ID", "CC_TASK_ID"]',
    "",
    "[mcp_servers.cc.env]",
    `CC_URL = ${tomlString(baseUrl())}`,
    "",
  ].join("\n");
  const existingProfile = fs.existsSync(profileFile)
    ? fs.readFileSync(profileFile, "utf8")
    : undefined;
  fs.writeFileSync(profileFile, mergeCodexProfile(profileToml, existingProfile), {
    mode: 0o600,
  });
  fs.chmodSync(profileFile, 0o600);

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
          PreToolUse: [{ matcher: "Bash", hooks: [hook] }],
          PermissionRequest: [{ hooks: [hook] }],
          Stop: [{ hooks: [hook] }],
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  fs.chmodSync(hooksFile, 0o600);

  const rulesDir = path.join(home, "rules");
  fs.mkdirSync(rulesDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(rulesDir, 0o700);
  const rulesFile = path.join(rulesDir, "commandcenter.rules");
  fs.writeFileSync(
    rulesFile,
    [
      "# Route every canonical push through PermissionRequest. The static hook",
      "# then allows only the exact agent/task-N branch from CC_TASK_ID.",
      "prefix_rule(",
      '    pattern = ["git", "push"],',
      '    decision = "prompt",',
      '    justification = "Command Center validates the exact task branch before pushing",',
      '    match = ["git push -u origin agent/task-1", "git push origin main"],',
      ")",
      "",
      "prefix_rule(",
      '    pattern = ["gh", "pr", "merge"],',
      '    decision = "forbidden",',
      '    justification = "Command Center keeps merges as an explicit human action",',
      '    match = ["gh pr merge 123"],',
      ")",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  fs.chmodSync(rulesFile, 0o600);

  return { home, profile, profileFile, hooksFile, rulesFile };
}
