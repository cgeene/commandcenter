import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  codexBin,
  codexHome,
  codexMcpSourceHome,
} from "../config.js";

const MANAGED_START = "# commandcenter:inherited-mcp:start";
const MANAGED_END = "# commandcenter:inherited-mcp:end";
const TRUST_START = "# commandcenter:scratch-trust:start";
const TRUST_END = "# commandcenter:scratch-trust:end";
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_MCP_SERVERS = 64;
const SAFE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SAFE_SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const SENSITIVE_NAME = /(?:secret|token|password|passwd|credential|api[_-]?key|private[_-]?key|authorization)/i;
const ISOLATED_HOME_ENV_NAMES = new Set([
  "CODEX_HOME",
  "NODE_REPL_TRUSTED_CODE_PATHS",
]);

interface EffectiveMcpTransport {
  type?: unknown;
  command?: unknown;
  args?: unknown;
  cwd?: unknown;
  env?: unknown;
  env_vars?: unknown;
  url?: unknown;
  auth?: unknown;
  bearer_token_env_var?: unknown;
  http_headers?: unknown;
  env_http_headers?: unknown;
}

interface EffectiveMcpServer {
  name: string;
  enabled: boolean;
  startup_timeout_sec?: unknown;
  tool_timeout_sec?: unknown;
  transport?: EffectiveMcpTransport;
}

export interface CodexMcpAccess {
  enabled: boolean;
  sourceHome?: string;
  configFile: string;
  serverNames: string[];
  requiredEnvVars: string[];
}

function ensureCodexHome(): string {
  const configured = codexHome();
  if (
    !path.isAbsolute(configured) ||
    configured.includes("\0") ||
    Buffer.byteLength(configured, "utf8") > 4096
  ) {
    throw new Error("Command Center Codex home must be an absolute path");
  }
  if (fs.existsSync(configured)) {
    const stat = fs.lstatSync(configured);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Command Center Codex home must be a real directory");
    }
  } else {
    fs.mkdirSync(configured, { recursive: true, mode: 0o700 });
  }
  const real = fs.realpathSync(configured);
  fs.chmodSync(real, 0o700);
  return real;
}

function tableRoot(line: string): string | undefined {
  return /^\s*\[\[?\s*([A-Za-z0-9_-]+)/.exec(line)?.[1];
}

function tableName(line: string): string | undefined {
  return /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line)?.[1];
}

function assignmentKey(line: string): string | undefined {
  const match = /^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_][A-Za-z0-9_-]*))\s*=/.exec(
    line,
  );
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function boundedString(value: unknown, label: string, max = 4096): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > max ||
    value.includes("\0")
  ) {
    throw new Error(`Inherited MCP ${label} is invalid`);
  }
  return value;
}

function safeEnvName(value: unknown): string {
  if (typeof value !== "string" || !SAFE_ENV_NAME.test(value)) {
    throw new Error("Codex MCP config contains an invalid environment variable name");
  }
  return value;
}

function staticServerNames(config: string): Set<string> {
  const names = new Set<string>();
  for (const line of config.split("\n")) {
    const match =
      /^\s*\[mcp_servers\.(?:"([A-Za-z0-9_-]{1,64})"|'([A-Za-z0-9_-]{1,64})'|([A-Za-z0-9_-]{1,64}))(?:\.|\])/.exec(
        line,
      );
    const name = match?.[1] ?? match?.[2] ?? match?.[3];
    if (name) names.add(name);
  }
  return names;
}

/**
 * Copy only explicit MCP tables. Plugin-provided MCPs are flattened from the
 * effective Codex MCP list separately, so plugins, apps, skills, hooks, auth,
 * trust, models, sessions, and other normal-home state are never enabled.
 */
