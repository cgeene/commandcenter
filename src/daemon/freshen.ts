import fs from "node:fs";
import path from "node:path";
import { listAgents } from "../db/agents.js";
import { countTaskEvents, latestTaskEvent, logEvent } from "../db/events.js";
import { latchNotify, notifyLatched } from "../db/notifylatch.js";
import {
  getIntegrationSettings,
  resolveWorktreesDir,
} from "../db/settings.js";
import { getTask, listTasks, updateTask, type Task } from "../db/tasks.js";
import {
  conflictBrief,
  isFreshenCandidate,
  repoContenders,
  verifyFailBrief,
} from "../lib/integration.js";
import { normalizePrState } from "../lib/prstate.js";
import { primeWorktreeDeps } from "./depcache.js";
import { notifyEvent } from "./notify.js";
import { approvedReadyLatchKey } from "./review.js";
import { spawnWorker } from "./spawn.js";
import { MAX_TASK_PROMPT_LENGTH } from "./taskresume.js";
import { runVerifyCommand } from "./verifyenv.js";
import {
  fetchOriginDefaultBranch,
  fetchQuiet,
  git,
  pushQuiet,
  removeWorktree,
} from "./worktree.js";

/**
 * Self-healing PR integration.
 *
 * Parallel work in one repo is safe — each worker has its own worktree and
 * never sees the others' files. What is NOT safe is the INTEGRATION window:
 * once two agent PRs are open at the same time, whichever merges first leaves
 * every other open branch missing those commits. The observed cost was never
 * the conflicts themselves (they were trivial adjacencies resolved in minutes)
 * — it was a human noticing, respawning a worker, and hand-writing a brief.
 *
 * So this module closes the window mechanically. Every prsync pass, for each
 * open agent PR whose branch has fallen behind the repo's default branch:
 *
 *   clean merge + verification passes  -> push the merge commit (PR updates in
 *                                         place) and carry the approval over
 *   clean merge + verification fails   -> push NOTHING, respawn the worker with
 *                                         the standard brief
 *   conflict                           -> push NOTHING, respawn the worker with
 *                                         the standard conflict brief
 *
 * Guard rails, in one place so they are auditable:
 *   - only branches matching this exact task (`agent/task-<id>[-resume-N]`) are
 *     ever touched; anything else is skipped, whatever the row says;
 *   - the merge happens in a throwaway worktree, so a failure can never leave a
 *     half-merged tree behind for a worker or reviewer to trip over;
 *   - pushes are plain (never `--force`) and only ever to the task's own branch;
 *   - a task with any live worker/reviewer is left alone — its agent owns the
 *     branch and its verdict may be in flight;
 *   - a task that keeps needing freshening without ever merging is halted after
 *     `freshen_max_attempts` and handed to the human instead of burning tokens;
 *   - at most `freshen_per_pass_limit` merges happen per pass, so a burst of
 *     merges queues instead of spawning a storm of workers.
 *
 * Interaction with the review loop: a freshen push must not look like a worker
 * pushing new work. It doesn't, because a conflict-free merge leaves the branch's
 * diff against the default branch byte-identical, so an existing approval still
 * covers the content — freshenTask therefore advances review_head_sha with the
 * local ref (carrying the approved-and-ready push latch when, and only when, that
 * push actually went out) instead of letting the sweep supersede the verdict and
 * re-draft a PR the human was about to merge. A
 * task that has NOT been approved yet is freshened too; its pending review round
 * simply judges the merged tip, which is what it should be reading anyway.
 *
 * Merging is never automated. Layer three of this design is only a nudge: when
 * an approved PR sits unmerged while other work in the repo is moving, the
 * human is told once (see mergeNudgePass).
 */

/** Identity for the merge commits this module creates. Passed per-invocation
 *  (never written to config) and only used when the repo/user has none, so a
 *  developer's own identity is preserved where it exists. */
const MERGE_IDENTITY = ["Command Center", "commandcenter@localhost"] as const;

export interface FreshenDeps {
  now?: () => Date;
  /** Run a task's verify command in the freshened tree. */
  runVerify?: (cmd: string, cwd: string) => Promise<{ ok: boolean; output: string }>;
  /** Respawn a worker for a task that needs to reconcile the merge itself. */
  spawn?: (taskId: number) => void;
}

