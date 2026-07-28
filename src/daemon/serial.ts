import { getIntegrationSettings } from "../db/settings.js";
import {
  listTasks,
  readyTasks,
  type DispatchMode,
  type Task,
} from "../db/tasks.js";
import { repoIsStrictSerial, serialRepoHolder } from "../lib/integration.js";

/**
 * The opt-in strict-serial repo gate.
 *
 * Default policy is the opposite of this: parallel tasks in one repo are fine
 * (worktrees isolate the work), overlap is judged at triage and sequenced with
 * `blocked_by`, and the integration window is handled by auto-freshening (see
 * src/daemon/freshen.ts). Some repos are still worth the blunt guarantee —
 * one active task at a time, no judgment required — so a repo can be listed in
 * Settings → integration.strict_serial_repos. Empty by default, so every
 * function here is a no-op until an operator opts a repo in.
 *
 * The gate is applied in two places, deliberately:
 *  - `spawnWorker` (src/daemon/spawn.ts) — the authoritative enforcement. Every
 *    route into a worker (scheduler, orchestrator MCP tool, respawn) passes it.
 *  - the ready queue (`dispatchableTasks`) — so the scheduler doesn't hot-loop
 *    on a task that cannot spawn, and the orchestrator isn't pinged to triage
 *    work it would immediately be refused.
 */

/**
 * The task currently occupying `task`'s repo under strict-serial rules, or
 * undefined when the repo isn't serialized or is free. Occupancy means an
 * actively-worked task (claimed/in_progress/review) or one still holding an
 * open agent PR — the PR is what conflicts, so it counts even after its worker
 * is gone. `task` itself never counts, so its own respawn is never gated.
 */
export function strictSerialHolder(task: Task): Task | undefined {
  const { strict_serial_repos: repos } = getIntegrationSettings();
  if (repos.length === 0) return undefined;
  if (!repoIsStrictSerial(task.repo, repos)) return undefined;
  return serialRepoHolder(task, listTasks());
}

/** One-line reason for a refused spawn / withheld dispatch. */
export function strictSerialReason(task: Task, holder: Task): string {
  return `repo ${task.repo} is configured strict-serial: task #${holder.id} (${holder.status}) is still active${
    holder.pr_url ? ` with an open PR (${holder.pr_url})` : ""
  } — finish or merge it first`;
}

/**
 * Ready tasks that may actually be dispatched now: `readyTasks` minus anything
 * a strict-serial repo is holding. Identical to readyTasks() when no repo is
 * serialized, which is the default.
 */
export function dispatchableTasks(mode?: DispatchMode): Task[] {
  const { strict_serial_repos: repos } = getIntegrationSettings();
  const ready = readyTasks(mode);
  if (repos.length === 0) return ready;
  const all = listTasks();
  return ready.filter(
    (task) =>
      !repoIsStrictSerial(task.repo, repos) || !serialRepoHolder(task, all),
  );
}
