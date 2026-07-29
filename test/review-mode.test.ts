import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same seams as reviewer-snapshot-spawn: tmux and the generated provider
// configs are stubbed, so spawnReviewer runs for real (worktree, prompt file,
// DB writes) without a terminal.
const newWindow = vi.fn(
  (_name: string, _cwd: string, _command: string) => "cc:@review",
);

vi.mock("../src/daemon/tmux.js", () => ({
  newWindow: (name: string, cwd: string, command: string) =>
    newWindow(name, cwd, command),
  windowExists: () => false,
  killWindow: vi.fn(() => []),
  paneProcess: () => null,
}));

vi.mock("../src/daemon/genconfig.js", () => ({
  writeCodexConfig: () => ({
    profileFile: "/tmp/commandcenter.config.toml",
    inheritedMcpEnvVars: [],
  }),
  writeMcpConfigFile: () => "/tmp/commandcenter.mcp.json",
  writeSettingsFile: () => "/tmp/commandcenter.settings.json",
}));

vi.mock("../src/daemon/transcript.js", () => ({
  findProviderTranscript: () => undefined,
}));

let tmpDir: string;

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    ...args,
  ]).toString();
}

/** A repo whose task branch is one commit ahead of the base at repo HEAD.
 *  `commitMore` advances the branch and returns the new tip. */
function makeRepo(name: string): {
  repo: string;
  branch: string;
  headSha: string;
  commitMore: (file?: string) => string;
} {
  const repo = path.join(tmpDir, name);
  fs.mkdirSync(repo, { recursive: true });
  const branch = `agent/${name}`;
  // One subprocess per step rather than one per git command: inside a vitest
  // worker each fork costs ~120-160ms.
  const sh = (script: string, extra: Record<string, string> = {}) =>
    execFileSync(
      "sh",
      [
        "-eu",
        "-c",
        `g() { git -C "$R" -c user.email=t@t.com -c user.name=t "$@"; }\n${script}`,
      ],
      { encoding: "utf8", env: { ...process.env, R: repo, B: branch, ...extra } },
    ).trim();
  sh(`g init -q -b main
      g commit -q --allow-empty -m init
      g branch "$B"`);
  let n = 0;
  const commitMore = (file?: string): string => {
    n += 1;
    return sh(
      `g checkout -q "$B"
       printf 'work %s\n' "$N" > "$R/$F"
       g add -A
       g commit -q -m "work $N"
       SHA=$(g rev-parse "$B")
       g checkout -q main
       echo "$SHA"`,
      { N: String(n), F: file ?? `f${n}.txt` },
    );
  };
  return { repo, branch, headSha: commitMore(), commitMore };
}

/** The prompt spawnReviewer wrote for a task. */
function reviewerPromptFor(taskId: number): string {
  return fs.readFileSync(
    path.join(process.env.CC_DATA_DIR!, "prompts", `task-${taskId}-review.md`),
    "utf8",
  );
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-mode-"));
  process.env.CC_DATA_DIR = path.join(tmpDir, "data");
  newWindow.mockClear();
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.CC_DATA_DIR;
  // The git work in these tests is synchronous, so this worker's event loop
  // can sit blocked for tens of seconds at a time. Node runs the timers phase
  // before the poll phase, so vitest's fixed 60s worker->main RPC timer can
  // fire on a reply that was already delivered but not yet read, failing the
  // run with 'Timeout calling "onTaskUpdate"'. Yield a macrotask so those
  // replies get drained between tests.
  await new Promise((resolve) => setImmediate(resolve));
});

describe("review_mode — the per-task field", () => {
  it("defaults to 'full' so existing tasks keep today's behavior", async () => {
    const { createTask } = await import("../src/db/tasks.js");
    const task = createTask({ title: "t", prompt: "x", repo: tmpDir });
    expect(task.review_mode).toBe("full");
  });

  it("stores an explicit mode at creation and accepts an update", async () => {
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const task = createTask({
      title: "docs",
      prompt: "x",
      repo: tmpDir,
      review_mode: "light",
    });
    expect(task.review_mode).toBe("light");
    expect(updateTask(task.id, { review_mode: "full" })?.review_mode).toBe("full");
  });

  it("rejects an unknown mode rather than writing it", async () => {
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    expect(() =>
      createTask({
        title: "t",
        prompt: "x",
        repo: tmpDir,
        review_mode: "skim" as "light",
      }),
    ).toThrow(/invalid review mode/);
    const task = createTask({ title: "t", prompt: "x", repo: tmpDir });
    expect(() =>
      updateTask(task.id, { review_mode: "skim" as "light" }),
    ).toThrow(/invalid review mode/);
    expect(() =>
      updateTask(task.id, { review_mode: null as unknown as "light" }),
    ).toThrow(/invalid review mode/);
  });
});

