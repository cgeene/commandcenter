import type { PublicationMode } from "./publication.js";

export interface CodexPermissionPayload {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { command?: unknown; [key: string]: unknown };
}

export interface CodexPermissionDecision {
  behavior: "allow" | "deny";
  message?: string;
}

export interface CodexPolicyContext {
  taskId?: string;
  workspaceKind?: "repo" | "portfolio" | "scratch";
  publicationMode?: PublicationMode;
  role?: "worker" | "reviewer";
}

interface GitInvocation {
  argv: string[];
  verb?: string;
  verbIndex: number;
}

const HUMAN_MESSAGE =
  "This task uses Human publishes: leave changes uncommitted for independent review and human publication.";
const AGENT_MESSAGE =
  "Command Center workers may push only their own task branch and may not merge pull requests.";
const SHELL_OPERATORS = new Set([";", "&&", "||", "|", "&", "(", ")"]);
const SHELL_WRAPPERS = new Set(["bash", "dash", "fish", "sh", "zsh"]);
const COMMAND_WRAPPERS = new Set(["command", "exec", "nohup", "sudo"]);
const GIT_VALUE_OPTIONS = new Set([
  "-C",
  "-c",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--super-prefix",
  "--work-tree",
]);
const HUMAN_BLOCKED_GIT = new Set([
  "am",
  "cherry-pick",
  "commit",
  "commit-tree",
  "merge",
  "push",
  "rebase",
  "revert",
  "send-pack",
  "tag",
  "update-ref",
]);
const HUMAN_BLOCKED_PR = new Set([
  "close",
  "comment",
  "create",
  "edit",
  "merge",
  "ready",
  "reopen",
  "review",
]);
const GITHUB_READ_PREFIXES = new Set([
  "compare",
  "download",
  "fetch",
  "get",
  "list",
  "search",
]);

function executableName(value: string): string {
  return value.slice(value.lastIndexOf("/") + 1).toLowerCase();
}

function isAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

/** Tokenize only the shell syntax needed by this policy. This never evaluates
 * expansion or executes input; operators become segment boundaries. */
export function tokenizeShell(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  const flush = () => {
    if (token) tokens.push(token);
    token = "";
  };
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"' && i + 1 < command.length) {
        token += command[++i];
      } else token += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "\\" && i + 1 < command.length) {
      token += command[++i];
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      if (char === "\n") tokens.push(";");
      continue;
    }
    if (char === "#" && token.length === 0) {
      while (i + 1 < command.length && command[i + 1] !== "\n") i += 1;
      continue;
    }
    if (";&|()".includes(char)) {
      flush();
      const pair = command.slice(i, i + 2);
      if (pair === "&&" || pair === "||") {
        tokens.push(pair);
        i += 1;
      } else tokens.push(char);
      continue;
    }
    token += char;
  }
  flush();
  return tokens;
}