/** One pass may be long (a verify command can run for minutes) while the
 *  prsync interval keeps firing. Without this latch two overlapping passes
 *  could freshen — and respawn — the same task twice. */
let passInFlight = false;

/** Test helper: drop the in-flight latch between cases. */
export function _resetFreshenState(): void {
  passInFlight = false;
}

function gitIdentityArgs(repo: string): string[] {
  try {
    if (git(repo, "config", "user.email").trim()) return [];
  } catch {
    // `git config` exits non-zero when the key is unset — fall through.
  }
  return [
    "-c",
    `user.name=${MERGE_IDENTITY[0]}`,
    "-c",
    `user.email=${MERGE_IDENTITY[1]}`,
  ];
}

function freshenWorktreeDir(repo: string, taskId: number): string {
  return path.join(
    resolveWorktreesDir(),
    `${path.basename(repo)}-task-${taskId}-freshen`,
  );
}

/** A task whose branch some live agent still owns must not be touched: a
 *  worker may be mid-push, and a reviewer is judging this exact tree. */
function agentLive(taskId: number): boolean {
  return listAgents({ live: true }).some(
    (a) => a.task_id === taskId && a.kind !== "main",
  );
}

/** Open agent PRs eligible for freshening right now. */
export function freshenCandidates(): Task[] {
  return listTasks("review").filter(
    (task) => isFreshenCandidate(task) && !agentLive(task.id),
  );
}

/**
 * Make the local branch ref agree with what we just pushed, so a later respawn
 * or reviewer sees the merged state instead of a stale local tip. Best effort by
 * design: `git branch -f` refuses while the branch is checked out somewhere, in
 * which case the task's own worktree is fast-forwarded if it is clean. Origin
 * remains the source of truth either way, so a `false` here is not a failure —
 * it only means the approval must NOT be carried forward (see freshenTask).
 */
function syncLocalBranch(task: Task, branch: string, sha: string): boolean {
  try {
    git(task.repo, "branch", "-f", branch, sha);
    return true;
  } catch {
    // Checked out in a worktree — git refuses to move the ref underneath it.
  }
  const worktree = task.worktree;
  if (!worktree || !fs.existsSync(worktree)) return false;
  try {
    if (git(worktree, "status", "--porcelain").trim()) return false; // dirty
    if (git(worktree, "rev-parse", "--abbrev-ref", "HEAD").trim() !== branch) {
      return false;
    }
    git(worktree, "merge", "--ff-only", sha);
    return true;
  } catch {
    return false;
  }
}

/**
 * Append an integration brief to the task prompt, requeue, and relaunch the
 * worker.
 *
 * The brief goes into `task.prompt` (the same mechanism the archived-resume flow
 * uses) because that is what reaches the worker on BOTH routes — a fresh session
 * and a resumed one both restate the prompt — and it survives a daemon restart.
 * `spawnWorker` only accepts a queued/claimed task, so the status is moved first;
 * if the launch fails the task simply stays queued with the brief attached, and
 * the orchestrator picks it up from there.
 *
 * The review verdict is deliberately left alone. Once the worker pushes its
 * resolution the ordinary review loop sees a new HEAD, supersedes the stale
 * approval, and re-drafts the PR — the same path any post-approval push takes.
 */
function respawnForIntegration(
  task: Task,
  brief: string,
  deps: FreshenDeps,
): boolean {
  const prompt = `${task.prompt.trimEnd()}\n\n---\n\n${brief}`;
  if (prompt.length > MAX_TASK_PROMPT_LENGTH) {
    logEvent("pr.freshen_error", {
      taskId: task.id,
      payload: { error: "task prompt is too long to append an integration brief" },
    });
    return false;
  }
  updateTask(task.id, { prompt, status: "queued", agent_id: null });
  const spawn = deps.spawn ?? ((id: number) => void spawnWorker(id));
  try {
    spawn(task.id);
    return true;
  } catch (err) {
    logEvent("pr.freshen_error", {
      taskId: task.id,
      payload: {
        error: err instanceof Error ? err.message : String(err),
        phase: "respawn",
      },
    });
    return false;
  }
}

