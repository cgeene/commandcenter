import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The opt-in strict-serial repo gate and the integration briefs. Default policy
 * is parallel work in one repo, so every gate assertion here is paired with the
 * default-off case.
 */

vi.mock("../src/daemon/tmux.js", () => ({
  windowExists: () => true,
  sendText: async () => {},
  capturePane: () => "",
  newWindow: () => "cc:1",
  killWindow: () => {},
  paneProcess: () => null,
  listWindows: () => ({ live: [], dead: [], server: "running" }),
  probeWindow: () => "absent" as const,
}));

let tmpDir: string;
const repo = "/repos/commandcenter";

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-serial-"));
  process.env.CC_DATA_DIR = tmpDir;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const view = (over: Record<string, unknown> = {}) => ({
  id: 1,
  repo,
  status: "queued",
  branch: null,
  pr_url: null,
  pr_state: null,
  open_pr: 1,
  workspace_kind: "repo",
  ...over,
});

describe("repoIsStrictSerial", () => {
  it("matches a configured repo regardless of trailing slashes, and nothing by default", async () => {
    const { repoIsStrictSerial } = await import("../src/lib/integration.js");
    expect(repoIsStrictSerial(repo, [])).toBe(false);
    expect(repoIsStrictSerial(repo, [`${repo}/`])).toBe(true);
    expect(repoIsStrictSerial(`${repo}/`, [repo])).toBe(true);
    expect(repoIsStrictSerial(repo, ["/repos/other"])).toBe(false);
  });
});

describe("serialRepoHolder", () => {
  it("counts an actively-worked task and an open agent PR, but never the candidate itself", async () => {
    const { serialRepoHolder } = await import("../src/lib/integration.js");
    const candidate = view({ id: 10 });

    expect(serialRepoHolder(candidate, [candidate])).toBeUndefined();
    expect(
      serialRepoHolder(candidate, [candidate, view({ id: 2, status: "queued" })]),
    ).toBeUndefined(); // a queued task holds nothing
    expect(
      serialRepoHolder(candidate, [view({ id: 2, status: "in_progress" })])?.id,
    ).toBe(2);
    expect(serialRepoHolder(candidate, [view({ id: 2, status: "review" })])?.id).toBe(2);
    // Done, but its PR is still open — that PR is exactly what would conflict.
    expect(
      serialRepoHolder(candidate, [
        view({
          id: 3,
          status: "done",
          branch: "agent/task-3",
          pr_url: "https://github.com/o/r/pull/3",
          pr_state: "open",
        }),
      ])?.id,
    ).toBe(3);
    // A merged PR, another repo, and a scratch task all release the repo.
    expect(
      serialRepoHolder(candidate, [
        view({
          id: 4,
          status: "done",
          branch: "agent/task-4",
          pr_url: "https://github.com/o/r/pull/4",
          pr_state: "merged",
        }),
        view({ id: 5, status: "in_progress", repo: "/repos/other" }),
        view({ id: 6, status: "in_progress", workspace_kind: "scratch" }),
      ]),
    ).toBeUndefined();
  });
});

describe("dispatchableTasks", () => {
  it("hides a ready task while a strict-serial repo is busy, and nothing when unconfigured", async () => {
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const { setIntegrationSettings } = await import("../src/db/settings.js");
    const { dispatchableTasks } = await import("../src/daemon/serial.js");
    const active = createTask({ title: "a", prompt: "x", repo });
    const waiting = createTask({ title: "b", prompt: "x", repo });
    const elsewhere = createTask({ title: "c", prompt: "x", repo: "/repos/other" });
    updateTask(active.id, { status: "in_progress" });

    // Default: parallel work in one repo is allowed.
    expect(dispatchableTasks().map((t) => t.id)).toEqual([waiting.id, elsewhere.id]);

    setIntegrationSettings({ strict_serial_repos: [repo] });
    expect(dispatchableTasks().map((t) => t.id)).toEqual([elsewhere.id]);

    // Once the holder finishes (and has no open PR) the queue moves again.
    updateTask(active.id, { status: "done" });
    expect(dispatchableTasks().map((t) => t.id)).toEqual([waiting.id, elsewhere.id]);
  });
});