export function extractInheritedCodexConfig(
  source: string,
  isolatedHome?: string,
): string {
  if (Buffer.byteLength(source, "utf8") > MAX_CONFIG_BYTES) {
    throw new Error("Codex MCP source config is too large");
  }

  const output: string[] = [];
  let include = false;
  let currentTable = "";
  for (const line of source.split("\n")) {
    const root = tableRoot(line);
    if (root !== undefined) {
      include = root === "mcp_servers";
      currentTable = include ? tableName(line) ?? "" : "";
    }
    if (!include) continue;

    const key = assignmentKey(line);
    if (key) {
      if (key === "http_headers") {
        throw new Error(
          "Inherited MCP config uses static HTTP headers; move credentials to env_http_headers",
        );
      }
      if (
        SENSITIVE_NAME.test(key) &&
        !/(?:env_var|env_vars|env_http_headers)$/i.test(key)
      ) {
        throw new Error(
          `Inherited Codex config contains an inline sensitive field in ${currentTable}`,
        );
      }
      if (
        /^mcp_servers\..+\.env$/.test(currentTable) &&
        ISOLATED_HOME_ENV_NAMES.has(key)
      ) {
        if (isolatedHome) output.push(`${key} = ${tomlString(isolatedHome)}`);
        continue;
      }
    }
    output.push(line);
  }

  return output.join("\n").trim();
}

function stripManagedBlock(existing: string): string {
  const startCount = existing.split(MANAGED_START).length - 1;
  const endCount = existing.split(MANAGED_END).length - 1;
  const start = existing.indexOf(MANAGED_START);
  const end = existing.indexOf(MANAGED_END);
  if (
    startCount !== endCount ||
    startCount > 1 ||
    (start !== -1 && end < start)
  ) {
    throw new Error("Command Center MCP markers in config.toml are malformed");
  }
  if (start === -1) return existing.trim();
  const after = end + MANAGED_END.length;
  return `${existing.slice(0, start)}${existing.slice(after)}`.trim();
}

function stripScratchTrustBlock(existing: string): string {
  const startCount = existing.split(TRUST_START).length - 1;
  const endCount = existing.split(TRUST_END).length - 1;
  const start = existing.indexOf(TRUST_START);
  const end = existing.indexOf(TRUST_END);
  if (
    startCount !== endCount ||
    startCount > 1 ||
    (start !== -1 && end < start)
  ) {
    throw new Error("Command Center scratch trust markers are malformed");
  }
  if (start === -1) return existing.trim();
  return `${existing.slice(0, start)}${existing.slice(end + TRUST_END.length)}`.trim();
}

function hasMcpTable(config: string): boolean {
  return config
    .split("\n")
    .some((line) => tableRoot(line) === "mcp_servers");
}

export function mergeInheritedCodexConfig(
  existing: string | undefined,
  inherited: string,
): string {
  const foreign = stripManagedBlock(existing ?? "");
  if (inherited && hasMcpTable(foreign)) {
    throw new Error(
      "The isolated Codex config already has MCP tables outside Command Center's managed block",
    );
  }
  const block = inherited
    ? `${MANAGED_START}\n${inherited.trim()}\n${MANAGED_END}`
    : "";
  return [foreign, block].filter(Boolean).join("\n\n").concat("\n");
}

export function mergeCodexScratchTrust(
  existing: string | undefined,
  workspaces: string[],
): string {
  const foreign = stripScratchTrustBlock(existing ?? "");
  const unique = [...new Set(workspaces)].sort();
  if (unique.length > 500) throw new Error("Too many Codex scratch workspaces");
  const tables = unique.map((workspace) => {
    if (
      !path.isAbsolute(workspace) ||
      workspace.includes("\0") ||
      Buffer.byteLength(workspace, "utf8") > 4096
    ) {
      throw new Error("Codex scratch workspace path is invalid");
    }
    const table = `[projects.${tomlString(workspace)}]`;
    if (foreign.includes(table)) {
      throw new Error("Codex scratch trust collides with existing project config");
    }
    return `${table}\ntrust_level = "trusted"`;
  });
  const block = tables.length > 0
    ? `${TRUST_START}\n${tables.join("\n\n")}\n${TRUST_END}`
    : "";
  return [foreign, block].filter(Boolean).join("\n\n").concat("\n");
}

