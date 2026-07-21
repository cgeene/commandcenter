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

  it("reviewer settings allow the whole Bash tool so verify/build never stalls", async () => {
    const { _buildReviewerAllowForTest } = await import("../src/daemon/spawn.js");
    const { createTask } = await import("../src/db/tasks.js");
    // Any verify_cmd (even a compound one) runs under the blanket Bash allow —
    // no need to allow-list the exact command string.
    const task = createTask({
      title: "t",
      prompt: "x",
      repo: "/r",
      verify_cmd: "npm install && npm run build && npm test",
    });
    const allow = _buildReviewerAllowForTest(task);
    expect(allow).toContain("Bash");
  });

  it("reviewer edits and Git publishing are denied", async () => {
    const { _buildReviewerDenyForTest } = await import("../src/daemon/spawn.js");
    const deny = _buildReviewerDenyForTest();
    expect(deny).toEqual(
      expect.arrayContaining([
        "Edit",
        "Write",
        "NotebookEdit",
        "Bash(git commit*)",
        "Bash(git push*)",
        "Bash(sudo *)",
        "Bash(gh pr merge*)",
      ]),
    );
  });

  it("worker settings allow the Bash tool plus editing tools and its branch push", async () => {
    const { _buildWorkerAllowForTest } = await import("../src/daemon/spawn.js");
    const { READ_ONLY_PROFILE } = await import("../src/daemon/permissions.js");
    const allow = _buildWorkerAllowForTest("agent/task-42");
    for (const entry of READ_ONLY_PROFILE) expect(allow).toContain(entry);
    // Blanket Bash allow: env-var-prefixed / compound build+test never prompt.
    expect(allow).toContain("Bash");
    // Editing tools must be allow-listed explicitly under dontAsk (baseline
    // denies), or the worker could not edit files.
    expect(allow).toEqual(expect.arrayContaining(["Read", "Edit", "Write", "NotebookEdit"]));
    expect(allow).toContain("Bash(git push -u origin agent/task-42)");
    expect(allow).toContain("Bash(gh pr create*)");
  });

  it("scratch workers (no branch) get no push/PR allow entries", async () => {
    const { _buildWorkerAllowForTest } = await import("../src/daemon/spawn.js");
    const allow = _buildWorkerAllowForTest(null);
    expect(allow).toContain("Bash");
    expect(allow).not.toContain("Bash(gh pr create*)");
    expect(allow.some((entry) => entry.startsWith("Bash(git push"))).toBe(false);
  });

  it("worker allow-list picks up scheduler-config extra read-only patterns", async () => {
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    const { _buildWorkerAllowForTest } = await import("../src/daemon/spawn.js");
    setSchedulerConfig({ read_only_extra_allow: ["mcp__claude_ai_Linear__getIssue*"] });
    const allow = _buildWorkerAllowForTest("agent/task-1");
    expect(allow).toContain("mcp__claude_ai_Linear__getIssue*");
  });

  it("worker deny always guards the dangerous commands, plus publishing for scratch", async () => {
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

    // Every worker (Git or scratch) blocks sudo / rm -rf / gh pr merge / repo delete.
    for (const deny of [_buildWorkerDenyForTest(scratch), _buildWorkerDenyForTest(repo)]) {
      expect(deny).toEqual(
        expect.arrayContaining([
          "Bash(sudo *)",
          "Bash(rm -rf /*)",
          "Bash(gh pr merge*)",
          "Bash(gh repo delete*)",
        ]),
      );
    }
    // Scratch additionally denies all Git publishing (it has no branch).
    expect(_buildWorkerDenyForTest(scratch)).toEqual(
      expect.arrayContaining(["Bash(git push*)", "Bash(gh pr create*)"]),
    );
    // A Git worker must still be able to commit/push its own branch.
    expect(_buildWorkerDenyForTest(repo)).not.toContain("Bash(git push*)");
    expect(_buildWorkerDenyForTest(repo)).not.toContain("Bash(git commit*)");
  });

  it("worker ask routes force-pushes and main pushes to a prompt, not the own branch", async () => {
    const { _buildWorkerAskForTest } = await import("../src/daemon/spawn.js");
    const { createTask } = await import("../src/db/tasks.js");
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    const ask = _buildWorkerAskForTest(task);
    expect(ask).toEqual(
      expect.arrayContaining([
        "Bash(git push --force*)",
        "Bash(git push -f*)",
        "Bash(git push origin main*)",
      ]),
    );
    // The own-branch push must not be forced to prompt.
    expect(ask).not.toContain("Bash(git push -u origin agent/task-1)");
  });
});

describe("writeSettingsFile", () => {
  it("serializes defaultMode, ask, deny, and the mcp__cc allow prefix", async () => {
    const { writeSettingsFile } = await import("../src/daemon/genconfig.js");
    const file = writeSettingsFile("task-99", 7, {
      defaultMode: "dontAsk",
      allow: ["Bash", "Read"],
      deny: ["Bash(sudo *)"],
      ask: ["Bash(git push --force*)"],
    });
    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(written.permissions.defaultMode).toBe("dontAsk");
    expect(written.permissions.allow).toEqual(["mcp__cc", "Bash", "Read"]);
    expect(written.permissions.deny).toEqual(["Bash(sudo *)"]);
    expect(written.permissions.ask).toEqual(["Bash(git push --force*)"]);
  });

  it("omits defaultMode/deny/ask when not provided (main agent stays on prompt baseline)", async () => {
    const { writeSettingsFile } = await import("../src/daemon/genconfig.js");
    const file = writeSettingsFile("main", 2);
    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(written.permissions.defaultMode).toBeUndefined();
    expect(written.permissions.ask).toBeUndefined();
    expect(written.permissions.deny).toBeUndefined();
    expect(written.permissions.allow).toEqual(["mcp__cc"]);
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