describe("spawnWorker under a strict-serial repo", () => {
  it("refuses the spawn and leaves the task queued, but never gates the holder itself", async () => {
    const { createTask, getTask, updateTask } = await import("../src/db/tasks.js");
    const { setIntegrationSettings } = await import("../src/db/settings.js");
    const { spawnWorker } = await import("../src/daemon/spawn.js");
    const active = createTask({ title: "a", prompt: "x", repo });
    const waiting = createTask({ title: "b", prompt: "x", repo });
    updateTask(active.id, { status: "in_progress" });
    setIntegrationSettings({ strict_serial_repos: [repo] });

    expect(() => spawnWorker(waiting.id)).toThrow(/strict-serial/);
    expect(getTask(waiting.id)!.status).toBe("queued"); // never claimed

    // The holder's own respawn is not blocked by its own occupancy: it fails
    // later, on the real work (this repo path does not exist), not on the gate.
    updateTask(active.id, { status: "queued", agent_id: null });
    expect(() => spawnWorker(active.id)).not.toThrow(/strict-serial/);
  });

  it("does not gate anything when no repo is configured", async () => {
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const { spawnWorker } = await import("../src/daemon/spawn.js");
    const active = createTask({ title: "a", prompt: "x", repo });
    const waiting = createTask({ title: "b", prompt: "x", repo });
    updateTask(active.id, { status: "in_progress" });

    expect(() => spawnWorker(waiting.id)).not.toThrow(/strict-serial/);
  });
});

describe("integration settings", () => {
  it("defaults to freshening on, serialization off, and sanitizes a bad stored group", async () => {
    const { getIntegrationSettings, setIntegrationSettings } = await import(
      "../src/db/settings.js"
    );
    expect(getIntegrationSettings()).toEqual({
      auto_freshen: true,
      freshen_max_attempts: 3,
      freshen_per_pass_limit: 2,
      strict_serial_repos: [],
      merge_nudge_minutes: 120,
    });

    setIntegrationSettings({
      freshen_max_attempts: 0, // out of range -> default
      freshen_per_pass_limit: 5,
      strict_serial_repos: ["", "  ", repo],
      merge_nudge_minutes: null,
    });
    expect(getIntegrationSettings()).toMatchObject({
      freshen_max_attempts: 3,
      freshen_per_pass_limit: 5,
      strict_serial_repos: [repo],
      merge_nudge_minutes: null,
    });
  });
});

describe("integration briefs", () => {
  const base = {
    taskId: 184,
    branch: "agent/task-184",
    defaultBranch: "main",
    prUrl: "https://github.com/o/r/pull/9",
    resultSummary: "added the freshener",
    verifyCmd: "npm test",
    round: 2,
  };

  it("tells the worker not to redo the task, to merge (not rebase), and to push the same branch", async () => {
    const { conflictBrief } = await import("../src/lib/integration.js");
    const brief = conflictBrief({ ...base, conflictPaths: ["src/a.ts", "src/b.ts"] });
    expect(brief).toContain("Integration fix round 2");
    expect(brief).toContain("ALREADY COMPLETE");
    expect(brief).toContain("git merge origin/main");
    expect(brief).toContain("never a rebase");
    expect(brief).toContain("keeping BOTH sides' intent");
    expect(brief).toContain("`src/a.ts`, `src/b.ts`");
    expect(brief).toContain("git push origin agent/task-184");
    expect(brief).toContain("Never force-push");
    expect(brief).toContain("npm test");
    expect(brief).toContain("added the freshener");
    expect(brief).toContain("report_blocked");
    expect(brief).not.toContain("rebase origin/main");
  });

  it("explains a clean merge that broke verification, with the failing output", async () => {
    const { verifyFailBrief } = await import("../src/lib/integration.js");
    const brief = verifyFailBrief({ ...base, output: "FAIL src/a.test.ts" });
    expect(brief).toContain("still merges cleanly");
    expect(brief).toContain("verification FAILED");
    expect(brief).toContain("FAIL src/a.test.ts");
    expect(brief).toContain("pushed nothing");
  });

  it("falls back gracefully when there is no summary, no PR, and no verify command", async () => {
    const { conflictBrief } = await import("../src/lib/integration.js");
    const brief = conflictBrief({
      ...base,
      prUrl: null,
      resultSummary: null,
      verifyCmd: null,
      conflictPaths: [],
    });
    expect(brief).toContain("no result summary");
    expect(brief).toContain("build/typecheck/tests");
    expect(brief).toContain("git did not report specific paths");
  });
});
