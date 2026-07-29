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
  // JIRA's status CATEGORY drives the chip, not the per-project state name, so an
  // unrecognized category falls back to showing the raw name rather than lying.
  it("maps each status category to its label and class", () => {
    for (const { why, category, state, label, cls } of [
      { why: "new", category: "new", state: "open", label: "To Do", cls: "jira-todo" },
      { why: "indeterminate", category: "indeterminate", state: undefined, label: "In Progress", cls: "jira-progress" },
      { why: "done", category: "done", state: "done", label: "Done", cls: "jira-done" },
      { why: "an unknown/absent category falls back to the raw state name", category: null, state: "code review", label: "code review", cls: "jira-unknown" },
    ] as const) {
      const chip = jiraChip(
        task({
          jira_status_category: category,
          ...(state === undefined ? {} : { jira_state: state }),
        }),
        ENV,
      );
      expect(chip, why).toMatchObject({ kind: "synced", label, cls });
    }
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
  // A ticket is owed iff the task has a PR, opens one, and its repo is enabled.
  it("is true only for a PR-bearing, PR-opening task in an enabled repo", () => {
    for (const { why, over, owed } of [
      { why: "all three conditions met", over: {}, owed: true },
      { why: "no PR", over: { pr_url: null }, owed: false },
      { why: "a doc-only task (open_pr = 0)", over: { open_pr: 0 }, owed: false },
      { why: "a repo that is not JIRA-enabled", over: { repo: "/repos/other" }, owed: false },
    ] as const) {
      expect(shouldHaveJiraTicket(task(over as never), ENV.enabledRepos), why).toBe(owed);
    }
  });
});