/** Halt: this PR has been freshened its full budget of times and still has not
 *  merged. Say so once — a repeat every two minutes would be its own noise. */
function haltFreshening(task: Task, attempts: number): void {
  if (latestTaskEvent(task.id, ["pr.freshen_halted"])) return;
  logEvent("pr.freshen_halted", {
    taskId: task.id,
    payload: { attempts, pr_url: task.pr_url },
  });
  notifyEvent(
    "integration_halted",
    `task #${task.id} — stopped re-merging its PR`,
    `${task.title}\n${task.pr_url}\nIts branch has been re-merged with the default branch ${attempts} times without the PR merging, so the platform stopped. Merge it (or take the branch over) — nothing else will touch it.`,
    {
      priority: "high",
      tags: "warning",
      taskId: task.id,
      once: `task:${task.id}:freshen_halted:${attempts}`,
    },
  );
}

type FreshenOutcome =
  | "fresh" // already contains the default branch — nothing to do
  | "pushed"
  | "conflict"
  | "verify_failed"
  | "abandoned" // the task moved on mid-verification; result discarded
  | "halted"
  | "error";

/**
 * Freshen one task's PR branch. Returns what happened; only outcomes other than
 * "fresh" and "halted" consumed an attempt (they did real work).
 */
async function freshenTask(
  task: Task,
  defaultBranch: string,
  deps: FreshenDeps,
): Promise<FreshenOutcome> {
  const branch = task.branch!;
  const cfg = getIntegrationSettings();

  let tipSha: string;
  let baseSha: string;
  try {
    fetchQuiet(task.repo, branch, defaultBranch);
    tipSha = git(task.repo, "rev-parse", `origin/${branch}`).trim();
    baseSha = git(task.repo, "rev-parse", `origin/${defaultBranch}`).trim();
  } catch (err) {
    logEvent("pr.freshen_error", {
      taskId: task.id,
      payload: {
        error: err instanceof Error ? err.message : String(err),
        phase: "fetch",
      },
    });
    return "error";
  }

  try {
    // Already contains the default branch tip: nothing to merge. This is the
    // idempotency gate — it is what makes running the pass every two minutes
    // free, and what stops a merge commit being piled on for no reason.
    git(task.repo, "merge-base", "--is-ancestor", baseSha, tipSha);
    return "fresh";
  } catch {
    // Behind the default branch — freshen it.
  }

  // The cap is on freshening a PR that KEEPS NEEDING it, so it is checked only
  // once the branch is known to be behind. Checked before this gate it would
  // fire on the very next poll after the Nth successful freshen — announcing
  // "the platform stopped re-merging its PR" about a branch that is perfectly
  // fresh and merely waiting on a human merge.
  const attempts = countTaskEvents(task.id, "pr.freshen_attempt");
  if (attempts >= cfg.freshen_max_attempts) {
    haltFreshening(task, attempts);
    return "halted";
  }

  logEvent("pr.freshen_attempt", {
    taskId: task.id,
    payload: {
      branch,
      base: `origin/${defaultBranch}`,
      base_sha: baseSha.slice(0, 12),
      tip_sha: tipSha.slice(0, 12),
      attempt: attempts + 1,
    },
  });

  const dir = freshenWorktreeDir(task.repo, task.id);
  const cleanup = () => {
    try {
      removeWorktree(task.repo, dir);
    } catch {
      fs.rmSync(dir, { recursive: true, force: true });
      try {
        git(task.repo, "worktree", "prune");
      } catch {
        /* nothing else to do — a stale entry is harmless */
      }
    }
  };

  try {
    if (fs.existsSync(dir)) cleanup();
    fs.mkdirSync(resolveWorktreesDir(), { recursive: true });
    // Detached on purpose: the branch may still be checked out in the worker's
    // worktree, and git refuses to check it out twice.
    git(task.repo, "worktree", "add", "--detach", dir, tipSha);
  } catch (err) {
    logEvent("pr.freshen_error", {
      taskId: task.id,
      payload: {
        error: err instanceof Error ? err.message : String(err),
        phase: "worktree",
      },
    });
    return "error";
  }

  try {
    try {
      // --no-ff: always a real merge commit. A fast-forward would move the
      // branch onto the default branch itself and empty the PR.
      git(
        dir,
        ...gitIdentityArgs(task.repo),
        "merge",
        "--no-ff",
        "--no-edit",
        "-m",
        `Merge remote-tracking branch 'origin/${defaultBranch}' into ${branch}`,
        baseSha,
      );
    } catch (mergeErr) {
      let conflicts: string[] = [];
      try {
        conflicts = git(dir, "diff", "--name-only", "--diff-filter=U")
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
      } catch {
        /* fall through: treated as a plain error below */
      }
      if (conflicts.length === 0) {
        logEvent("pr.freshen_error", {
          taskId: task.id,
          payload: {
            error: mergeErr instanceof Error ? mergeErr.message : String(mergeErr),
            phase: "merge",
          },
        });
        return "error";
      }
      const respawned = respawnForIntegration(
        task,
        conflictBrief({
          taskId: task.id,
          branch,
          defaultBranch,
          prUrl: task.pr_url,
          resultSummary: task.result_summary,
          verifyCmd: task.verify_cmd,
          round: attempts + 1,
          conflictPaths: conflicts,
        }),
        deps,
      );
      logEvent("pr.freshen_conflict", {
        taskId: task.id,
        payload: { branch, conflicts, respawned, attempt: attempts + 1 },
      });
      return "conflict";
    }

    const mergeSha = git(dir, "rev-parse", "HEAD").trim();

    if (task.verify_cmd) {
      // The freshened tree needs its dependencies before anything can be run.
      primeWorktreeDeps(task.repo, dir, task.id);
      // Queues behind worker verifications on the shared verify semaphore (see
      // verifyenv.ts), so an integration check on the daemon's own timer cannot
      // land on top of a worker's suite. Its own event kind: verify.queued is
      // reserved for the Stop transition, whose stall predicate reads it.
      const result = await (deps.runVerify ??
        ((cmd: string, cwd: string) =>
          runVerifyCommand(cmd, cwd, {
            onQueued: (ahead) =>
              logEvent("pr.freshen_verify_queued", {
                taskId: task.id,
                payload: { ahead },
              }),
          })))(task.verify_cmd, dir);
      // Verification can run for minutes. If the world moved on while it did —
      // the human merged or closed the PR, the task was cancelled, a worker was
      // spawned — this result is stale: pushing or respawning off it would
      // resurrect a finished task. Re-derive from current state and drop it.
      const current = getTask(task.id);
      if (!current || !isFreshenCandidate(current) || agentLive(task.id)) {
        logEvent("pr.freshen_abandoned", {
          taskId: task.id,
          payload: {
            reason: "task moved on while its verification ran",
            status: current?.status ?? null,
            pr_state: current?.pr_state ?? null,
          },
        });
        return "abandoned";
      }
      if (!result.ok) {
        const respawned = respawnForIntegration(
          task,
          verifyFailBrief({
            taskId: task.id,
            branch,
            defaultBranch,
            prUrl: task.pr_url,
            resultSummary: task.result_summary,
            verifyCmd: task.verify_cmd,
            round: attempts + 1,
            output: result.output,
          }),
          deps,
        );
        logEvent("pr.freshen_verify_failed", {
          taskId: task.id,
          payload: {
            branch,
            verify_cmd: task.verify_cmd,
            output: result.output.slice(-2000),
            respawned,
            attempt: attempts + 1,
          },
        });
        return "verify_failed";
      }
    }

    try {
      // Plain push of the merge commit to the task's own branch: it updates the
      // PR in place, and a non-fast-forward is rejected rather than forced.
      pushQuiet(dir, `HEAD:refs/heads/${branch}`);
    } catch (err) {
      logEvent("pr.freshen_error", {
        taskId: task.id,
        payload: {
          error: err instanceof Error ? err.message : String(err),
          phase: "push",
        },
      });
      return "error";
    }

    // A conflict-free merge takes every hunk from exactly one side, so the
    // branch's own diff against the default branch is unchanged — the reviewed
    // content is identical and the approval still holds. Carry the approved SHA
    // forward so the "approved SHA == branch HEAD" invariant survives and the
    // human's ready-to-merge PR is not re-drafted for a mechanical merge.
    // ONLY when the local ref moved too: otherwise the review loop still reads
    // the old local tip, and advancing the recorded SHA would make the approval
    // look stale and trigger a pointless re-review.
    const localSynced = syncLocalBranch(task, branch, mergeSha);
    const carriedApproval =
      localSynced &&
      task.review_verdict === "approve" &&
      task.review_head_sha === tipSha;
    if (carriedApproval) {
      updateTask(task.id, { review_head_sha: mergeSha });
      // The "approved & ready to merge" push is latched per approved SHA, so a
      // carried approval has to carry its latch too — otherwise the next sweep
      // re-announces the same PR just because a merge commit moved its HEAD.
      //
      // Carry it ONLY when it was genuinely held for the pre-merge SHA. That
      // latch exists iff the human was actually told, and notify.ts claims it
      // only after a successful dispatch precisely so an undelivered push (no
      // ntfy URL configured yet, or a PR still stuck in draft because
      // `gh pr ready` failed) is still owed and fires later. Claiming the new
      // key unconditionally would swallow that owed push forever: the PR would
      // sit mergeable and silent, since notifyApprovedReady's standing-state
      // call is exactly what recovers a PR that only left draft after approval.
      if (notifyLatched(approvedReadyLatchKey(task.id, tipSha))) {
        latchNotify(
          approvedReadyLatchKey(task.id, mergeSha),
          "review_approved_ready",
          task.id,
        );
      }
    }
    logEvent("pr.freshened", {
      taskId: task.id,
      payload: {
        branch,
        base: `origin/${defaultBranch}`,
        merge_sha: mergeSha.slice(0, 12),
        verified: Boolean(task.verify_cmd),
        local_ref_synced: localSynced,
        approval_carried: carriedApproval,
        attempt: attempts + 1,
      },
    });
    return "pushed";
  } finally {
    cleanup();
  }
}

