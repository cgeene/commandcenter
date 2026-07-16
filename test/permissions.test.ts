import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-permissions-"));
  process.env.CC_DATA_DIR = tmpDir;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Verbs that mutate state when they lead an MCP tool name (Atlassian/Slack
// name their mutating tools this way: createConfluencePage, addWorklogToJiraIssue,
// transitionJiraIssue, slack_send_message, ...). Checked as a PREFIX of the tool
// name, not a substring — a substring check would false-positive on read tools
// like getTransitionsForJiraIssue (lists transitions, doesn't execute one).
const MUTATING_VERB_PREFIXES = [
  "create",
  "update",
  "delete",
  "edit",
  "transition",
  "add",
  "send",
  "schedule",
  "write",
  "remove",
  "put",
  "post",
];

// Substrings that would indicate a mutating Bash command snuck into the profile.
const DANGEROUS_BASH_SUBSTRINGS = [
  "apply",
  "delete",
  "install",
  "uninstall",
  "upgrade",
  "destroy",
  "terraform",
  "push",
  "commit",
  "drop",
  "truncate",
];

describe("READ_ONLY_PROFILE", () => {
  it("contains the expected Atlassian, Slack, and Bash read patterns", async () => {
    const { READ_ONLY_PROFILE } = await import("../src/daemon/permissions.js");
    expect(READ_ONLY_PROFILE).toContain("mcp__claude_ai_Atlassian__getConfluencePage*");
    expect(READ_ONLY_PROFILE).toContain("mcp__claude_ai_Atlassian__getJiraIssue*");
    expect(READ_ONLY_PROFILE).toContain("mcp__claude_ai_Atlassian__search*");
    expect(READ_ONLY_PROFILE).toContain("mcp__claude_ai_Slack__slack_read_*");
    expect(READ_ONLY_PROFILE).toContain("mcp__claude_ai_Slack__slack_search_*");
    expect(READ_ONLY_PROFILE).toContain("Bash(kubectl get*)");
    expect(READ_ONLY_PROFILE).toContain("Bash(kubectl describe*)");
    expect(READ_ONLY_PROFILE).toContain("Bash(git log*)");
    expect(READ_ONLY_PROFILE).toContain("Bash(git show*)");
    expect(READ_ONLY_PROFILE).toContain("Bash(git diff*)");
    expect(READ_ONLY_PROFILE).toContain("Bash(bq query --dry_run*)");
  });

  it("never allows plain `bq query` without --dry_run", async () => {
    const { READ_ONLY_PROFILE } = await import("../src/daemon/permissions.js");
    const bqEntries = READ_ONLY_PROFILE.filter((p) => p.includes("bq "));
    for (const entry of bqEntries) {
      if (entry.includes("bq query")) expect(entry).toContain("--dry_run");
    }
  });

  it("contains no MCP tool whose name starts with a mutating verb", async () => {
    const { READ_ONLY_PROFILE } = await import("../src/daemon/permissions.js");
    const mcpEntries = READ_ONLY_PROFILE.filter((p) => p.startsWith("mcp__"));
    expect(mcpEntries.length).toBeGreaterThan(0);
    for (const entry of mcpEntries) {
      const toolName = entry.split("__").pop() ?? entry;
      const bare = toolName.replace(/\*$/, "").toLowerCase();
      for (const verb of MUTATING_VERB_PREFIXES) {
        expect(
          bare.startsWith(verb),
          `"${entry}" looks state-changing (tool name starts with "${verb}")`,
        ).toBe(false);
      }
    }
  });

  it("contains no mutating Bash command", async () => {
    const { READ_ONLY_PROFILE } = await import("../src/daemon/permissions.js");
    const bashEntries = READ_ONLY_PROFILE.filter((p) => p.startsWith("Bash("));
    for (const entry of bashEntries) {
      const lower = entry.toLowerCase();
      for (const bad of DANGEROUS_BASH_SUBSTRINGS) {
        expect(lower, `"${entry}" looks state-changing (matched "${bad}")`).not.toContain(bad);
      }
    }
  });

  it("scopes every Bash entry to a specific read-only command, not a bare wildcard", async () => {
    const { READ_ONLY_PROFILE } = await import("../src/daemon/permissions.js");
    const bashEntries = READ_ONLY_PROFILE.filter((p) => p.startsWith("Bash("));
    expect(bashEntries.length).toBeGreaterThan(0);
    for (const entry of bashEntries) {
      expect(entry).not.toBe("Bash(*)");
    }
  });
});

describe("spawn.ts allow-list builders", () => {
  it("reviewer settings contain the full read-only profile", async () => {
    const { _buildReviewerAllowForTest } = await import("../src/daemon/spawn.js");
    const { READ_ONLY_PROFILE } = await import("../src/daemon/permissions.js");
    const { createTask } = await import("../src/db/tasks.js");
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    const allow = _buildReviewerAllowForTest(task);
    for (const entry of READ_ONLY_PROFILE) expect(allow).toContain(entry);
  });

  it("reviewer settings add the task's verify_cmd but nothing state-changing", async () => {
    const { _buildReviewerAllowForTest } = await import("../src/daemon/spawn.js");
    const { createTask } = await import("../src/db/tasks.js");
    const task = createTask({ title: "t", prompt: "x", repo: "/r", verify_cmd: "npm test" });
    const allow = _buildReviewerAllowForTest(task);
    expect(allow).toContain("Bash(npm test)");
    expect(allow).not.toContain("Bash(git push*)");
    expect(allow).not.toContain("Bash(git commit*)");
  });

  it("worker settings contain the profile plus its own branch push/PR patterns", async () => {
    const { _buildWorkerAllowForTest } = await import("../src/daemon/spawn.js");
    const { READ_ONLY_PROFILE } = await import("../src/daemon/permissions.js");
    const allow = _buildWorkerAllowForTest("agent/task-42");
    for (const entry of READ_ONLY_PROFILE) expect(allow).toContain(entry);
    expect(allow).toContain("Bash(git push -u origin agent/task-42)");
    expect(allow).toContain("Bash(gh pr create*)");
  });

  it("worker allow-list picks up scheduler-config extra read-only patterns", async () => {
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    const { _buildWorkerAllowForTest } = await import("../src/daemon/spawn.js");
    setSchedulerConfig({ read_only_extra_allow: ["mcp__claude_ai_Linear__getIssue*"] });
    const allow = _buildWorkerAllowForTest("agent/task-1");
    expect(allow).toContain("mcp__claude_ai_Linear__getIssue*");
  });

  it("denies Git publishing for non-Git scratch workers", async () => {
    const { _buildWorkerDenyForTest } = await import("../src/daemon/spawn.js");
    const { createTask } = await import("../src/db/tasks.js");
    const scratch = createTask({
      title: "investigate",
      prompt: "x",
      repo: "/tmp/scratch",
      workspace_kind: "scratch",
      open_pr: false,
    });
    const repo = createTask({ title: "implement", prompt: "x", repo: "/r" });

    expect(_buildWorkerDenyForTest(scratch)).toEqual(
      expect.arrayContaining(["Bash(git push*)", "Bash(gh pr create*)"]),
    );
    expect(_buildWorkerDenyForTest(repo)).toBeUndefined();
  });
});

describe("readOnlyProfileAllow", () => {
  it("equals READ_ONLY_PROFILE with no extra config", async () => {
    const { READ_ONLY_PROFILE, readOnlyProfileAllow } = await import(
      "../src/daemon/permissions.js"
    );
    expect(readOnlyProfileAllow()).toEqual([...READ_ONLY_PROFILE]);
  });

  it("appends read_only_extra_allow from scheduler config without a code change", async () => {
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    const { READ_ONLY_PROFILE, readOnlyProfileAllow } = await import(
      "../src/daemon/permissions.js"
    );
    setSchedulerConfig({
      read_only_extra_allow: ["mcp__claude_ai_Linear__getIssue*"],
    });
    const allow = readOnlyProfileAllow();
    expect(allow).toEqual([...READ_ONLY_PROFILE, "mcp__claude_ai_Linear__getIssue*"]);
  });
});