function commandSegments(command: string): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  for (const token of tokenizeShell(command)) {
    if (SHELL_OPERATORS.has(token)) {
      if (current.length > 0) segments.push(current);
      current = [];
    } else current.push(token);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

function unwrapCommand(argv: string[]): string[] {
  let args = [...argv];
  while (args.length > 0) {
    while (isAssignment(args[0] ?? "")) args.shift();
    const executable = executableName(args[0] ?? "");
    if (executable === "env") {
      args.shift();
      while (
        args.length > 0 &&
        (isAssignment(args[0]) ||
          args[0] === "-i" ||
          args[0] === "--ignore-environment" ||
          args[0].startsWith("--unset=") ||
          args[0] === "-u")
      ) {
        if (args[0] === "-u") args.splice(0, 2);
        else args.shift();
      }
      continue;
    }
    if (COMMAND_WRAPPERS.has(executable)) {
      args.shift();
      while (args[0]?.startsWith("-")) args.shift();
      continue;
    }
    break;
  }
  return args;
}

/** Resolve the actual Git verb after supported global options. */
export function parseGitInvocation(argv: string[]): GitInvocation | undefined {
  const args = unwrapCommand(argv);
  if (executableName(args[0] ?? "") !== "git") return undefined;
  let index = 1;
  while (index < args.length) {
    const value = args[index];
    if (value === "--") {
      index += 1;
      break;
    }
    if (!value.startsWith("-")) break;
    const option = value.includes("=") ? value.slice(0, value.indexOf("=")) : value;
    if (GIT_VALUE_OPTIONS.has(option) && !value.includes("=")) index += 2;
    else index += 1;
  }
  return { argv: args, verb: args[index]?.toLowerCase(), verbIndex: index };
}

function ghPrVerb(argv: string[]): string | undefined {
  const args = unwrapCommand(argv);
  if (executableName(args[0] ?? "") !== "gh") return undefined;
  let index = 1;
  while (args[index]?.startsWith("-")) {
    const option = args[index];
    index += option.includes("=") ? 1 : 2;
  }
  return args[index]?.toLowerCase() === "pr"
    ? args[index + 1]?.toLowerCase()
    : undefined;
}

function nestedShellCommand(argv: string[]): string | undefined {
  const args = unwrapCommand(argv);
  if (!SHELL_WRAPPERS.has(executableName(args[0] ?? ""))) return undefined;
  const index = args.findIndex(
    (value, i) =>
      i > 0 &&
      (value === "--command" ||
        (value.startsWith("-") &&
          !value.startsWith("--") &&
          value.slice(1).includes("c"))),
  );
  return index >= 0 ? args[index + 1] : undefined;
}

/** Extract command/process substitutions so a mutation cannot hide inside an
 * otherwise harmless argument. Single-quoted text remains inert. */
function substitutions(command: string): string[] {
  const found: string[] = [];
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (char === "\\" && quote !== "'" && i + 1 < command.length) {
      i += 1;
      continue;
    }
    if (char === "'" && quote !== '"') {
      quote = quote === "'" ? undefined : "'";
      continue;
    }
    if (char === '"' && quote !== "'") {
      quote = quote === '"' ? undefined : '"';
      continue;
    }
    if (quote === "'") continue;
    if (char === "`") {
      const end = command.indexOf("`", i + 1);
      if (end >= 0) {
        found.push(command.slice(i + 1, end));
        i = end;
      }
      continue;
    }
    const substitution =
      (char === "$" || char === "<" || char === ">") && command[i + 1] === "(";
    if (!substitution) continue;
    const start = i + 2;
    let depth = 1;
    let nestedQuote: "'" | '"' | undefined;
    for (let j = start; j < command.length; j += 1) {
      const nestedChar = command[j];
      if (nestedChar === "\\" && nestedQuote !== "'" && j + 1 < command.length) {
        j += 1;
        continue;
      }
      if (nestedChar === "'" && nestedQuote !== '"') {
        nestedQuote = nestedQuote === "'" ? undefined : "'";
      } else if (nestedChar === '"' && nestedQuote !== "'") {
        nestedQuote = nestedQuote === '"' ? undefined : '"';
      } else if (!nestedQuote && nestedChar === "(") depth += 1;
      else if (!nestedQuote && nestedChar === ")" && --depth === 0) {
        found.push(command.slice(start, j));
        i = j;
        break;
      }
    }
  }
  return found;
}

function exactOwnPush(invocation: GitInvocation, taskId: string): boolean {
  if (invocation.verb !== "push") return false;
  const args = invocation.argv.slice(invocation.verbIndex + 1);
  if (args[0] === "-u" || args[0] === "--set-upstream") args.shift();
  return (
    args.length === 2 &&
    args[0] === "origin" &&
    args[1] === `agent/task-${taskId}`
  );
}

function definesGitAlias(invocation: GitInvocation): boolean {
  return invocation.argv
    .slice(1, invocation.verbIndex)
    .some((value) => /^alias\.[^=]+=/i.test(value));
}

