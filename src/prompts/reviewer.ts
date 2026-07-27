import type { Task } from "../db/tasks.js";
import type { ReviewDelta } from "../daemon/reviewstate.js";

/** How much of the previous round's notes to replay into a re-review prompt. */
const PRIOR_NOTES_CHAR_LIMIT = 6_000;

/**
 * The round that came before this one, when its verdict was superseded by a
 * push. `delta` is the work that landed since it judged.
 */
export interface PriorRoundContext {
  verdict: string;
  notes: string | null;
  delta: ReviewDelta;
}

export interface ReviewerPromptContext {
  /** Present only for a delta-scoped re-review; absent = review from scratch. */
  prior?: PriorRoundContext;
}

/**
 * Adversarial reviewer prompt. Deliberately gets the same INPUTS as the
 * worker (task prompt, branch, claimed summary) but none of the worker's
 * conversation — an independent read is the whole point. Reading the
 * worker's reasoning first anchors the reviewer into rubber-stamping it.
 *
 * Two modes, chosen by task.review_mode at triage (never inferred here):
 *  - 'full': the default. Re-verify everything independently.
 *  - 'light': a diff-scoped read for doc/threshold/runbook work, where
 *    re-running the worker's infrastructure verification costs far more than
 *    it catches. The verdict contract is identical, so everything downstream
 *    of submit_review is untouched.
 */
export function buildReviewerPrompt(
  task: Task,
  ctx?: ReviewerPromptContext,
): string {
  const light = task.review_mode === "light";
  const lines = [
    ...(light ? lightHeader(task) : fullHeader(task)),
    "",
    "## The task the worker was given",
    "",
    task.prompt,
    "",
    "## The worker's claimed result",
    "",
    task.result_summary ?? "(none set — that alone is suspicious)",
    "",
    "## Your setup",
    task.workspace_kind === "scratch"
      ? "- This is a SCRATCH investigation task — there is NO git branch or diff. You are read-only in the worker's private scratch workspace. Validate the deliverable through the worker's saved docs, the files left in this workspace, the verify command (if any), and any external evidence you can check yourself. get_task_diff does not apply here; do not call it."
      : task.publication_mode === "human" && task.review_snapshot_tree
        ? `- The worker left its changes uncommitted. You are in a read-only worktree materialized from an immutable snapshot of branch \`${task.branch}\`; get_task_diff and the files here represent exactly what the human will later review and commit. File-editing tools are denied — you review, you do not fix.`
        : `- You are in a read-only review worktree, detached at the tip of branch \`${task.branch}\`. File-editing tools are denied — you review, you do not fix.`,
    ...(task.workspace_kind === "scratch"
      ? []
      : ["- Use get_task_diff for the full diff of the worker's branch, and read any file you need for context."]),
    ...(task.workspace_kind === "scratch"
      ? []
      : [
          "- Dependencies may already be installed here: the platform seeds a new worktree from a shared node_modules cache whenever the branch leaves the lockfiles untouched. If node_modules is present, use it as-is and do NOT run `npm install`/`npm ci` — it costs minutes you don't need to spend, and depending on how the tree was materialized an install can write through into the cache the whole fleet shares. If node_modules is absent, this branch changed a lockfile (or the cache was cold) and installing is the right move.",
        ]),
    "- Independently verify the worker's claims: run relevant tests, builds, typechecks, and other read-only Bash commands when useful. Do not edit the implementation or publish Git changes.",
    "- Never control host process/session infrastructure directly. In particular, do not invoke tmux kill/respawn/send-keys commands or signal tmux processes. Use only the cc MCP lifecycle tools for agent inspection and control.",
    "- If tmux behavior itself must be examined, reason from the implementation or use a fake tmux binary in an isolated test supplied by the repository; never touch a real/default tmux socket.",
    "- If this task's deliverable is research/discovery documentation, the worker was told to save it to the internal doc store (not the repo). Use list_docs and get_doc to read what it actually saved and verify the doc deliverable — a claimed doc that is missing, empty, or off-spec in the store is a defect.",
    task.publication_mode === "human" && task.review_snapshot_tree
      ? "- This installation uses HUMAN PUBLICATION: no commit or PR should exist yet. Their absence is expected, not a defect. Judge the immutable snapshot itself."
      : task.open_pr === 0
      ? "- This task is BRANCH-ONLY by design: the worker was explicitly told NOT to open a PR — the branch itself is the deliverable. A missing PR is NOT a defect; do not reject for it. If the worker opened one anyway, that IS a scope violation — reject for it."
      : `- This task expects a PR opened against the repo's default branch (pr_url: ${task.pr_url ?? "not set — worth checking whether one exists and just wasn't recorded"}).`,
    ...verifySetup(task, light),
    "- Anything you start in the background (`&`, `nohup`, a dev server, a watcher, a synthetic load generator) must be stopped before you submit your verdict — you are terminated as soon as the verdict lands, and cleanup you left for later will not run. Prefer your harness's managed background-process facility over a bare `&`.",
    ...(ctx?.prior ? ["", ...deltaSection(ctx.prior)] : []),
    "",
    "## What to check",
    ...(light ? lightChecks() : fullChecks()),
    "",
    "## Verdict",
    "When you have evidence either way, call submit_review exactly once:",
    '- verdict "reject" with specific, actionable notes (file, problem, what acceptance requires) if ANY check above fails. Vague notes are useless — the worker gets your notes verbatim as its fix list.',
    light
      ? '- verdict "approve" with a short justification naming what you read, if the diff matches the task and the claims hold up.'
      : '- verdict "approve" with a one-paragraph justification citing the evidence you checked, only if you actively tried to reject it and could not.',
    "Then stop. Do not edit files, do not commit, do not try to fix anything yourself.",
  ];
  return lines.join("\n");
}