function parseMcpList(output: string): EffectiveMcpServer[] {
  const lines = output.split("\n");
  const jsonStart = lines.findIndex((line) => {
    const value = line.trim();
    return value === "[" || value === "[]" || value.startsWith("[{");
  });
  if (jsonStart === -1) throw new Error("Codex MCP list did not return JSON");

  let raw: unknown;
  try {
    raw = JSON.parse(lines.slice(jsonStart).join("\n"));
  } catch {
    throw new Error("Codex MCP list returned invalid JSON");
  }
  if (!Array.isArray(raw) || raw.length > MAX_MCP_SERVERS) {
    throw new Error("Codex MCP list has an invalid server count");
  }

  const seen = new Set<string>();
  return raw.map((value) => {
    if (!value || typeof value !== "object") {
      throw new Error("Codex MCP list contains an invalid server");
    }
    const item = value as Record<string, unknown>;
    if (
      typeof item.name !== "string" ||
      !SAFE_SERVER_NAME.test(item.name) ||
      typeof item.enabled !== "boolean" ||
      seen.has(item.name)
    ) {
      throw new Error("Codex MCP list contains an invalid or duplicate server name");
    }
    seen.add(item.name);
    const transport =
      item.transport && typeof item.transport === "object"
        ? (item.transport as EffectiveMcpTransport)
        : undefined;
    return {
      name: item.name,
      enabled: item.enabled,
      startup_timeout_sec: item.startup_timeout_sec,
      tool_timeout_sec: item.tool_timeout_sec,
      transport,
    };
  });
}

function listEffectiveMcpServers(home: string): EffectiveMcpServer[] {
  const result = spawnSync(codexBin(), ["mcp", "list", "--json"], {
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: home },
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error("Unable to read effective MCP servers from the Codex home");
  }
  return parseMcpList(result.stdout || "");
}

function renderTimeout(name: string, value: unknown): string | undefined {
  if (value == null) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 3600) {
    throw new Error(`Inherited MCP ${name} is invalid`);
  }
  return `${name} = ${value}`;
}

function renderStringArray(name: string, value: unknown): string | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length > 128) {
    throw new Error(`Inherited MCP ${name} is invalid`);
  }
  const values = value.map((item) => tomlString(boundedString(item, name)));
  return `${name} = [${values.join(", ")}]`;
}

function validateHttpUrl(value: unknown): string {
  const raw = boundedString(value, "URL", 8192);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Inherited MCP URL is invalid");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Inherited MCP URL must use HTTPS or loopback HTTP");
  }
  return raw;
}

function renderEnvironment(
  value: unknown,
  isolatedHome: string,
): string[] {
  if (value == null) return [];
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Inherited MCP environment is invalid");
  }
  const entries = Object.entries(value);
  if (entries.length > 128) throw new Error("Inherited MCP environment is too large");
  return entries.map(([name, raw]) => {
    safeEnvName(name);
    if (SENSITIVE_NAME.test(name)) {
      throw new Error("Inherited MCP environment contains an inline sensitive field");
    }
    const envValue = ISOLATED_HOME_ENV_NAMES.has(name)
      ? isolatedHome
      : boundedString(raw, "environment value", 64 * 1024);
    return `${name} = ${tomlString(envValue)}`;
  });
}

function renderEnvironmentNames(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length > 128) {
    throw new Error("Inherited MCP env_vars is invalid");
  }
  const values = value.map((item) => tomlString(safeEnvName(item)));
  return `env_vars = [${values.join(", ")}]`;
}

function renderEnvironmentHeaders(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Inherited MCP env_http_headers is invalid");
  }
  const entries = Object.entries(value);
  if (entries.length > 64) {
    throw new Error("Inherited MCP env_http_headers is too large");
  }
  const rendered = entries.map(([header, envName]) => {
    if (
      header.length === 0 ||
      header.length > 256 ||
      /[\r\n]/.test(header)
    ) {
      throw new Error("Inherited MCP HTTP header name is invalid");
    }
    return `${tomlString(header)} = ${tomlString(safeEnvName(envName))}`;
  });
  return `env_http_headers = { ${rendered.join(", ")} }`;
}

