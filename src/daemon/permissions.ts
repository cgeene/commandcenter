import { getSchedulerConfig } from "../db/settings.js";

/**
 * Read-only allowlist baked into every generated worker/reviewer
 * settings.json. Reviewers get this unconditionally (they can't mutate
 * anything else anyway); workers get it as a base layer under their
 * branch-scoped push/PR allowances. Every pattern here must be incapable
 * of changing state — when a tool/command could plausibly mutate
 * something, leave it out and let the normal permission prompt handle it.
 */

const ATLASSIAN_READ_ALLOW = [
  // getConfluencePage / getConfluencePageFooterComments / getConfluencePageInlineComments / getConfluencePageDescendants
  "mcp__claude_ai_Atlassian__getConfluencePage*",
  "mcp__claude_ai_Atlassian__getConfluenceSpaces",
  "mcp__claude_ai_Atlassian__getConfluenceCommentChildren",
  "mcp__claude_ai_Atlassian__getPagesInConfluenceSpace",
  // getJiraIssue / getJiraIssueRemoteIssueLinks / getJiraIssueTypeMetaWithFields
  "mcp__claude_ai_Atlassian__getJiraIssue*",
  "mcp__claude_ai_Atlassian__getJiraProjectIssueTypesMetadata",
  "mcp__claude_ai_Atlassian__getTransitionsForJiraIssue",
  "mcp__claude_ai_Atlassian__getVisibleJiraProjects",
  "mcp__claude_ai_Atlassian__getIssueLinkTypes",
  "mcp__claude_ai_Atlassian__getAccessibleAtlassianResources",
  "mcp__claude_ai_Atlassian__lookupJiraAccountId",
  "mcp__claude_ai_Atlassian__atlassianUserInfo",
  // search / searchConfluenceUsingCql / searchJiraIssuesUsingJql
  "mcp__claude_ai_Atlassian__search*",
  "mcp__claude_ai_Atlassian__fetch",
];

const SLACK_READ_ALLOW = [
  "mcp__claude_ai_Slack__slack_read_*",
  "mcp__claude_ai_Slack__slack_search_*",
];

const BASH_READ_ONLY_ALLOW = [
  "Bash(gcloud * list*)",
  "Bash(gcloud * describe*)",
  "Bash(bq ls*)",
  "Bash(bq show*)",
  "Bash(bq query --dry_run*)",
  "Bash(kubectl get*)",
  "Bash(kubectl describe*)",
  "Bash(git log*)",
  "Bash(git show*)",
  "Bash(git diff*)",
];

export const READ_ONLY_PROFILE: readonly string[] = [
  ...ATLASSIAN_READ_ALLOW,
  ...SLACK_READ_ALLOW,
  ...BASH_READ_ONLY_ALLOW,
];

/** READ_ONLY_PROFILE plus any org-specific extra patterns from scheduler
 *  config — lets new read-only MCP servers/commands get allowlisted via
 *  config instead of a code change. */
export function readOnlyProfileAllow(): string[] {
  const extra = getSchedulerConfig().read_only_extra_allow ?? [];
  return [...READ_ONLY_PROFILE, ...extra];
}

/**
 * Frictionless self-verification for Claude workers/reviewers.
 *
 * Workers and reviewers run under permission `defaultMode: "dontAsk"` — the
 * baseline is DENY, so anything not matched by an allow rule is refused
 * without prompting the human. That is deliberate: routine work never pages
 * the human, and the *only* things that still surface a prompt are the ones
 * we explicitly route to the `ask` list below. But it means the safe tooling
 * an agent leans on constantly has to be allow-listed, or it silently breaks.
 *
 * Enumerating every safe *command* is hopeless: build/test/install get wrapped
 * in env-var prefixes (`CC_REPO_ROOTS= npx vitest`), output redirection
 * (`… >/tmp/x.log 2>&1`), and compound `&&`/`;`/`||` chains, none of which a
 * prefix allow rule can match. So instead we allow the whole `Bash` tool and
 * lean on the deny/ask guards below to carve out the genuinely dangerous
 * forms. Rule precedence is deny > ask > allow (in every mode, including
 * dontAsk), so a blanket Bash allow never overrides an explicit deny/ask.
 */

/** Blanket Bash allow — the "don't enumerate every safe command" catch-all.
 *  Bare tool name (not a `Bash(*)` pattern) so it also covers commands whose
 *  env-var prefix / compound syntax would defeat a command-pattern rule. */
export const BASH_TOOL_ALLOW = "Bash";

/** Built-in tools a *worker* needs auto-approved once the baseline is DENY.
 *  Editing/search/web/task tooling used constantly and confined to the
 *  worker's own worktree. Anything omitted here is denied silently, so keep
 *  this list broad — add new built-in tools as the provider gains them. */
export const WORKER_TOOL_ALLOW: readonly string[] = [
  "Read",
  "Edit",
  "Write",
  "NotebookEdit",
  "Glob",
  "Grep",
  "TodoWrite",
  "Task",
  "WebFetch",
  "WebSearch",
  "BashOutput",
  "KillShell",
];

/** Built-in tools a *reviewer* needs. Reviewers are read-only, so the
 *  editing tools are intentionally absent (and additionally denied). */
export const REVIEWER_TOOL_ALLOW: readonly string[] = [
  "Read",
  "Glob",
  "Grep",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "BashOutput",
  "KillShell",
];

/** Commands blocked outright even inside an isolated worktree. Deny rules
 *  take precedence over the blanket Bash allow and match through leading
 *  env-var assignments and each subcommand of a compound, so a dangerous
 *  subcommand anywhere in a `&&` chain blocks the whole command. */
export const DANGEROUS_BASH_DENY: readonly string[] = [
  "Bash(sudo *)",
  "Bash(sudo)",
  "Bash(rm -rf /)",
  "Bash(rm -rf /*)",
  "Bash(rm -fr /)",
  "Bash(rm -fr /*)",
  "Bash(rm -rf ~*)",
  "Bash(rm -fr ~*)",
  "Bash(rm -rf $HOME*)",
  "Bash(rm -fr $HOME*)",
  "Bash(gh pr merge*)",
  "Bash(gh repo delete*)",
  "Bash(git push --delete*)",
  "Bash(git push -d *)",
];

/** Pushes that must still prompt rather than run silently: force-pushes and
 *  anything targeting a protected/main ref. A worker's own agent/task-N
 *  branch push matches none of these and falls through to the allow baseline,
 *  staying frictionless. Ask rules override allow (ask > allow) and match
 *  through env-var prefixes and per-subcommand, so a force-push buried in a
 *  compound still surfaces a prompt. */
export const DANGEROUS_PUSH_ASK: readonly string[] = [
  "Bash(git push --force*)",
  "Bash(git push -f*)",
  "Bash(git push --force-with-lease*)",
  "Bash(git push * main*)",
  "Bash(git push * master*)",
  "Bash(git push *:main*)",
  "Bash(git push *:master*)",
  "Bash(git push origin main*)",
  "Bash(git push origin master*)",
];