/**
 * Freshen every open agent PR that has fallen behind its repo's default branch,
 * up to this pass's budget. Repos are resolved once each: the fetch is the only
 * network cost when everything is already up to date.
 */
export async function freshenPass(deps: FreshenDeps = {}): Promise<void> {
  const cfg = getIntegrationSettings();
  if (!cfg.auto_freshen) return;
  const candidates = freshenCandidates();
  if (candidates.length === 0) return;

  const byRepo = new Map<string, Task[]>();
  for (const task of candidates) {
    const list = byRepo.get(task.repo);
    if (list) list.push(task);
    else byRepo.set(task.repo, [task]);
  }

  let budget = cfg.freshen_per_pass_limit;
  for (const [repo, tasks] of byRepo) {
    // Resolved lazily and once per repo: the fetch is the only network cost, and
    // a pass that has spent its budget should not pay it at all.
    let defaultBranch: string | undefined;
    for (const task of tasks) {
      if (budget <= 0) {
        // A merge burst queues rather than storming: the remaining PRs are
        // picked up on the next pass. Recorded so the cap is never silent.
        logEvent("pr.freshen_deferred", {
          taskId: task.id,
          payload: { reason: "per-pass limit", limit: cfg.freshen_per_pass_limit },
        });
        continue;
      }
      if (defaultBranch === undefined) {
        const resolved = fetchOriginDefaultBranch(repo);
        if (!resolved.ok) {
          logEvent("pr.freshen_error", {
            payload: { repo, error: resolved.reason, phase: "default-branch" },
          });
          break; // no default branch to merge: every task in this repo waits
        }
        defaultBranch = resolved.branch;
      }
      let outcome: FreshenOutcome;
      try {
        outcome = await freshenTask(task, defaultBranch, deps);
      } catch (err) {
        logEvent("pr.freshen_error", {
          taskId: task.id,
          payload: {
            error: err instanceof Error ? err.message : String(err),
            phase: "unexpected",
          },
        });
        outcome = "error";
      }
      // "fresh" and "halted" did no work, so they never consume the budget.
      if (outcome !== "fresh" && outcome !== "halted") budget--;
    }
  }
}

