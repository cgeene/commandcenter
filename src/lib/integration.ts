/**
 * Pure helpers for PR integration: keeping open agent PRs mergeable while the
 * default branch moves under them, and the optional strict-serial repo gate.
 *
 * Worktrees isolate parallel WORK perfectly — two workers in one repo never see
 * each other's files. Conflicts come from the INTEGRATION window instead: PRs
 * sitting open while `main` advances, each branch missing the other merged PRs.
 * So the machinery here targets that window (freshen the open PRs, nudge the
 * human to merge sooner) rather than serializing the work itself. The blunt
 * one-task-per-repo guarantee stays available as an opt-in per-repo flag.
 *
 * Node-import free (same contract as src/lib/blockers.ts): the daemon, the API
 * layer, and the test suite all read these, so they must stay side-effect free.
 * `Task` is imported as a type only, so nothing is pulled in at runtime.
 */

import { normalizePrState } from "./prstate.js";
import type { Task } from "../db/tasks.js";

/** Branches Command Center owns for a task — the ONLY ones freshening may
 *  ever push to. `-resume-N` is the re-cut branch a human resume produces. */
export const AGENT_BRANCH_RE = /^agent\/task-(\d+)(?:-resume-\d+)?$/;

/** Is `branch` the agent-owned branch of exactly this task? Guard rail: a
 *  hand-made branch, another task's branch, or a renamed remote branch must
 *  never be touched by the automation, however the row got that value. */
export function isAgentTaskBranch(
  branch: string | null | undefined,
  taskId: number,
): boolean {
  const m = AGENT_BRANCH_RE.exec(branch ?? "");
  return m !== null && Number(m[1]) === taskId;
}

/**
 * Statuses that mean a task is occupying its repo right now. `queued` is
 * deliberately absent: a queued task holds nothing, and counting it would
 * deadlock a strict-serial repo (every queued task would block every other).
 */
export const SERIAL_ACTIVE_STATUSES: readonly string[] = [
  "claimed",
  "in_progress",
  "review",
];

/** The subset of a task the serial gate and the merge nudge reason about. */
export interface RepoTaskView {
  id: number;
  repo: string;
  status: string;
  branch: string | null;
  pr_url: string | null;
  pr_state: string | null;
  open_pr: number;
  /** Only 'repo' tasks occupy a git repository. A scratch workspace or a
   *  portfolio parent shares no branch with anyone. */
  workspace_kind: string;
}

/** Trailing slashes and duplicate separators make two spellings of the same
 *  repo path look different; the config is compared normalized. */
function normalizeRepoPath(repo: string): string {
  return repo.trim().replace(/\/+$/, "");
}

/** Is this repo configured for the blunt one-active-task-at-a-time guarantee?
 *  Default OFF everywhere — an empty list means no repo is serialized. */
export function repoIsStrictSerial(repo: string, configured: string[]): boolean {
  const target = normalizeRepoPath(repo);
  return configured.some((r) => normalizeRepoPath(r) === target);
}

/** Does this task still hold an open agent-authored PR? Such a task occupies
 *  the repo even after its own worker is gone: the PR is what conflicts.
 *  pr_state always goes through normalizePrState — `gh` speaks UPPERCASE, the
 *  column stores lowercase, and a raw comparison would silently miss. */
export function holdsOpenAgentPr(task: RepoTaskView): boolean {
  return (
    Boolean(task.pr_url) &&
    task.open_pr !== 0 &&
    normalizePrState(task.pr_state) === "open" &&
    isAgentTaskBranch(task.branch, task.id)
  );
}

/**
 * The other task that currently occupies `candidate`'s repo, or undefined when
 * the repo is free. "Occupies" = actively worked (claimed/in_progress/review)
 * or still holding an open agent PR. Only meaningful for a strict-serial repo;
 * callers check that first.
 *
 * `candidate` itself is always excluded, so a task's own respawn (a review
 * round, a merge-conflict fix) is never gated by its own occupancy.
 */
