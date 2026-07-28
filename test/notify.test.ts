import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The review-verdict tests build a real git repo, so they need the same
// generous budget as reviewloop.test.ts.
vi.setConfig({ testTimeout: 30_000 });

// The review loop must not try to open a tmux window for a reviewer.
const spawnReviewer = vi.fn((_taskId: number, _opts?: unknown) => ({
  agent: { id: 999 },
  task: {},
}));
vi.mock("../src/daemon/spawn.js", () => ({
  spawnReviewer: (id: number, opts?: unknown) => spawnReviewer(id, opts),
  killAgent: () => {},
}));

let tmpDir: string;
let fetchMock: ReturnType<typeof vi.fn>;
const realFetch = globalThis.fetch;

/** Every push dispatched since the last reset, in order. */
function pushes(): { title: string; message: string; priority: string }[] {
  return fetchMock.mock.calls.map((call) => {
    const init = call[1] as { body: string; headers: Record<string, string> };
    return {
      title: init.headers.Title,
      message: init.body,
      priority: init.headers.Priority,
    };
  });
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-notify-"));
  process.env.CC_DATA_DIR = tmpDir;
  process.env.CC_NTFY_URL = "https://ntfy.test/cc";
  delete process.env.CC_NTFY_TOKEN;
  fetchMock = vi.fn(async () => new Response("ok"));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  spawnReviewer.mockClear();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  globalThis.fetch = realFetch;
  delete process.env.CC_NTFY_URL;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  const { _setGhRunner } = await import("../src/daemon/prdraft.js");
  _setGhRunner(null);
  await new Promise((resolve) => setImmediate(resolve));
});

/* ------------------------------------------------------------------ *
 * The catalog: which events push out of the box.                      *
 * ------------------------------------------------------------------ */