/**
 * Has this exact situation already been nudged? Keyed off the event trail rather
 * than the push latch, so the nudge stays once-per-approval even on a machine
 * with no ntfy URL configured (where notifyEvent never claims its latch).
 */
function alreadyNudged(taskId: number, key: string): boolean {
  const previous = latestTaskEvent(taskId, ["pr.merge_nudge"]);
  if (!previous?.payload) return false;
  try {
    return (JSON.parse(previous.payload) as { key?: unknown }).key === key;
  } catch {
    return false;
  }
}

/**
 * The merge-latency nudge.
 *
 * The conflict window IS merge latency: an approved PR that sits open while
 * other tasks in the same repo move is what creates the conflicts freshening
 * then has to repair. Merging is the human's call and is NEVER automated — this
 * only says, once per approval, that waiting has started to cost something.
 *
 * The discriminator is the id of the `review.approved` event, NOT the approved
 * SHA: freshening deliberately advances review_head_sha onto its merge commit
 * for the same standing approval (see freshenTask), so a SHA-keyed nudge would
 * mint a new key — and push again — on every clean re-merge. An event id moves
 * only when a reviewer actually approves again, which is exactly when a second
 * nudge is warranted. Rows old enough to have no such event fall back to a
 * constant key, so they nudge at most once rather than once per freshen.
 */
