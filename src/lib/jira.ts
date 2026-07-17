/**
 * Pure, dependency-free JIRA chip presentation logic. Kept free of any DB/node
 * imports so both the node test suite (test/jira-chip.test.ts) and the
 * separately-built web bundle (web/src/App.tsx) can import it — one source of
 * truth for how a ticket's state maps to a chip, mirroring src/lib/board.ts.
 *
 * The chip labels/colors come from the workflow-INDEPENDENT status category
 * (new / indeterminate / done → To Do / In Progress / Done), never a project's
 * custom status vocabulary — see the design doc §5.
 */

/** The minimal task shape the chip needs. Both the daemon and web `Task` types
 *  satisfy it structurally. */
export interface JiraChipTask {
  repo: string;
  open_pr: number;
  pr_url: string | null;
  jira_key: string | null;
  jira_state: string | null;
  jira_status_category: string | null;
  jira_sync_fails: number;
}

export interface JiraChipEnv {
  /** JIRA base URL for browse links (from CC_JIRA_BASE_URL, never hardcoded). */
  baseUrl: string;
  /** Repos (absolute path or "owner/name") that are JIRA-enabled right now. */
  enabledRepos: string[];
}

/**
 * A ticket whose consecutive sync/create failures reach this renders the
 * warning treatment. Mirrors SYNC_FAIL_THRESHOLD in src/daemon/jirasync.ts (the
 * daemon's escalate-once threshold) and the PR "sync broken" cutoff in the UI —
 * keep the three in step.
 */
export const JIRA_SYNC_FAIL_THRESHOLD = 3;

export type JiraChipKind = "synced" | "pending" | "none";

/** Workflow-independent status category → display label + css-class suffix. */
const CATEGORY: Record<string, { label: string; cls: string }> = {
  new: { label: "To Do", cls: "jira-todo" },
  indeterminate: { label: "In Progress", cls: "jira-progress" },
  done: { label: "Done", cls: "jira-done" },
};

export interface JiraChip {
  kind: JiraChipKind;
  /** Issue key (kind === "synced"), else null. */
  key: string | null;
  /** Browse URL (kind === "synced"), else null. */
  url: string | null;
  /** Category label ("To Do" / "In Progress" / "Done" / "ticket pending"). */
  label: string;
  /** CSS class suffix for the category color. */
  cls: string;
  /** Sync/create is failing (streak ≥ threshold) — render the warning state. */
  failing: boolean;
  /** Hover title with the underlying state. */
  title: string;
}

function browseUrl(baseUrl: string, key: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/browse/${encodeURIComponent(key)}`;
}

/**
 * Whether a task is EXPECTED to carry a ticket: the iff-PR rule (a real,
 * ticket-opening PR) AND its repo is JIRA-enabled. A task that qualifies but has
 * no jira_key yet is mid-creation (or JIRA is down) — surfaced as a muted
 * "ticket pending" chip to distinguish it from a repo that never gets tickets.
 */
export function shouldHaveJiraTicket(
  task: JiraChipTask,
  enabledRepos: string[],
): boolean {
  return (
    !!task.pr_url && task.open_pr !== 0 && enabledRepos.includes(task.repo)
  );
}

/** Compute the JIRA chip descriptor for a task; kind "none" ⇒ render no chip. */
export function jiraChip(task: JiraChipTask, env: JiraChipEnv): JiraChip {
  const failing = (task.jira_sync_fails ?? 0) >= JIRA_SYNC_FAIL_THRESHOLD;

  if (task.jira_key) {
    const cat = CATEGORY[task.jira_status_category ?? ""] ?? {
      label: task.jira_state ?? "ticket",
      cls: "jira-unknown",
    };
    return {
      kind: "synced",
      key: task.jira_key,
      url: browseUrl(env.baseUrl, task.jira_key),
      label: cat.label,
      cls: cat.cls,
      failing,
      title: failing
        ? `JIRA sync failing — ${task.jira_sync_fails} consecutive failures (${task.jira_key}${task.jira_state ? ` · ${task.jira_state}` : ""})`
        : `${task.jira_key}${task.jira_state ? ` · ${task.jira_state}` : ""}`,
    };
  }

  if (shouldHaveJiraTicket(task, env.enabledRepos)) {
    return {
      kind: "pending",
      key: null,
      url: null,
      label: "ticket pending",
      cls: "jira-pending",
      failing,
      title: failing
        ? `JIRA ticket creation failing — ${task.jira_sync_fails} consecutive failures`
        : "JIRA ticket pending — creating, or JIRA temporarily unavailable",
    };
  }

  return { kind: "none", key: null, url: null, label: "", cls: "", failing, title: "" };
}