describe("reviewer prompt — full vs light", () => {
  it("a default (full) task gets the unchanged adversarial prompt", async () => {
    const { buildReviewerPrompt } = await import("../src/prompts/reviewer.js");
    const { createTask } = await import("../src/db/tasks.js");
    const task = createTask({ title: "t", prompt: "do the thing", repo: tmpDir });
    const prompt = buildReviewerPrompt({ ...task, branch: "agent/t" });

    expect(prompt).toContain("You are an adversarial code reviewer");
    expect(prompt).toContain("verify claims yourself");
    expect(prompt).not.toContain("LIGHT-MODE");
    expect(prompt).not.toContain("Scope limits");
  });

  it("a light task gets the diff-scoped prompt with the no-re-verification rule", async () => {
    const { buildReviewerPrompt } = await import("../src/prompts/reviewer.js");
    const { createTask } = await import("../src/db/tasks.js");
    const task = createTask({
      title: "raise the alert threshold",
      prompt: "bump the runbook threshold",
      repo: tmpDir,
      review_mode: "light",
    });
    const prompt = buildReviewerPrompt({ ...task, branch: "agent/t" });

    expect(prompt).toContain("LIGHT-MODE reviewer");
    expect(prompt).toContain("Do NOT independently re-run");
    expect(prompt).toContain("no gcloud/terraform/kubectl calls");
    expect(prompt).toContain("Single pass");
    // mis-triage must come back as a rejection, not a silent deep review
    expect(prompt).toContain("mis-classified");
    expect(prompt).not.toContain("You are an adversarial code reviewer");
  });

  it("keeps the verdict contract identical in both modes", async () => {
    const { buildReviewerPrompt } = await import("../src/prompts/reviewer.js");
    const { createTask } = await import("../src/db/tasks.js");
    const base = { title: "t", prompt: "x", repo: tmpDir };
    for (const mode of ["full", "light"] as const) {
      const task = createTask({ ...base, review_mode: mode });
      const prompt = buildReviewerPrompt({ ...task, branch: "agent/t" });
      expect(prompt).toContain("call submit_review exactly once");
      expect(prompt).toContain('verdict "approve"');
      expect(prompt).toContain('verdict "reject"');
      expect(prompt).toContain("Do not edit files");
    }
  });
});

// Real git repos and worktrees: slower than the 5s default when the whole
// suite runs in parallel.
const GIT_TEST_TIMEOUT = 30_000;

describe("resolveReviewDelta — what a re-review is scoped to", { timeout: GIT_TEST_TIMEOUT }, () => {
  it("returns the commits and patch added since the reviewed sha", async () => {
    const { resolveReviewDelta } = await import("../src/daemon/reviewstate.js");
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const repo = makeRepo("delta");
    const task = createTask({ title: "t", prompt: "x", repo: repo.repo });
    const reviewed = repo.headSha;
    const newHead = repo.commitMore("added-later.txt");
    const t = updateTask(task.id, { branch: repo.branch })!;

    const delta = resolveReviewDelta(t, reviewed)!;
    expect(delta).not.toBeNull();
    expect(delta.from).toBe(reviewed);
    expect(delta.to).toBe(newHead);
    expect(delta.stat).toContain("added-later.txt");
    expect(delta.diff).toContain("added-later.txt");
    // the earlier, already-reviewed commit is NOT replayed
    expect(delta.diff).not.toContain("f1.txt");
  });

  it("returns null when the branch tip hasn't moved", async () => {
    const { resolveReviewDelta } = await import("../src/daemon/reviewstate.js");
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const repo = makeRepo("unmoved");
    const task = createTask({ title: "t", prompt: "x", repo: repo.repo });
    const t = updateTask(task.id, { branch: repo.branch })!;
    expect(resolveReviewDelta(t, repo.headSha)).toBeNull();
  });

  it("returns null after a rebase — the reviewed sha is no longer an ancestor", async () => {
    const { resolveReviewDelta } = await import("../src/daemon/reviewstate.js");
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const repo = makeRepo("rebased");
    const reviewed = repo.headSha;
    // rewrite the branch so `reviewed` still exists as an object but is no
    // longer on the branch — the force-push/rebase case
    git(repo.repo, "checkout", "-q", repo.branch);
    git(repo.repo, "commit", "-q", "--amend", "-m", "work 1 (amended)");
    git(repo.repo, "checkout", "-q", "main");
    const task = createTask({ title: "t", prompt: "x", repo: repo.repo });
    const t = updateTask(task.id, { branch: repo.branch })!;

    expect(resolveReviewDelta(t, reviewed)).toBeNull();
  });

});