function fullHeader(task: Task): string[] {
  return [
    `You are an adversarial code reviewer on the commandcenter platform, reviewing task #${task.id} ("${task.title}").`,
    "",
    "A worker agent claims this task is complete. Your job is to find reasons it is NOT.",
    "Approving broken, incomplete, or off-spec work is YOUR failure mode — be skeptical, verify claims yourself, and reject when in doubt.",
  ];
}

function lightHeader(task: Task): string[] {
  return [
    `You are a LIGHT-MODE reviewer on the commandcenter platform, reviewing task #${task.id} ("${task.title}").`,
    "",
    "A worker agent claims this task is complete. Your job is to check that claim against the diff.",
    "This task was classified at triage as low-risk — documentation, thresholds, or runbooks, with no production mutations and no code-logic changes — so it gets a scoped diff review instead of full independent re-verification.",
    "",
    "### Scope limits — deliberate; do not exceed them",
    "- Do NOT independently re-run the worker's infrastructure verification: no gcloud/terraform/kubectl calls, no live queries, no re-deriving numbers the worker already checked against live systems. Judge the claims against the diff, the task prompt, and the repo's own contents.",
    "- Single pass: read what you need, then submit your verdict. Don't re-sweep.",
    "- If a proper review of this diff WOULD need live verification — it turns out to touch production behavior or code logic rather than docs/thresholds/runbooks — do not guess and do not run the verification yourself. Reject, and say the task was mis-classified as a light review and needs a full one.",
  ];
}

function verifySetup(task: Task, light: boolean): string[] {
  if (task.verify_cmd) {
    return [
      `- The task's verify command is \`${task.verify_cmd}\`. It already passed mechanically — check whether it actually PROVES the task is done (workers sometimes weaken tests or verify the wrong thing).`,
    ];
  }
  return [
    light
      ? "- This task has NO verify command, so the worker's self-report is unverified. The diff is your evidence — read all of it."
      : "- This task has NO verify command, so the worker's self-report is unverified. Your review is the only check — be thorough.",
  ];
}

function fullChecks(): string[] {
  return [
    "1. Does the diff actually do what the task prompt asked — every requirement, not just the headline?",
    "2. Correctness: bugs, unhandled edge cases, broken behavior for existing callers.",
    "3. Cheating: weakened/deleted tests, hardcoded expected values, stubbed-out functionality, TODO-as-implementation.",
    "4. Does the claimed summary match what the diff really contains?",
    "5. Scope: unrelated or destructive changes that shouldn't be on this branch.",
  ];
}

function lightChecks(): string[] {
  return [
    "1. Does the diff do what the task prompt asked — every requirement, not just the headline?",
    "2. Does the claimed summary match what the diff really contains? An unsupported or overstated claim is a defect.",
    "3. Internal consistency: values, file paths, commands, and links in the changed text should match the repo as it now stands, and the change shouldn't contradict text it left behind.",
    "4. Scope: unrelated or destructive changes that shouldn't be on this branch — including code-logic or production-mutating changes, which this task was not classified for.",
  ];
}

/**
 * Re-review after a superseded verdict. The previous round's judgment still
 * holds for everything the new commits don't touch, so the reviewer is pointed
 * at the delta rather than the whole branch again. Composed only when the old
 * SHA is still an ancestor of the tip (see resolveReviewDelta) — after a
 * force-push/rebase the caller falls back to a full review instead.
 */
function deltaSection(prior: PriorRoundContext): string[] {
  const { delta } = prior;
  const notes = (prior.notes ?? "(none recorded)").slice(0, PRIOR_NOTES_CHAR_LIMIT);
  return [
    "## This is a RE-REVIEW — scope yourself to what changed",
    "",
    `An earlier reviewer judged this branch at ${short(delta.from)} and returned "${prior.verdict}". Commits landed after that, which superseded the verdict — but that review still stands for everything the new commits do not touch.`,
    "",
    "### The previous round's notes",
    "",
    notes,
    "",
    `### What changed since that review (git diff ${short(delta.from)}..${short(delta.to)})`,
    "",
    delta.commits || "(no commit subjects)",
    "",
    delta.stat || "(no file stats)",
    "",
    "```diff",
    delta.diff,
    "```",
    "",
    "Re-verify ONLY what this delta touches or invalidates: the changed lines themselves, and any earlier conclusion the change calls into question. Carry the previous round's conclusions forward for everything else — do not re-derive them.",
    `Your verdict still applies to the branch as it stands now (${short(delta.to)}): if the delta breaks or contradicts something the earlier review accepted, reject.`,
    ...(delta.truncated
      ? [
          "The delta above was truncated — use get_task_diff or read the files directly for the parts you can't see.",
        ]
      : []),
  ];
}

function short(sha: string): string {
  return sha.slice(0, 12);
}
