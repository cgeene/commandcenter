import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { baseUrl, dataDir } from "../config.js";

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