describe("spawnReviewer — the prompt it actually writes", { timeout: GIT_TEST_TIMEOUT }, () => {
  /** A repo task parked in review, ready for spawnReviewer. */
  async function reviewableTask(
    name: string,
    fields: Record<string, unknown> = {},
  ) {
    const { createTask, updateTask } = await import("../src/db/tasks.js");
    const repo = makeRepo(name);
    const task = createTask({
      title: name,
      prompt: "do the thing",
      repo: repo.repo,
      ...(fields.review_mode ? { review_mode: fields.review_mode as "light" } : {}),
    });
    updateTask(task.id, {
      status: "review",
      branch: repo.branch,
      worktree: repo.repo,
      result_summary: "claims done",
      pr_url: `https://github.com/x/y/pull/${task.id}`,
      ...(fields as Record<string, never>),
    });
    return { taskId: task.id, repo };
  }

  it("a superseded approval re-reviews only the delta, carrying the prior notes", async () => {
    const { spawnReviewer } = await import("../src/daemon/spawn.js");
    const { taskId, repo } = await reviewableTask("superseded");
    const reviewed = repo.headSha;
    repo.commitMore("late-change.txt");

    spawnReviewer(taskId, {
      priorRound: {
        fromSha: reviewed,
        verdict: "approve",
        notes: "checked the migration path end to end",
      },
    });

    const prompt = reviewerPromptFor(taskId);
    expect(prompt).toContain("This is a RE-REVIEW");
    expect(prompt).toContain("checked the migration path end to end");
    expect(prompt).toContain("late-change.txt");
    expect(prompt).toContain("Re-verify ONLY what this delta touches");
    expect(prompt).toContain("Carry the previous round's conclusions forward");
  });

  it("falls back to a full re-review when the reviewed sha was rebased away", async () => {
    const { spawnReviewer } = await import("../src/daemon/spawn.js");
    const { listEvents } = await import("../src/db/events.js");
    const { taskId, repo } = await reviewableTask("rebased-away");
    const reviewed = repo.headSha;
    git(repo.repo, "checkout", "-q", repo.branch);
    git(repo.repo, "commit", "-q", "--amend", "-m", "rewritten");
    git(repo.repo, "checkout", "-q", "main");

    spawnReviewer(taskId, {
      priorRound: { fromSha: reviewed, verdict: "approve", notes: "old notes" },
    });

    const prompt = reviewerPromptFor(taskId);
    expect(prompt).not.toContain("This is a RE-REVIEW");
    expect(prompt).not.toContain("old notes");
    expect(prompt).toContain("You are an adversarial code reviewer");
    const events = listEvents(30);
    expect(events.map((e) => e.kind)).toContain("review.delta_unavailable");
    const spawned = events.find((e) => e.kind === "reviewer.spawned")!;
    expect(JSON.parse(spawned.payload!)).toMatchObject({ scope: "full" });
  });

  it("records the mode and scope on the spawn event", async () => {
    const { spawnReviewer } = await import("../src/daemon/spawn.js");
    const { listEvents } = await import("../src/db/events.js");
    const { taskId, repo } = await reviewableTask("light-spawn", {
      review_mode: "light",
    });
    const reviewed = repo.headSha;
    repo.commitMore("more.txt");

    spawnReviewer(taskId, {
      priorRound: { fromSha: reviewed, verdict: "approve", notes: "fine" },
    });

    expect(reviewerPromptFor(taskId)).toContain("LIGHT-MODE reviewer");
    const spawned = listEvents(30).find((e) => e.kind === "reviewer.spawned")!;
    expect(JSON.parse(spawned.payload!)).toMatchObject({
      review_mode: "light",
      scope: "delta",
    });
  });

  it("runs a Codex light reviewer at low reasoning effort", async () => {
    const { spawnReviewer } = await import("../src/daemon/spawn.js");
    const { taskId } = await reviewableTask("codex-light", {
      review_mode: "light",
    });

    const { agent } = spawnReviewer(taskId, { provider: "codex" });
    expect(agent.reasoning_effort).toBe("low");
  });

});
