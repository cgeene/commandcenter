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
  const { _setGhRunner } = await import("../src/daemon/prdraft.js");
  _setGhRunner(null);
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
  transitionCount = 0; // successful transitions only
  transitionAttempts = 0; // every POST /transitions, incl. ones that 400
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
      this.transitionAttempts++;
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
  // Default in-memory `gh` so create/reconcile retitles never shell out. Tests
  // that inspect titles install their own via useGh() AFTER useFake().
  const { _setGhRunner } = await import("../src/daemon/prdraft.js");
  _setGhRunner(async (args) => (args[1] === "view" ? "feat: do X\n" : ""));
}

/* ---- In-memory fake `gh` for PR-title enforcement ---- */

interface FakeGh {
  /** prUrl → current PR title. */
  titles: Map<string, string>;
  /** Every `gh pr edit ... --title` call, in order. */
  edits: string[][];
  /** When true, every gh invocation throws (models a broken `gh`). */
  fail?: boolean;
}

async function useGh(gh: FakeGh) {
  const { _setGhRunner } = await import("../src/daemon/prdraft.js");
  _setGhRunner(async (args) => {
    if (gh.fail) throw new Error("gh boom");
    if (args[1] === "view") {
      const url = args[2];
      return `${gh.titles.get(url) ?? "feat: do X"}\n`;
    }
    if (args[1] === "edit") {
      const [, , url, , title] = args;
      gh.titles.set(url, title);
      gh.edits.push(args);
    }
    return "";
  });
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

describe("PR-title enforcement (create → retitle + reconciler)", () => {
  const URL = "https://github.com/o/r/pull/1";

  it("retitles the PR to the bracketed [KEY-N] form after creating the ticket", async () => {
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const t = createTask({ title: "do X", prompt: "p", repo: "/repo" });
    updateTask(t.id, { pr_url: URL, status: "review" });
    await enableRepo("/repo");
    await useFake(new FakeJira());
    const gh: FakeGh = { titles: new Map([[URL, "feat: do X"]]), edits: [] };
    await useGh(gh);

    const { jiraSyncPass } = await import("../src/daemon/jirasync.js");
    await jiraSyncPass();

    expect(gh.titles.get(URL)).toBe("[EN-1] feat: do X");
    expect(gh.edits.length).toBe(1);
  });

  it("a failing retitle records a sync failure but NEVER re-creates the ticket", async () => {
    const { createTask, updateTask, getTask } = await import("../src/db/tasks.js");
    const t = createTask({ title: "t", prompt: "p", repo: "/repo" });
    updateTask(t.id, { pr_url: URL, status: "review" });
    await enableRepo("/repo");
    const fake = new FakeJira();
    await useFake(fake);
    await useGh({ titles: new Map(), edits: [], fail: true });

    const { jiraSyncPass } = await import("../src/daemon/jirasync.js");
    await jiraSyncPass(); // create + persist key OK; retitle throws
    const afterFirst = getTask(t.id)!;
    expect(afterFirst.jira_key).toBe("EN-1"); // key persisted before the retitle
    expect(afterFirst.jira_sync_fails).toBe(1); // retitle failure recorded

    await jiraSyncPass(); // reconciler retries the retitle (still failing)
    expect(fake.createCount).toBe(1); // key already set → create path never re-entered
    expect(getTask(t.id)!.jira_sync_fails).toBe(2); // streak accrues, no re-create
  });

  it("the reconciler heals a stale/wrong [KEY-N] title on a later pass, idempotently", async () => {
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const t = createTask({ title: "t", prompt: "p", repo: "/repo" });
    updateTask(t.id, {
      pr_url: URL,
      jira_key: "EN-1",
      jira_project: "EN",
      jira_state: "in progress",
      jira_status_category: "indeterminate",
      status: "review",
      pr_state: "open",
    });
    await enableRepo("/repo");
    const fake = new FakeJira();
    fake.seed("EN-1", "In Progress");
    await useFake(fake);
    // Title carries a WRONG key (e.g. left over from a prior ticket / human edit).
    const gh: FakeGh = { titles: new Map([[URL, "[EN-999] feat: do X"]]), edits: [] };
    await useGh(gh);

    const { jiraSyncPass } = await import("../src/daemon/jirasync.js");
    await jiraSyncPass();
    expect(gh.titles.get(URL)).toBe("[EN-1] feat: do X"); // healed to the real key
    expect(gh.edits.length).toBe(1);

    await jiraSyncPass(); // now correct → no further edit (idempotent)
    expect(gh.edits.length).toBe(1);
  });

  it("does not retitle a merged PR (historical title, never fails the pass)", async () => {
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const t = createTask({ title: "t", prompt: "p", repo: "/repo" });
    updateTask(t.id, {
      pr_url: URL,
      jira_key: "EN-1",
      jira_project: "EN",
      jira_state: "in progress",
      jira_status_category: "indeterminate",
      status: "review",
      pr_state: "merged",
    });
    await enableRepo("/repo");
    const fake = new FakeJira();
    fake.seed("EN-1", "In Progress");
    await useFake(fake);
    // gh is broken — proves the reconciler doesn't even call it for merged PRs.
    await useGh({ titles: new Map(), edits: [], fail: true });

    const { jiraSyncPass } = await import("../src/daemon/jirasync.js");
    await jiraSyncPass();
    const { getTask } = await import("../src/db/tasks.js");
    expect(getTask(t.id)!.jira_sync_fails).toBe(0); // gh never invoked → no failure
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

  it("task cancelled degrades to a comment when Will not do is OFFERED but the POST fails (hasScreen), exactly ONCE per run", async () => {
    const id = await seedTicket("cancelled");
    const { updateTask, getTask } = await import("../src/db/tasks.js");
    updateTask(id, { status: "cancelled" });
    // "Will not do" IS offered by GET /transitions, but POST /transitions 400s —
    // the required-screen-field case that the not-offered test can't reach.
    const fake = new FakeJira({ failTransitionTo: ["Will not do"] });
    fake.seed("EN-1", "In Progress");
    await useFake(fake);
    const { jiraSyncPass, SYNC_FAIL_THRESHOLD } = await import("../src/daemon/jirasync.js");
    const { listEvents } = await import("../src/db/events.js");

    // Run WELL PAST the threshold: the degraded ticket stays at "In Progress"
    // (non-terminal) so it keeps re-selecting from tasksNeedingJiraSync. The
    // failing transition POST and its jira.transition_failed log must NOT recur
    // every pass — that would be the spam-every-2-min the discipline forbids.
    const passes = SYNC_FAIL_THRESHOLD + 5;
    for (let i = 0; i < passes; i++) await jiraSyncPass();

    expect(fake.transitionCount).toBe(0); // transition never landed
    expect(fake.transitionAttempts).toBe(1); // POST /transitions attempted at most once
    expect(fake.issues.get("EN-1")!.name).toBe("In Progress"); // status unchanged
    expect(fake.comments.get("EN-1")!.length).toBe(1); // exactly one degrade comment
    // The degrade-only events fire at most once — no per-pass spam.
    const events = listEvents(500);
    expect(events.filter((e) => e.task_id === id && e.kind === "jira.transition_failed").length).toBe(1);
    expect(events.filter((e) => e.task_id === id && e.kind === "jira.commented").length).toBe(1);
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

  it("a persistently-failing FORWARD transition (Done hasScreen) accumulates the streak and pages once", async () => {
    // The general In Progress/Merged/Done path — not just Will not do. A project
    // whose "Done" transition has a required screen field 400s the POST every
    // pass. recordJiraSyncSuccess (streak clear) must run only AFTER the
    // consequence applies cleanly, so this streak reaches the threshold instead
    // of oscillating 0→1 forever and never paging (the reviewed regression).
    const { createTask, updateTask, getTask } = await import("../src/db/tasks.js");
    const t = createTask({ title: "t", prompt: "p", repo: "/repo" });
    updateTask(t.id, {
      jira_key: "EN-1",
      jira_project: "EN",
      jira_state: "in progress",
      jira_status_category: "indeterminate",
      status: "done", // → drives the Done transition
    });
    await enableRepo("/repo");
    // "Done" is offered by GET /transitions but its POST 400s (hasScreen).
    const fake = new FakeJira({ failTransitionTo: ["Done"] });
    fake.seed("EN-1", "In Progress");
    await useFake(fake);
    const { jiraSyncPass, SYNC_FAIL_THRESHOLD } = await import("../src/daemon/jirasync.js");
    const { listEvents } = await import("../src/db/events.js");

    const passes = SYNC_FAIL_THRESHOLD + 3; // run well past the threshold
    for (let i = 0; i < passes; i++) await jiraSyncPass();

    const after = getTask(t.id)!;
    expect(after.jira_sync_fails).toBeGreaterThanOrEqual(SYNC_FAIL_THRESHOLD);
    expect(after.jira_sync_fails).toBe(passes); // strictly monotonic — never reset
    expect(fake.transitionCount).toBe(0); // the transition never landed
    expect(fake.issues.get("EN-1")!.name).toBe("In Progress"); // stuck, not silently Done
    const events = listEvents();
    expect(events.filter((e) => e.kind === "jira.sync_error").length).toBe(1); // logged ONCE at streak start
    expect(events.filter((e) => e.kind === "jira.sync_broken").length).toBe(1); // paged ONCE at threshold
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