function renderFlattenedMcpServer(
  server: EffectiveMcpServer,
  isolatedHome: string,
): string {
  const transport = server.transport;
  if (!transport || typeof transport.type !== "string") {
    throw new Error(`Plugin-provided MCP ${server.name} has no usable transport`);
  }
  const lines = [`[mcp_servers.${server.name}]`];
  let environment: string[] = [];

  if (transport.type === "stdio") {
    lines.push(`command = ${tomlString(boundedString(transport.command, "command"))}`);
    const args = renderStringArray("args", transport.args);
    if (args) lines.push(args);
    if (transport.cwd != null) {
      const cwd = boundedString(transport.cwd, "cwd", 8192);
      if (!path.isAbsolute(cwd)) throw new Error("Inherited MCP cwd must be absolute");
      lines.push(`cwd = ${tomlString(cwd)}`);
    }
    const envVars = renderEnvironmentNames(transport.env_vars);
    if (envVars) lines.push(envVars);
    environment = renderEnvironment(transport.env, isolatedHome);
  } else if (transport.type === "streamable_http") {
    lines.push(`url = ${tomlString(validateHttpUrl(transport.url))}`);
    if (transport.auth != null) {
      if (transport.auth !== "oauth" && transport.auth !== "chatgpt") {
        throw new Error("Inherited MCP HTTP auth mode is invalid");
      }
      lines.push(`auth = ${tomlString(transport.auth)}`);
    }
    if (transport.bearer_token_env_var != null) {
      lines.push(
        `bearer_token_env_var = ${tomlString(
          safeEnvName(transport.bearer_token_env_var),
        )}`,
      );
    }
    if (
      transport.http_headers != null &&
      (typeof transport.http_headers !== "object" ||
        Array.isArray(transport.http_headers) ||
        Object.keys(transport.http_headers).length > 0)
    ) {
      throw new Error("Inherited MCP uses static HTTP headers");
    }
    const envHeaders = renderEnvironmentHeaders(transport.env_http_headers);
    if (envHeaders) lines.push(envHeaders);
  } else {
    throw new Error(`Plugin-provided MCP ${server.name} has an unsupported transport`);
  }

  lines.push(`enabled = ${server.enabled}`, "required = false");
  const startup = renderTimeout("startup_timeout_sec", server.startup_timeout_sec);
  if (startup) lines.push(startup);
  const tool = renderTimeout("tool_timeout_sec", server.tool_timeout_sec);
  if (tool) lines.push(tool);
  lines.push('default_tools_approval_mode = "writes"');
  if (environment.length > 0) {
    lines.push("", `[mcp_servers.${server.name}.env]`, ...environment);
  }
  return lines.join("\n");
}

function requiredEnvironment(servers: EffectiveMcpServer[]): string[] {
  const names = new Set<string>();
  const add = (value: unknown) => {
    const name = safeEnvName(value);
    if (name !== "CODEX_HOME") names.add(name);
  };

  for (const server of servers) {
    if (!server.enabled) continue;
    const transport = server.transport;
    if (!transport) continue;
    if (transport.bearer_token_env_var != null) add(transport.bearer_token_env_var);
    if (transport.env_vars != null) {
      if (!Array.isArray(transport.env_vars)) {
        throw new Error("Codex MCP config contains invalid env_vars");
      }
      for (const value of transport.env_vars) add(value);
    }
    if (transport.env_http_headers != null) {
      if (
        typeof transport.env_http_headers !== "object" ||
        Array.isArray(transport.env_http_headers)
      ) {
        throw new Error("Codex MCP config contains invalid env_http_headers");
      }
      for (const value of Object.values(transport.env_http_headers)) add(value);
    }
  }
  return [...names].sort();
}

function sameEffectiveServers(
  source: EffectiveMcpServer[],
  target: EffectiveMcpServer[],
): boolean {
  const normalize = (servers: EffectiveMcpServer[]) =>
    servers
      .map(({ name, enabled, transport }) => `${name}:${enabled}:${transport?.type ?? ""}`)
      .sort()
      .join("\n");
  return (
    normalize(source) === normalize(target) &&
    requiredEnvironment(source).join("\n") ===
      requiredEnvironment(target).join("\n")
  );
}