export function mergeNudgePass(now: Date): void {
  const cfg = getIntegrationSettings();
  const window = cfg.merge_nudge_minutes;
  if (!window) return;
  const tasks = listTasks();
  for (const task of tasks) {
    if (task.status !== "review" || task.review_verdict !== "approve") continue;
    if (!task.pr_url || task.open_pr === 0) continue;
    if (normalizePrState(task.pr_state) !== "open") continue;
    if (task.pr_is_draft === 1) continue; // not through internal review yet
    const approved = latestTaskEvent(task.id, ["review.approved"]);
    // updated_at is only a fallback for rows predating the event: it is bumped
    // by any task write (a carried-approval freshen included), so it is never
    // the preferred anchor for either the window or the key.
    const approvedAt = approved?.ts ?? task.updated_at;
    if (now.getTime() - Date.parse(approvedAt) < window * 60_000) continue;
    const contenders = repoContenders(task, tasks);
    if (contenders.length === 0) continue; // nothing is waiting on this merge

    const key = approved ? `approval:${approved.id}` : "approval";
    if (alreadyNudged(task.id, key)) continue;
    logEvent("pr.merge_nudge", {
      taskId: task.id,
      payload: {
        key,
        pr_url: task.pr_url,
        waiting_minutes: Math.floor(
          (now.getTime() - Date.parse(approvedAt)) / 60_000,
        ),
        contenders: contenders.map((t) => t.id),
      },
    });
    notifyEvent(
      "merge_latency",
      `task #${task.id} — approved PR waiting while its repo moves on`,
      `${task.title}\n${task.pr_url}\nApproved and mergeable for ${Math.floor(
        (now.getTime() - Date.parse(approvedAt)) / 60_000,
      )}m while ${contenders.length} other task(s) in the same repo are active. Merging it now keeps the other branches from having to be re-merged.`,
      {
        tags: "hourglass",
        taskId: task.id,
        once: `task:${task.id}:merge_nudge:${key}`,
      },
    );
  }
}

/**
 * The integration pass prsync runs: freshen behind PRs, then nudge on merge
 * latency. Never throws — an integration failure must not take the PR poll with
 * it. Re-entrancy is latched: a pass whose verification runs for minutes will
 * not be started a second time by the next poll.
 */
export async function integrationPass(deps: FreshenDeps = {}): Promise<void> {
  if (passInFlight) return;
  passInFlight = true;
  try {
    await freshenPass(deps);
    mergeNudgePass((deps.now ?? (() => new Date()))());
  } catch (err) {
    logEvent("pr.freshen_error", {
      payload: {
        error: err instanceof Error ? err.message : String(err),
        phase: "pass",
      },
    });
  } finally {
    passInFlight = false;
  }
}