function bashDecision(
  command: string,
  context: CodexPolicyContext,
  depth = 0,
): CodexPermissionDecision | undefined {
  if (depth > 4) {
    return context.publicationMode === "human" || context.role === "reviewer"
      ? { behavior: "deny", message: HUMAN_MESSAGE }
      : undefined;
  }
  const nestedSubstitutions = substitutions(command);
  for (const nested of nestedSubstitutions) {
    const decision = bashDecision(nested, context, depth + 1);
    if (decision?.behavior === "deny") return decision;
    if (decision?.behavior === "allow") {
      return { behavior: "deny", message: AGENT_MESSAGE };
    }
  }
  const segments = commandSegments(command);
  let allowOwnPush = false;
  for (const argv of segments) {
    const git = parseGitInvocation(argv);
    const prVerb = ghPrVerb(argv);
    const humanOnly =
      context.publicationMode === "human" || context.role === "reviewer";
    if (
      humanOnly &&
      ((git &&
        ((git.verb && HUMAN_BLOCKED_GIT.has(git.verb)) ||
          definesGitAlias(git))) ||
        (prVerb && HUMAN_BLOCKED_PR.has(prVerb)) ||
        (ghPrVerb(argv) === undefined &&
          executableName(unwrapCommand(argv)[0] ?? "") === "gh" &&
          unwrapCommand(argv)[1]?.toLowerCase() === "api"))
    ) {
      return { behavior: "deny", message: HUMAN_MESSAGE };
    }
    if (!humanOnly && git?.verb === "push") {
      if (
        context.workspaceKind === "repo" &&
        context.taskId &&
        exactOwnPush(git, context.taskId) &&
        depth === 0 &&
        segments.length === 1 &&
        nestedSubstitutions.length === 0
      ) {
        allowOwnPush = true;
        continue;
      }
      return { behavior: "deny", message: AGENT_MESSAGE };
    }
    if (!humanOnly && prVerb === "merge") {
      return { behavior: "deny", message: AGENT_MESSAGE };
    }
    const nested = nestedShellCommand(argv);
    if (nested) {
      const decision = bashDecision(nested, context, depth + 1);
      if (decision?.behavior === "deny") return decision;
      if (decision?.behavior === "allow") {
        return { behavior: "deny", message: AGENT_MESSAGE };
      }
    }
  }
  return allowOwnPush ? { behavior: "allow" } : undefined;
}

function githubMcpMutation(toolName: string): boolean {
  const githubIndex = toolName.toLowerCase().lastIndexOf("github");
  if (githubIndex < 0) return false;
  const action = toolName
    .slice(githubIndex + "github".length)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
  const words = action.split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length === 0) return false;
  return !GITHUB_READ_PREFIXES.has(words[0]) && words.at(-1) !== "read";
}

/** Preserve the pre-publication-mode Codex behavior exactly for normal
 * workers. Human publication is opt-in; selecting neither it nor reviewer
 * role must not change which existing shell commands are allowed or denied. */
function legacyAgentDecision(
  payload: CodexPermissionPayload,
  context: CodexPolicyContext,
): CodexPermissionDecision | undefined {
  if (payload.tool_name !== "Bash") return undefined;
  const command = payload.tool_input?.command;
  const taskId = context.taskId;
  if (typeof command !== "string" || !taskId || !/^\d+$/.test(taskId)) {
    return undefined;
  }
  const ownPush = new RegExp(
    `^\\s*git\\s+push\\s+(?:-u\\s+)?origin\\s+agent/task-${taskId}\\s*$`,
  );
  if (context.workspaceKind === "repo" && ownPush.test(command)) {
    return { behavior: "allow" };
  }
  if (
    /\bgit\b[\s\S]*\bpush\b/i.test(command) ||
    /\bgh\b[\s\S]*\bpr\s+merge\b/i.test(command)
  ) {
    return { behavior: "deny", message: AGENT_MESSAGE };
  }
  return undefined;
}

/** Enforce the selected publication boundary without changing agent-mode
 * behavior: normal workers can publish only their exact task branch; human
 * mode and reviewers cannot publish through Bash or GitHub MCP writes. */
export function codexPermissionDecision(
  payload: CodexPermissionPayload,
  contextOrTaskId: CodexPolicyContext | string | undefined,
  legacyWorkspaceKind?: CodexPolicyContext["workspaceKind"],
): CodexPermissionDecision | undefined {
  const context: CodexPolicyContext =
    typeof contextOrTaskId === "object"
      ? contextOrTaskId
      : {
          taskId: contextOrTaskId,
          workspaceKind: legacyWorkspaceKind,
          publicationMode: "agent",
          role: "worker",
        };
  if (!["PreToolUse", "PermissionRequest"].includes(payload.hook_event_name ?? "")) {
    return undefined;
  }
  const humanOnly =
    context.publicationMode === "human" || context.role === "reviewer";
  if (!humanOnly) return legacyAgentDecision(payload, context);
  if (humanOnly && githubMcpMutation(payload.tool_name ?? "")) {
    return { behavior: "deny", message: HUMAN_MESSAGE };
  }
  const command = payload.tool_input?.command;
  if (payload.tool_name !== "Bash" || typeof command !== "string") return undefined;
  return bashDecision(command, context);
}