/** Mirror normal-home MCP access without sharing normal Codex state/plugins. */
export function syncCodexMcpAccess(): CodexMcpAccess {
  const targetHome = ensureCodexHome();
  const configFile = path.join(targetHome, "config.toml");
  const configuredSource = codexMcpSourceHome();

  if (!configuredSource) {
    if (fs.existsSync(configFile)) {
      const merged = mergeInheritedCodexConfig(
        fs.readFileSync(configFile, "utf8"),
        "",
      );
      fs.writeFileSync(configFile, merged, { mode: 0o600 });
      fs.chmodSync(configFile, 0o600);
    }
    return { enabled: false, configFile, serverNames: [], requiredEnvVars: [] };
  }

  if (!path.isAbsolute(configuredSource)) {
    throw new Error("CC_CODEX_MCP_SOURCE_HOME must be an absolute path");
  }
  let sourceHome: string;
  try {
    sourceHome = fs.realpathSync(configuredSource);
  } catch {
    throw new Error("Codex MCP source home is unavailable");
  }
  const resolvedTarget = fs.realpathSync(targetHome);
  if (sourceHome === resolvedTarget) {
    throw new Error("MCP source home must differ from Command Center's isolated home");
  }
  const sourceConfigFile = path.join(sourceHome, "config.toml");
  if (!fs.existsSync(sourceConfigFile) || !fs.statSync(sourceConfigFile).isFile()) {
    throw new Error("Codex MCP source config.toml is missing");
  }

  const sourceConfig = fs.readFileSync(sourceConfigFile, "utf8");
  const sourceServers = listEffectiveMcpServers(sourceHome);
  if (sourceServers.some((server) => server.name === "cc")) {
    throw new Error("The MCP name 'cc' is reserved by Command Center");
  }
  const explicitNames = staticServerNames(sourceConfig);
  const explicit = extractInheritedCodexConfig(sourceConfig, targetHome);
  const flattened = sourceServers
    .filter((server) => !explicitNames.has(server.name))
    .map((server) => renderFlattenedMcpServer(server, targetHome));
  const inherited = [explicit, ...flattened].filter(Boolean).join("\n\n");

  const existing = fs.existsSync(configFile)
    ? fs.readFileSync(configFile, "utf8")
    : undefined;
  try {
    fs.writeFileSync(
      configFile,
      mergeInheritedCodexConfig(existing, inherited),
      { mode: 0o600 },
    );
    fs.chmodSync(configFile, 0o600);

    const targetServers = listEffectiveMcpServers(targetHome);
    if (!sameEffectiveServers(sourceServers, targetServers)) {
      throw new Error(
        "Isolated Codex MCP server set does not match its configured source",
      );
    }
  } catch (error) {
    if (existing === undefined) {
      if (fs.existsSync(configFile)) fs.unlinkSync(configFile);
    } else {
      fs.writeFileSync(configFile, existing, { mode: 0o600 });
      fs.chmodSync(configFile, 0o600);
    }
    throw error;
  }

  return {
    enabled: true,
    sourceHome,
    configFile,
    serverNames: sourceServers.map((server) => server.name).sort(),
    requiredEnvVars: requiredEnvironment(sourceServers),
  };
}

/** Trust only private scratch directories created and validated by Command Center. */
export function syncCodexScratchTrust(workspaces: string[]): void {
  const home = ensureCodexHome();
  const configFile = path.join(home, "config.toml");
  const existing = fs.existsSync(configFile)
    ? fs.readFileSync(configFile, "utf8")
    : undefined;
  try {
    fs.writeFileSync(configFile, mergeCodexScratchTrust(existing, workspaces), {
      mode: 0o600,
    });
    fs.chmodSync(configFile, 0o600);
    // A local list forces Codex to parse the resulting TOML before a worker
    // is launched; malformed config rolls back instead of stranding a task.
    listEffectiveMcpServers(home);
  } catch (error) {
    if (existing === undefined) {
      if (fs.existsSync(configFile)) fs.unlinkSync(configFile);
    } else {
      fs.writeFileSync(configFile, existing, { mode: 0o600 });
      fs.chmodSync(configFile, 0o600);
    }
    throw error;
  }
}

export const _parseMcpListForTest = parseMcpList;
export const _requiredEnvironmentForTest = requiredEnvironment;
export const _renderFlattenedMcpForTest = renderFlattenedMcpServer;