describe("notification defaults", () => {
  it("pushes only the human-actionable + platform-health minimum", async () => {
    const { NOTIFY_EVENT_DEFAULTS, NOTIFY_EVENTS } = await import(
      "../src/notify-events.js"
    );
    const on = Object.entries(NOTIFY_EVENT_DEFAULTS)
      .filter(([, enabled]) => enabled)
      .map(([key]) => key)
      .sort();
    expect(on).toEqual(
      [
        "daemon_stale_build",
        "escalation",
        "pr_state_mismatch",
        "quota_spend_limit",
        "quota_threshold",
        "review_approved_ready",
        "review_exhausted",
        "task_blocked",
        "task_failed",
      ].sort(),
    );
    // Everything that pushes by default is either an action item or platform
    // health — never mere progress.
    for (const key of on) {
      expect(["action", "platform"]).toContain(
        NOTIFY_EVENTS[key as keyof typeof NOTIFY_EVENTS].category,
      );
    }
  });

  it("covers both quota alert kinds under platform health", async () => {
    const { NOTIFY_EVENTS } = await import("../src/notify-events.js");
    for (const key of ["quota_threshold", "quota_spend_limit"] as const) {
      expect(NOTIFY_EVENTS[key].category).toBe("platform");
      expect(NOTIFY_EVENTS[key].default_enabled).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Quota alerting routes through the catalog too.                      *
 * ------------------------------------------------------------------ */

describe("quota alerts", () => {
  /** A live-usage reading whose headline meter sits at `percent`. */
  function usageAt(percent: number, now: Date, spendLimit: boolean | null = null) {
    const resets = new Date(now.getTime() + 3_600_000).toISOString();
    const headline = {
      key: "session",
      label: "Session (5h)",
      percent,
      resets_at: resets,
      severity: null,
      used_usd: null,
      limit_usd: null,
    };
    return {
      fetched_at: now.toISOString(),
      source: "claude-code-oauth" as const,
      meters: [headline],
      headline,
      spend:
        spendLimit === null
          ? null
          : { limit_reached: spendLimit, used_usd: null, limit_usd: null, disabled_reason: null },
      plan: "team",
    };
  }

  it("pages through the catalog when the threshold is crossed", async () => {
    const { runQuotaAlerts } = await import("../src/daemon/quotaalert.js");
    const { listEvents } = await import("../src/db/events.js");
    const now = new Date("2026-07-28T12:00:00.000Z");

    runQuotaAlerts(usageAt(88, now) as never, now);

    const sent = pushes();
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toBe("Claude quota 88% used");
    // Classified, not raw: the push is recorded against its catalog event.
    const pushed = listEvents(30).filter((e) => e.kind === "notify.pushed");
    expect(pushed).toHaveLength(1);
    expect(JSON.parse(pushed[0].payload!).event).toBe("quota_threshold");
  });

  it("is silenced by the quota_threshold toggle, but still logs the event", async () => {
    const { setNotificationSettings } = await import("../src/db/settings.js");
    setNotificationSettings({ events: { quota_threshold: false } });
    const { runQuotaAlerts } = await import("../src/daemon/quotaalert.js");
    const { listEvents } = await import("../src/db/events.js");
    const now = new Date("2026-07-28T12:00:00.000Z");

    runQuotaAlerts(usageAt(88, now) as never, now);

    expect(pushes()).toEqual([]);
    // The dashboard still learns about it — only the phone buzz is suppressed.
    expect(listEvents(30).map((e) => e.kind)).toContain("usage.quota_threshold");
  });

  it("switches the two quota kinds independently", async () => {
    const { setNotificationSettings } = await import("../src/db/settings.js");
    setNotificationSettings({ events: { quota_threshold: false } });
    const { runQuotaAlerts } = await import("../src/daemon/quotaalert.js");
    const now = new Date("2026-07-28T12:00:00.000Z");

    runQuotaAlerts(usageAt(88, now, true) as never, now);

    const sent = pushes();
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toBe("Claude spend limit reached");
  });

  it("still pages only once per crossing (the quota latch is the de-dup)", async () => {
    const { runQuotaAlerts } = await import("../src/daemon/quotaalert.js");
    const now = new Date("2026-07-28T12:00:00.000Z");

    // Three polls re-observing the SAME window (same reset instant), which is
    // what an hourly feed actually reports while a window stays hot.
    const reading = usageAt(88, now);
    for (let i = 0; i < 3; i++) runQuotaAlerts(reading as never, now);

    expect(pushes()).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * notifyEvent mechanics: toggles and the de-dup latch.                *
 * ------------------------------------------------------------------ */

describe("notifyEvent", () => {
  it("suppresses an event that is off by default", async () => {
    const { notifyEvent } = await import("../src/daemon/notify.js");
    expect(notifyEvent("task_review_entered", "t", "m")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pushes an off-by-default event once it is switched on", async () => {
    const { setNotificationSettings } = await import("../src/db/settings.js");
    const { notifyEvent } = await import("../src/daemon/notify.js");
    setNotificationSettings({ events: { task_review_entered: true } });
    expect(notifyEvent("task_review_entered", "t", "m")).toBe(true);
    expect(pushes()).toHaveLength(1);
  });

  it("suppresses an on-by-default event once it is switched off", async () => {
    const { setNotificationSettings } = await import("../src/db/settings.js");
    const { notifyEvent } = await import("../src/daemon/notify.js");
    setNotificationSettings({ events: { escalation: false } });
    expect(notifyEvent("escalation", "t", "m")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fires a latched push exactly once, and re-arms on a new key", async () => {
    const { notifyEvent } = await import("../src/daemon/notify.js");
    expect(notifyEvent("task_blocked", "a", "m", { once: "k:1" })).toBe(true);
    expect(notifyEvent("task_blocked", "a", "m", { once: "k:1" })).toBe(false);
    expect(notifyEvent("task_blocked", "a", "m", { once: "k:2" })).toBe(true);
    expect(pushes()).toHaveLength(2);
  });

  it("does not burn the latch when no ntfy URL is configured", async () => {
    delete process.env.CC_NTFY_URL;
    const { notifyEvent } = await import("../src/daemon/notify.js");
    expect(notifyEvent("task_blocked", "a", "m", { once: "k:1" })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    // Configuring the URL later must still deliver it.
    process.env.CC_NTFY_URL = "https://ntfy.test/cc";
    expect(notifyEvent("task_blocked", "a", "m", { once: "k:1" })).toBe(true);
    expect(pushes()).toHaveLength(1);
  });

  it("records a notify.pushed event for what actually went out", async () => {
    const { notifyEvent } = await import("../src/daemon/notify.js");
    const { listEvents } = await import("../src/db/events.js");
    notifyEvent("escalation", "hello", "m", { taskId: 7 });
    notifyEvent("task_review_entered", "quiet", "m", { taskId: 7 });
    const pushed = listEvents(20).filter((e) => e.kind === "notify.pushed");
    expect(pushed).toHaveLength(1);
    expect(JSON.parse(pushed[0].payload!).event).toBe("escalation");
  });
});

/* ------------------------------------------------------------------ *
 * Trigger reclassification, end to end through the review loop.       *
 * ------------------------------------------------------------------ */

function makeRepo(taskId: number): { repo: string; branch: string; headSha: string } {
  const repo = path.join(tmpDir, `repo-${taskId}`);
  fs.mkdirSync(repo, { recursive: true });
  const g = (...a: string[]) =>
    execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...a]);
  g("init", "-q", "-b", "main");
  g("commit", "-q", "--allow-empty", "-m", "init");
  const branch = `agent/task-${taskId}`;
  g("branch", branch);
  g("checkout", "-q", branch);
  fs.writeFileSync(path.join(repo, "f.txt"), "work");
  g("add", "-A");
  g("commit", "-q", "-m", "work");
  const headSha = g("rev-parse", branch).toString().trim();
  g("checkout", "-q", "main");
  return { repo, branch, headSha };
}

async function reviewTask(
  taskId: number,
  fields: Record<string, unknown> = {},
): Promise<{ id: number; repo: string; branch: string; headSha: string }> {
  const { createTask, updateTask } = await import("../src/db/tasks.js");
  const r = makeRepo(taskId);
  const t = createTask({ title: "widget audit", prompt: "x", repo: r.repo });
  updateTask(t.id, {
    status: "review",
    branch: r.branch,
    result_summary: "claims done",
    pr_url: `https://github.com/x/y/pull/${taskId}`,
    pr_is_draft: 1,
    ...fields,
  });
  return { id: t.id, ...r };
}

/** A gh runner that succeeds for everything (pr ready / view / edit). */
async function ghOk(args: string[]): Promise<string> {
  return args.includes("title") ? "widget audit" : "";
}

describe("a task ENTERING review", () => {
  it("pushes nothing — the automatic reviewer runs next", async () => {
    const { maybeAutoReview } = await import("../src/daemon/review.js");
    const { listEvents } = await import("../src/db/events.js");
    const task = await reviewTask(1);

    await maybeAutoReview(task.id);

    // A reviewer really did start; the human just wasn't told.
    expect(spawnReviewer).toHaveBeenCalledOnce();
    expect(listEvents(30).map((e) => e.kind)).toContain("review.round_started");
    expect(pushes()).toEqual([]);
  });
});

describe("approved + PR ready", () => {
  it("pushes once, saying what happened and what to do", async () => {
    const { _setGhRunner } = await import("../src/daemon/prdraft.js");
    _setGhRunner(ghOk);
    const { handleVerdict } = await import("../src/daemon/review.js");
    const task = await reviewTask(2);

    await handleVerdict(task.id, 999, "approve", "looks good");

    const sent = pushes();
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toBe(
      `task #${task.id} reviewed & approved — PR ready to merge`,
    );
    expect(sent[0].message).toContain("widget audit");
    expect(sent[0].message).toContain(`https://github.com/x/y/pull/2`);
    expect(sent[0].message).toContain("Merge it");
    // The old wording claimed readiness at the wrong moment; make sure it's gone.
    expect(sent[0].title).not.toContain("ready for review");
  });

  it("does not re-fire when the prsync sweep re-derives the same state", async () => {
    const { _setGhRunner } = await import("../src/daemon/prdraft.js");
    _setGhRunner(ghOk);
    const { handleVerdict } = await import("../src/daemon/review.js");
    const { applyPrState } = await import("../src/daemon/prsync.js");
    const task = await reviewTask(3);

    await handleVerdict(task.id, 999, "approve", "looks good");
    expect(pushes()).toHaveLength(1);

    // Three sweeps over an unchanged, still-open PR.
    for (let i = 0; i < 3; i++) {
      await applyPrState(task.id, {
        state: "OPEN",
        reviewDecision: null,
        comments: [],
        reviews: [],
        isDraft: false,
      });
    }
    expect(pushes()).toHaveLength(1);
  });

  it("stays silent while the PR is still a draft, then fires when it is not", async () => {
    // `gh pr ready` fails at approve time, so the PR is approved but NOT ready.
    const { _setGhRunner } = await import("../src/daemon/prdraft.js");
    _setGhRunner(async () => {
      throw new Error("gh: network down");
    });
    const { handleVerdict } = await import("../src/daemon/review.js");
    const { applyPrState } = await import("../src/daemon/prsync.js");
    const { updateTask } = await import("../src/db/tasks.js");
    const task = await reviewTask(4);

    await handleVerdict(task.id, 999, "approve", "looks good");
    let sent = pushes();
    // The only push is the loud "your PR state is wrong" one — never a claim
    // that something un-mergeable is ready to merge.
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toContain("STILL A DRAFT");

    // The human flips it ready by hand; the next sweep observes that.
    updateTask(task.id, { pr_is_draft: 0 });
    await applyPrState(task.id, {
      state: "OPEN",
      reviewDecision: null,
      comments: [],
      reviews: [],
      isDraft: false,
    });
    sent = pushes();
    expect(sent).toHaveLength(2);
    expect(sent[1].title).toContain("reviewed & approved — PR ready to merge");
  });

  it("is suppressed when the operator turns the event off", async () => {
    const { setNotificationSettings } = await import("../src/db/settings.js");
    setNotificationSettings({ events: { review_approved_ready: false } });
    const { _setGhRunner } = await import("../src/daemon/prdraft.js");
    _setGhRunner(ghOk);
    const { handleVerdict } = await import("../src/daemon/review.js");
    const task = await reviewTask(5);

    await handleVerdict(task.id, 999, "approve", "looks good");

    expect(pushes()).toEqual([]);
  });
});

describe("review loop exhausted", () => {
  it("pushes once when the reject cycle cap is reached", async () => {
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    setSchedulerConfig({ review_max_cycles: 2 });
    const { _setGhRunner } = await import("../src/daemon/prdraft.js");
    _setGhRunner(ghOk);
    const { handleVerdict } = await import("../src/daemon/review.js");
    const { getTask, updateTask } = await import("../src/db/tasks.js");
    const task = await reviewTask(6, { review_cycles: 1, agent_id: null });

    // Second rejection hits the cap.
    await handleVerdict(task.id, 999, "reject", "still broken");

    expect(getTask(task.id)?.status).toBe("blocked");
    const sent = pushes();
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toBe(
      `task #${task.id} blocked — review loop exhausted after 2 rounds`,
    );
    expect(sent[0].message).toContain("steer it, requeue it, or close it");

    // A second verdict landing on the SAME round (e.g. a duplicate reviewer
    // submission) must not page again.
    updateTask(task.id, { status: "review", review_cycles: 1 });
    await handleVerdict(task.id, 999, "reject", "still broken");
    expect(pushes()).toHaveLength(1);
  });

  it("stays quiet on a rejection that is still inside the cap", async () => {
    const { setSchedulerConfig } = await import("../src/db/settings.js");
    setSchedulerConfig({ review_max_cycles: 4 });
    const { _setGhRunner } = await import("../src/daemon/prdraft.js");
    _setGhRunner(ghOk);
    const { handleVerdict } = await import("../src/daemon/review.js");
    const task = await reviewTask(7, { review_cycles: 0, agent_id: null });

    await handleVerdict(task.id, 999, "reject", "fix the thing");

    expect(pushes()).toEqual([]);
  });
});

describe("PR merged", () => {
  it("does not push by default — the human did the merge", async () => {
    const { applyPrState } = await import("../src/daemon/prsync.js");
    const task = await reviewTask(8, { pr_is_draft: 0 });

    await applyPrState(task.id, {
      state: "MERGED",
      reviewDecision: null,
      comments: [],
    });

    const { getTask } = await import("../src/db/tasks.js");
    expect(getTask(task.id)?.status).toBe("done");
    expect(pushes()).toEqual([]);
  });

  it("pushes when the operator opts into completion notices", async () => {
    const { setNotificationSettings } = await import("../src/db/settings.js");
    setNotificationSettings({ events: { task_completed: true } });
    const { applyPrState } = await import("../src/daemon/prsync.js");
    const task = await reviewTask(9, { pr_is_draft: 0 });

    await applyPrState(task.id, {
      state: "MERGED",
      reviewDecision: null,
      comments: [],
    });

    expect(pushes()).toHaveLength(1);
    expect(pushes()[0].title).toContain("done — you merged its PR");
  });
});

describe("PR closed without merge", () => {
  it("pushes once — the task is blocked on a decision", async () => {
    const { applyPrState } = await import("../src/daemon/prsync.js");
    const task = await reviewTask(10);

    for (let i = 0; i < 2; i++) {
      await applyPrState(task.id, {
        state: "CLOSED",
        reviewDecision: null,
        comments: [],
      });
    }

    const sent = pushes();
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toContain("blocked — its PR was closed without merging");
    expect(sent[0].message).toContain("salvage");
  });
});