export function serialRepoHolder<T extends RepoTaskView>(
  candidate: RepoTaskView,
  tasks: T[],
): T | undefined {
  if (candidate.workspace_kind !== "repo") return undefined;
  const repo = normalizeRepoPath(candidate.repo);
  return tasks.find(
    (t) =>
      t.id !== candidate.id &&
      t.workspace_kind === "repo" &&
      normalizeRepoPath(t.repo) === repo &&
      (SERIAL_ACTIVE_STATUSES.includes(t.status) || holdsOpenAgentPr(t)),
  );
}

/** Statuses that make another task in the repo a reason to merge NOW: it is
 *  either moving already or about to, so every hour this PR waits widens the
 *  conflict window for it. */
export const CONTENDING_STATUSES: readonly string[] = [
  "queued",
  "claimed",
  "in_progress",
  "review",
];

/** Tasks (other than `task`) whose progress the unmerged PR is putting at
 *  risk of conflicting. Empty ⇒ nothing is waiting, so no nudge is warranted. */
export function repoContenders<T extends RepoTaskView>(
  task: RepoTaskView,
  tasks: T[],
): T[] {
  const repo = normalizeRepoPath(task.repo);
  return tasks.filter(
    (t) =>
      t.id !== task.id &&
      t.workspace_kind === "repo" &&
      normalizeRepoPath(t.repo) === repo &&
      CONTENDING_STATUSES.includes(t.status),
  );
}

