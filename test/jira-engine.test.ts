import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JiraRawResponse, JiraRunner } from "../src/daemon/jira.js";

let tmpDir: string;
const ENV_KEYS = ["CC_JIRA_BASE_URL", "CC_JIRA_EMAIL", "CC_JIRA_TOKEN"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-jira-eng-")));
  process.env.CC_DATA_DIR = path.join(tmpDir, "data");
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  // Engine requires a token to run at all (fail-closed). The injected client
  // means no real HTTP happens, so a dummy is safe.
  process.env.CC_JIRA_TOKEN = "dummy-token";
  process.env.CC_JIRA_EMAIL = "bot@nylas.com";
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  const { _resetJiraSyncState } = await import("../src/daemon/jirasync.js");
  _resetJiraSyncState();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  const { _resetJiraSyncState } = await import("../src/daemon/jirasync.js");
  _resetJiraSyncState();
  const { _setClassifierRunner } = await import("../src/daemon/jiraclassify.js");
  _setClassifierRunner(null);
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ---- In-memory fake JIRA instance backing a JiraClient runner ---- */

const CATEGORY: Record<string, string> = {
  open: "new",
  "in progress": "indeterminate",
  merged: "indeterminate",
  done: "done",
  "will not do": "done",
};
const TARGET_ID: Record<string, string> = {
  "In Progress": "41",
  Merged: "42",
  Done: "251",
  "Will not do": "71",
};

interface FakeOpts {
  /** Status names the workflow offers a transition to (default: all). */
  offeredTargets?: string[];
  /** Make GET /issue fail (500) — to exercise create's key-persist-first. */
  getIssueError?: boolean;
  /** Target status names whose POST /transitions returns 400 even though
   *  GET /transitions offers them — models a hasScreen required-field reject. */
  failTransitionTo?: string[];
}

class FakeJira {
  issues = new Map<string, { name: string; category: string }>();
  comments = new Map<string, string[]>();
  createCount = 0;
  transitionCount = 0;
  private seq = 0;
  private offered: string[];
  private getIssueError: boolean;
  private failTransitionTo: string[];

  constructor(opts: FakeOpts = {}) {
    this.offered = opts.offeredTargets ?? ["In Progress", "Merged", "Done", "Will not do"];
    this.getIssueError = opts.getIssueError ?? false;
    this.failTransitionTo = opts.failTransitionTo ?? [];
  }

  /** Seed an already-existing ticket at a given status. */
  seed(key: string, statusName: string): void {
    this.issues.set(key, { name: statusName, category: CATEGORY[statusName.toLowerCase()] ?? "new" });
  }

  runner: JiraRunner = async (req): Promise<JiraRawResponse> => {
    const j = (status: number, body: unknown = {}): JiraRawResponse => ({
      status,
      headers: {},
      body: JSON.stringify(body),
    });
    const [rawPath] = req.path.split("?");
    const m = /^\/rest\/api\/3\/issue(?:\/([^/]+))?(\/transitions|\/comment)?$/.exec(rawPath);

    // POST /issue (create)
    if (rawPath === "/rest/api/3/issue" && req.method === "POST") {
      this.createCount++;
      const key = `EN-${++this.seq}`;
      this.issues.set(key, { name: "Open", category: "new" });
      return j(201, { key });
    }
    if (!m || !m[1]) return j(404, { error: "not found" });
    const key = m[1];
    const sub = m[2];
    const issue = this.issues.get(key);
    if (!issue) return j(404, { error: "no issue" });

    if (!sub && req.method === "GET") {
      if (this.getIssueError) return j(500, { error: "boom" });
      return j(200, {
        fields: {
          status: { name: issue.name, statusCategory: { key: issue.category } },
          assignee: null,
        },
      });
    }
    if (sub === "/transitions" && req.method === "GET") {
      const transitions = this.offered.map((name) => ({
        id: TARGET_ID[name],
        name,
        to: { name, statusCategory: { key: CATEGORY[name.toLowerCase()] } },
      }));
      return j(200, { transitions });
    }
    if (sub === "/transitions" && req.method === "POST") {
      const id = (req.body as { transition: { id: string } }).transition.id;
      const name = Object.keys(TARGET_ID).find((n) => TARGET_ID[n] === id);
      // hasScreen reject: the transition is offered but the POST 400s on a
      // required screen field. The issue status does NOT change.
      if (name && this.failTransitionTo.includes(name)) {
        return j(400, { errorMessages: ["Field 'resolution' is required."] });
      }
      if (name) {
        this.transitionCount++;
        this.issues.set(key, { name, category: CATEGORY[name.toLowerCase()] });
      }
      return j(204);
    }
    if (sub === "/comment" && req.method === "POST") {
      const list = this.comments.get(key) ?? [];
      list.push(JSON.stringify(req.body));
      this.comments.set(key, list);
      return j(201, {});
    }
    return j(400, { error: "unhandled" });
  };
}

async function enableRepo(repo: string, extra: Record<string, unknown> = {}) {
  const { setJiraConfig } = await import("../src/db/settings.js");
  setJiraConfig({
    enabled: true,
    repos: { [repo]: { enabled: true, project: "EN", ...extra } },
  });
}

async function useFake(fake: FakeJira) {
  const { JiraClient } = await import("../src/daemon/jira.js");
  const { _setJiraClient } = await import("../src/daemon/jirasync.js");
  _setJiraClient(new JiraClient({ runner: fake.runner, sleep: async () => {}, maxRetries: 0 }));
}

describe("create path", () => {
  it("creates a ticket once, persists jira_key BEFORE anything downstream, drives In Progress", async () => {
    const { createTask, updateTask, getTask } = await import("../src/db/tasks.js");
    const t = createTask({ title: "do X", prompt: "please do X", repo: "/repo" });
    updateTask(t.id, { pr_url: "https://github.com/o/r/pull/1", status: "review" });
    await enableRepo("/repo");
    const fake = new FakeJira();
    await useFake(fake);

    const { jiraSyncPass } = await import("../src/daemon/jirasync.js");
    await jiraSyncPass();

    const after = getTask(t.id)!;
    expect(after.jira_key).toBe("EN-1");
    expect(after.jira_project).toBe("EN");
    expect(fake.createCount).toBe(1);
    // Initial transition landed: In Progress cached.
    expect(after.jira_state).toBe("in progress");
    expect(after.jira_status_category).toBe("indeterminate");
  });

  it("never re-creates a ticket once jira_key is set (idempotency guard)", async () => {
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const t = createTask({ title: "t", prompt: "p", repo: "/repo" });
    updateTask(t.id, { pr_url: "https://github.com/o/r/pull/1", status: "review" });
    await enableRepo("/repo");
    const fake = new FakeJira();
    await useFake(fake);
    const { jiraSyncPass } = await import("../src/daemon/jirasync.js");
    await jiraSyncPass();
    await jiraSyncPass();
    await jiraSyncPass();
    expect(fake.createCount).toBe(1);
  });

  it("persists the key even when the downstream getIssue fails — no duplicate on the next pass", async () => {
    const { createTask, updateTask, getTask } = await import("../src/db/tasks.js");
    const t = createTask({ title: "t", prompt: "p", repo: "/repo" });
    updateTask(t.id, { pr_url: "https://github.com/o/r/pull/1", status: "review" });
    await enableRepo("/repo");
    const fake = new FakeJira({ getIssueError: true });
    await useFake(fake);
    const { jiraSyncPass } = await import("../src/daemon/jirasync.js");
    await jiraSyncPass(); // create ok, downstream getIssue 500s
    const after = getTask(t.id)!;
    expect(after.jira_key).toBe("EN-1"); // key survived the downstream failure
    expect(after.jira_sync_fails).toBe(1); // the failure was recorded
    await jiraSyncPass();
    expect(fake.createCount).toBe(1); // still only ever created once
  });
});

describe("transition mapping (sync path)", () => {
  async function seedTicket(status: string, statusName = "In Progress") {
    await enableRepo("/repo"); // master switch on so jiraSyncPass runs
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const t = createTask({ title: "t", prompt: "p", repo: "/repo" });
    updateTask(t.id, {
      pr_url: "https://github.com/o/r/pull/1",
      jira_key: "EN-1",
      jira_project: "EN",
      jira_state: statusName.toLowerCase(),
      jira_status_category: CATEGORY[statusName.toLowerCase()],
      status: status as never,
    });
    return t.id;
  }

  it("task done → Done", async () => {
    const id = await seedTicket("done");
    const { updateTask, getTask } = await import("../src/db/tasks.js");
    updateTask(id, { status: "done" });
    const fake = new FakeJira();
    fake.seed("EN-1", "In Progress");
    await useFake(fake);
    const { jiraSyncPass } = await import("../src/daemon/jirasync.js");
    await jiraSyncPass();
    expect(fake.issues.get("EN-1")!.name).toBe("Done");
    expect(getTask(id)!.jira_state).toBe("done");
  });

  it("PR merged → Merged", async () => {
    const id = await seedTicket("review");
    const { updateTask } = await import("../src/db/tasks.js");
    updateTask(id, { pr_state: "merged" });
    const fake = new FakeJira();
    fake.seed("EN-1", "In Progress");
    await useFake(fake);
    const { jiraSyncPass } = await import("../src/daemon/jirasync.js");
    await jiraSyncPass();
    expect(fake.issues.get("EN-1")!.name).toBe("Merged");
  });

  it("PR merged → Done when the project has no Merged state (fallback)", async () => {
    const id = await seedTicket("review");
    const { updateTask } = await import("../src/db/tasks.js");
    updateTask(id, { pr_state: "merged" });
    const fake = new FakeJira({ offeredTargets: ["In Progress", "Done", "Will not do"] });
    fake.seed("EN-1", "In Progress");
    await useFake(fake);
    const { jiraSyncPass } = await import("../src/daemon/jirasync.js");
    await jiraSyncPass();
    expect(fake.issues.get("EN-1")!.name).toBe("Done");
  });

  it("PR closed unmerged → comment only, no transition, and never re-comments", async () => {
    const id = await seedTicket("blocked");
    const { updateTask } = await import("../src/db/tasks.js");
    updateTask(id, { pr_state: "closed", status: "blocked" });
    const fake = new FakeJira();
    fake.seed("EN-1", "In Progress");
    await useFake(fake);
    const { jiraSyncPass } = await import("../src/daemon/jirasync.js");
    await jiraSyncPass();
    await jiraSyncPass(); // second pass must not double-comment
    expect(fake.transitionCount).toBe(0); // never transitioned
    expect(fake.issues.get("EN-1")!.name).toBe("In Progress"); // left as-is
    expect(fake.comments.get("EN-1")!.length).toBe(1); // exactly one comment
  });

  it("task cancelled → Will not do", async () => {
    const id = await seedTicket("cancelled");
    const { updateTask } = await import("../src/db/tasks.js");
    updateTask(id, { status: "cancelled" });
    const fake = new FakeJira();
    fake.seed("EN-1", "In Progress");
    await useFake(fake);
    const { jiraSyncPass } = await import("../src/daemon/jirasync.js");
    await jiraSyncPass();
    expect(fake.issues.get("EN-1")!.name).toBe("Will not do");
  });

  it("task cancelled degrades to a comment when Will not do is unavailable", async () => {
    const id = await seedTicket("cancelled");
    const { updateTask } = await import("../src/db/tasks.js");
    updateTask(id, { status: "cancelled" });
    const fake = new FakeJira({ offeredTargets: ["In Progress", "Merged", "Done"] });
    fake.seed("EN-1", "In Progress");
    await useFake(fake);
    const { jiraSyncPass } = await import("../src/daemon/jirasync.js");
    await jiraSyncPass();
    expect(fake.transitionCount).toBe(0);
    expect(fake.comments.get("EN-1")!.length).toBe(1); // degraded to comment
  });

  it("task cancelled degrades to a comment when Will not do is OFFERED but the POST fails (hasScreen)", async () => {
    const id = await seedTicket("cancelled");
    const { updateTask, getTask } = await import("../src/db/tasks.js");
    updateTask(id, { status: "cancelled" });
    // "Will not do" IS offered by GET /transitions, but POST /transitions 400s —
    // the required-screen-field case that the not-offered test can't reach.
    const fake = new FakeJira({ failTransitionTo: ["Will not do"] });
    fake.seed("EN-1", "In Progress");
    await useFake(fake);
    const { jiraSyncPass, SYNC_FAIL_THRESHOLD } = await import("../src/daemon/jirasync.js");

    // Run several passes: must degrade to ONE comment, never crash, and never
    // build an unbounded failure streak (the 0→1 oscillation bug).
    await jiraSyncPass();
    await jiraSyncPass();
    await jiraSyncPass();
    await jiraSyncPass();

    expect(fake.transitionCount).toBe(0); // transition never landed
    expect(fake.issues.get("EN-1")!.name).toBe("In Progress"); // status unchanged
    expect(fake.comments.get("EN-1")!.length).toBe(1); // exactly one degrade comment
    // No hard sync-failure streak — the degrade path does NOT record a failure.
    const after = getTask(id)!;
    expect(after.jira_sync_fails).toBe(0);
    expect(after.jira_sync_fails).toBeLessThan(SYNC_FAIL_THRESHOLD);
  });

  it("don't-clobber: never moves backward/sideways — In Progress target no-ops when already there", async () => {
    const id = await seedTicket("review");
    const { updateTask } = await import("../src/db/tasks.js");
    updateTask(id, { pr_state: "open" });
    const fake = new FakeJira();
    fake.seed("EN-1", "In Progress"); // already In Progress
    await useFake(fake);
    const { jiraSyncPass } = await import("../src/daemon/jirasync.js");
    await jiraSyncPass();
    expect(fake.transitionCount).toBe(0);
  });

  it("don't-clobber: a merged PR won't drag a human-advanced Merged ticket back", async () => {
    const id = await seedTicket("review", "Merged");
    const { updateTask } = await import("../src/db/tasks.js");
    updateTask(id, { pr_state: "merged" });
    const fake = new FakeJira();
    fake.seed("EN-1", "Merged"); // human already at Merged
    await useFake(fake);
    const { jiraSyncPass } = await import("../src/daemon/jirasync.js");
    await jiraSyncPass();
    expect(fake.transitionCount).toBe(0); // Merged target == current rank → no-op
  });
});

describe("sync failure streak + escalate-once", () => {
  it("increments the streak and pages exactly once at the threshold", async () => {
    const { createTask, updateTask, getTask } = await import("../src/db/tasks.js");
    const t = createTask({ title: "t", prompt: "p", repo: "/repo" });
    updateTask(t.id, { jira_key: "EN-1", jira_project: "EN" });
    await enableRepo("/repo");
    // Fake with no matching issue → getIssue 404 every pass.
    const fake = new FakeJira();
    await useFake(fake);
    const { jiraSyncPass, SYNC_FAIL_THRESHOLD } = await import("../src/daemon/jirasync.js");
    const { listEvents } = await import("../src/db/events.js");

    for (let i = 0; i < SYNC_FAIL_THRESHOLD; i++) await jiraSyncPass();

    expect(getTask(t.id)!.jira_sync_fails).toBe(SYNC_FAIL_THRESHOLD);
    const events = listEvents();
    expect(events.filter((e) => e.kind === "jira.sync_error").length).toBe(1); // logged once at streak start
    expect(events.filter((e) => e.kind === "jira.sync_broken").length).toBe(1); // paged once at threshold
  });
});

describe("recordJiraSyncSuccess clears the streak", () => {
  it("resets jira_sync_fails to 0 on a good sync", async () => {
    const { createTask, updateTask, getTask } = await import("../src/db/tasks.js");
    const t = createTask({ title: "t", prompt: "p", repo: "/repo" });
    updateTask(t.id, { jira_sync_fails: 2 });
    const { recordJiraSyncSuccess } = await import("../src/daemon/jirasync.js");
    recordJiraSyncSuccess(t.id, { state: "in progress", category: "indeterminate" });
    const after = getTask(t.id)!;
    expect(after.jira_sync_fails).toBe(0);
    expect(after.jira_state).toBe("in progress");
    expect(after.jira_synced_at).toBeTruthy();
  });
});
