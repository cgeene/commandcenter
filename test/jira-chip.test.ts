import { describe, expect, it } from "vitest";
import {
  jiraChip,
  shouldHaveJiraTicket,
  JIRA_SYNC_FAIL_THRESHOLD,
  type JiraChipTask,
} from "../src/lib/jira.js";

const ENV = {
  baseUrl: "https://nylas.atlassian.net",
  enabledRepos: ["/repos/unicorn-k8s"],
};

/** A synced-ticket task in the given category, tweakable per test. */
function task(over: Partial<JiraChipTask> = {}): JiraChipTask {
  return {
    repo: "/repos/unicorn-k8s",
    open_pr: 1,
    pr_url: "https://github.com/nylas/unicorn-k8s/pull/7",
    jira_key: "EN-1234",
    jira_state: "in progress",
    jira_status_category: "indeterminate",
    jira_sync_fails: 0,
    ...over,
  };
}

describe("jiraChip — category → label/color", () => {
  it("maps 'new' to To Do", () => {
    const chip = jiraChip(task({ jira_status_category: "new", jira_state: "open" }), ENV);
    expect(chip).toMatchObject({ kind: "synced", label: "To Do", cls: "jira-todo" });
  });

  it("maps 'indeterminate' to In Progress", () => {
    const chip = jiraChip(task({ jira_status_category: "indeterminate" }), ENV);
    expect(chip).toMatchObject({ kind: "synced", label: "In Progress", cls: "jira-progress" });
  });

  it("maps 'done' to Done", () => {
    const chip = jiraChip(task({ jira_status_category: "done", jira_state: "done" }), ENV);
    expect(chip).toMatchObject({ kind: "synced", label: "Done", cls: "jira-done" });
  });

  it("falls back to the raw state name for an unknown/absent category", () => {
    const chip = jiraChip(
      task({ jira_status_category: null, jira_state: "code review" }),
      ENV,
    );
    expect(chip).toMatchObject({ kind: "synced", label: "code review", cls: "jira-unknown" });
  });

  it("builds a browse URL from the configured base (never hardcoded)", () => {
    const chip = jiraChip(task(), { ...ENV, baseUrl: "https://acme.atlassian.net/" });
    expect(chip.url).toBe("https://acme.atlassian.net/browse/EN-1234");
  });
});

describe("jiraChip — pending vs failing states", () => {
  it("shows a pending chip when a PR-bearing task in an enabled repo has no key", () => {
    const chip = jiraChip(task({ jira_key: null, jira_state: null, jira_status_category: null }), ENV);
    expect(chip).toMatchObject({ kind: "pending", key: null, url: null, label: "ticket pending" });
  });

  it("renders NO chip when the task should not have a ticket (repo not enabled)", () => {
    const chip = jiraChip(
      task({ jira_key: null, repo: "/repos/other" }),
      ENV,
    );
    expect(chip.kind).toBe("none");
  });

  it("renders NO chip for a doc-only task (open_pr = 0, no PR)", () => {
    const chip = jiraChip(
      task({ jira_key: null, pr_url: null, open_pr: 0 }),
      ENV,
    );
    expect(chip.kind).toBe("none");
  });

  it("flags a synced ticket as failing at the threshold", () => {
    const below = jiraChip(task({ jira_sync_fails: JIRA_SYNC_FAIL_THRESHOLD - 1 }), ENV);
    const at = jiraChip(task({ jira_sync_fails: JIRA_SYNC_FAIL_THRESHOLD }), ENV);
    expect(below.failing).toBe(false);
    expect(at.failing).toBe(true);
    // still a synced chip — the warning treatment layers on top of the key/label
    expect(at).toMatchObject({ kind: "synced", key: "EN-1234" });
  });

  it("flags a pending chip as failing when creation keeps failing", () => {
    const chip = jiraChip(
      task({ jira_key: null, jira_sync_fails: JIRA_SYNC_FAIL_THRESHOLD }),
      ENV,
    );
    expect(chip).toMatchObject({ kind: "pending", failing: true });
  });
});

describe("shouldHaveJiraTicket — the iff-PR + enabled-repo gate", () => {
  it("true only when PR + open_pr + repo enabled", () => {
    expect(shouldHaveJiraTicket(task(), ENV.enabledRepos)).toBe(true);
  });
  it("false without a PR", () => {
    expect(shouldHaveJiraTicket(task({ pr_url: null }), ENV.enabledRepos)).toBe(false);
  });
  it("false for a doc-only task (open_pr = 0)", () => {
    expect(shouldHaveJiraTicket(task({ open_pr: 0 }), ENV.enabledRepos)).toBe(false);
  });
  it("false for a repo that is not JIRA-enabled", () => {
    expect(shouldHaveJiraTicket(task({ repo: "/repos/other" }), ENV.enabledRepos)).toBe(false);
  });
});