/** Shorten a worker's result summary for a brief without losing its shape. */
function summaryExcerpt(summary: string | null, limit = 1200): string {
  const trimmed = (summary ?? "").trim();
  if (!trimmed) return "(no result summary was recorded — read the PR diff instead)";
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

export interface IntegrationBriefInput {
  taskId: number;
  branch: string;
  /** The repo's default branch NAME (e.g. "main"), not `origin/main`. */
  defaultBranch: string;
  prUrl: string | null;
  resultSummary: string | null;
  verifyCmd: string | null;
  /** 1 for the first integration fix round on this task. */
  round: number;
}

export interface ConflictBriefInput extends IntegrationBriefInput {
  /** Paths git reported as conflicted, so the worker starts where it matters. */
  conflictPaths: string[];
}

export interface VerifyFailBriefInput extends IntegrationBriefInput {
  /** Tail of the failing verify output. */
  output: string;
}

/** The shared spine of both briefs: this work is DONE, the only job is to make
 *  it merge cleanly again, and how to do that without destroying review state. */
function briefBody(
  input: IntegrationBriefInput,
  situation: string[],
  firstStep: string[],
): string {
  const { taskId, branch, defaultBranch, prUrl, verifyCmd, round } = input;
  return [
    `## Integration fix round ${round}: re-merge \`${defaultBranch}\` into this branch`,
    "",
    ...situation,
    "",
    "The task above is ALREADY COMPLETE and was already reviewed. Do NOT redo it, re-scope it,",
    "refactor it, or \"improve\" it while you are here. Your ONLY job is to make this branch merge",
    `cleanly into \`${defaultBranch}\` again with its delivered behavior intact.`,
    "",
    "What this branch already delivers (preserve all of it):",
    summaryExcerpt(input.resultSummary),
    "",
    "Do exactly this:",
    ...firstStep,
    `2. \`git merge origin/${defaultBranch}\` — a MERGE, never a rebase. Rebasing rewrites the very`,
    "   commits a reviewer already approved; a merge commit keeps them intact and reviewable.",
    `3. Resolve every conflict by keeping BOTH sides' intent. \`origin/${defaultBranch}\` (which now`,
    "   contains the other merged PRs) is the base you are adapting to; this branch's change is what",
    "   you are preserving on top of it. Never resolve by discarding either side wholesale, and never",
    "   revert someone else's merged work to make a conflict go away.",
    verifyCmd
      ? `4. Re-run the verification and make it pass: \`${verifyCmd}\``
      : "4. Re-run this repo's build/typecheck/tests and make them pass.",
    `5. Push the SAME branch: \`git push origin ${branch}\`. Never force-push.${
      prUrl ? ` It updates the existing PR (${prUrl}) in place.` : ""
    }`,
    "   Do not open a new PR, do not close this one, and do not touch its draft/ready state —",
    "   the platform owns that.",
    `6. Set result_summary via update_my_task: keep the substance of the original summary and add`,
    "   one or two lines on what conflicted, how you resolved it, and that verification passed.",
    "",
    `If the conflict cannot be resolved without changing what this task delivers, stop and call`,
    `report_blocked with what collides — do not guess. (task #${taskId})`,
  ].join("\n");
}

/** The standardized brief for a branch that no longer merges cleanly. */
export function conflictBrief(input: ConflictBriefInput): string {
  const { branch, defaultBranch, prUrl, conflictPaths } = input;
  const paths = conflictPaths.length
    ? conflictPaths.map((p) => `\`${p}\``).join(", ")
    : "(git did not report specific paths — re-run the merge to see them)";
  return briefBody(
    input,
    [
      `Other pull requests merged into \`${defaultBranch}\` after this branch was cut, and`,
      `\`${branch}\`${prUrl ? ` (PR ${prUrl})` : ""} now CONFLICTS with it. The platform tried the`,
      "merge automatically, hit conflicts, and threw its attempt away — nothing was pushed, and this",
      "branch is exactly as you left it.",
      "",
      `Files that conflicted: ${paths}`,
    ],
    [
      `1. \`git fetch origin\`. If this branch is behind its own remote copy, fast-forward first:`,
      `   \`git merge --ff-only origin/${branch}\` (the platform may have pushed an earlier clean merge).`,
    ],
  );
}

/** The standardized brief for a branch that merges cleanly but no longer
 *  passes its own verification once the default branch is folded in. */
export function verifyFailBrief(input: VerifyFailBriefInput): string {
  const { branch, defaultBranch, verifyCmd, output } = input;
  const tail = output.trim().slice(-1500);
  return briefBody(
    input,
    [
      `\`${branch}\` still merges cleanly with \`${defaultBranch}\`, but after the merge its`,
      `verification FAILED — so something that landed in \`${defaultBranch}\` breaks this branch's`,
      "work semantically, even though no text conflicted. The platform threw its merge away and",
      "pushed nothing; this branch is exactly as you left it.",
      "",
      `Failing command: \`${verifyCmd ?? "(the task's verification)"}\``,
      "Output tail:",
      "```",
      tail || "(no output captured)",
      "```",
    ],
    [
      `1. \`git fetch origin\`. If this branch is behind its own remote copy, fast-forward first:`,
      `   \`git merge --ff-only origin/${branch}\`.`,
    ],
  );
}

/** Every task field the freshen candidate filter needs, so the filter itself
 *  stays pure and testable without a database. */
export type FreshenCandidate = Pick<
  Task,
  | "id"
  | "repo"
  | "status"
  | "branch"
  | "pr_url"
  | "pr_state"
  | "open_pr"
  | "workspace_kind"
  | "publication_mode"
>;

/**
 * Is this task's PR one the platform may freshen unattended?
 *
 * Deliberately narrow. The task must be parked in `review` — that is the
 * window where the work is finished, the PR is open, and only a human merge is
 * left, which is exactly where the observed conflicts happened. An
 * `in_progress` task is excluded because its live worker owns the branch, and a
 * human-publication task is excluded because the human, not the platform, owns
 * its pushes.
 */
export function isFreshenCandidate(task: FreshenCandidate): boolean {
  return (
    task.status === "review" &&
    task.workspace_kind === "repo" &&
    task.publication_mode === "agent" &&
    task.open_pr !== 0 &&
    Boolean(task.pr_url) &&
    normalizePrState(task.pr_state) === "open" &&
    isAgentTaskBranch(task.branch, task.id)
  );
}
