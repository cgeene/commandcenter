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
