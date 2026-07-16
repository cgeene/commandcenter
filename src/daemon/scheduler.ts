import { type Agent, listAgents, updateAgent } from "../db/agents.js";
import { dueCrons, nextRun, openTasksFor, updateCron } from "../db/crons.js";
import {
  countEventsToday,
  countTaskEvents,
  latestAgentEvent,
  latestAgentEventTs,
  latestEventTs,
  logEvent,
} from "../db/events.js";
import { getSchedulerConfig, type SchedulerConfig } from "../db/settings.js";
import {
  createTask,
  getTask,
  listTasks,
  readyTasks,
  updateTask,
} from "../db/tasks.js";
import { flushMainQueue } from "./notifqueue.js";
import { notify } from "./notify.js";
import { parsePane, type PendingPermission } from "./pane.js";
import { killAgent, spawnWorker } from "./spawn.js";
import {
  capturePane,
  listLiveWindowIds,
  type LiveWindowSnapshot,
} from "./tmux.js";
import { versionInfo } from "./version.js";
import { WAIT_HOOK_EVENTS } from "./waiting.js";
import { pruneScratchWorkspaces } from "./workspaces.js";
import { delegatePendingTaskToLiveMain } from "./orchestration.js";

/** Task statuses that mean the worker has nothing left to do — safe to reap. */
const TERMINAL_STATUSES = ["done", "cancelled", "failed"];
/** capacity_blocked / budget events fire at most this often (throttle). */
const BLOCKED_EVENT_THROTTLE_MS = 60 * 60_000;

export interface SchedulerDeps {
  spawn: (taskId: number) => void;
  /** Kill an agent's window and mark it dead (no requeue, no worktree rm). */
  kill?: (agentId: number) => void;
  windowIds: () => LiveWindowSnapshot;
  now: () => Date;
  pendingPermission?: (agent: Agent) => PendingPermission | null;
}

const defaultDeps: SchedulerDeps = {
  spawn: (id) => void spawnWorker(id),
  kill: (id) => void killAgent(id),
  windowIds: listLiveWindowIds,
  now: () => new Date(),
  pendingPermission: (agent) => {
    if (!agent.tmux_target) return null;
    try {
      return parsePane(
        capturePane(agent.tmux_target, 80),
        agent.provider,
      ).pending_permission;
    } catch {
      return null;
    }
  },
};

// module state for edge-triggered behavior (reset via _resetSchedulerState)
let lastInWindow: boolean | null = null;
let budgetNotifiedDay: string | null = null;
let lastScratchPruneDay: string | null = null;
let tmuxObservationUnavailable = false;
const missingWindowChecks = new Map<number, number>();
const SESSION_START_TIMEOUT_MS = 90_000;
const WINDOW_MISSING_CONFIRMATIONS = 2;
const WATCHDOG_INTERVAL_MS = 10_000;

export function _resetSchedulerState(): void {
  lastInWindow = null;
  budgetNotifiedDay = null;
  lastScratchPruneDay = null;
  tmuxObservationUnavailable = false;
  missingWindowChecks.clear();
}

export function inActiveWindow(
  hours: { start: number; end: number },
  date: Date,
): boolean {
  const h = date.getHours();
  if (hours.start === hours.end) return true;
  if (hours.start < hours.end) return h >= hours.start && h < hours.end;
  return h >= hours.start || h < hours.end; // overnight wrap, e.g. 22 -> 6
}

/** Enqueue tasks for due crons. Fires even when the scheduler is disabled —
 *  crons only add to the queue; SPAWNING is still gated by the scheduler.
 *  The open-task guard stops a stuck queue from accumulating duplicates. */
export function fireDueCrons(now: Date): void {
  for (const cron of dueCrons(now)) {
    const advance = { last_run_at: now.toISOString(), next_run_at: nextRun(cron.schedule, now) };
    if (openTasksFor(cron.id) > 0) {
      updateCron(cron.id, advance);
      logEvent("cron.skipped", {
        payload: { cron_id: cron.id, name: cron.name, reason: "previous task still open" },
      });
      continue;
    }
    const task = createTask({
      title: cron.title,
      prompt: cron.prompt,
      repo: cron.repo,
      worker_provider: cron.worker_provider,
      model: cron.model ?? undefined,
      reasoning_effort: cron.reasoning_effort ?? undefined,
      priority: cron.priority,
      verify_cmd: cron.verify_cmd ?? undefined,
      cron_id: cron.id,
    });
    updateCron(cron.id, advance);
    logEvent("cron.fired", {
      taskId: task.id,
      payload: { cron_id: cron.id, name: cron.name },
    });
  }
}

/** Auto-spawn pass: claim ready tasks up to max_concurrent, within the
 *  active window, capped by the daily spawn budget. Runs every 30s. */
export function tick(deps: SchedulerDeps = defaultDeps): void {
  const cfg = getSchedulerConfig();
  const now = deps.now();

  const pruneDay = now.toISOString().slice(0, 10);
  if (lastScratchPruneDay !== pruneDay) {
    lastScratchPruneDay = pruneDay;
    try {
      const removed = pruneScratchWorkspaces(listTasks(), now);
      if (removed.length > 0) {
        logEvent("scratch.pruned", { payload: { count: removed.length } });
      }
    } catch {
      // Retention is best-effort and must never stop task scheduling.
      logEvent("scratch.prune_failed");
    }
  }

  fireDueCrons(now);
  const inWin = cfg.active_hours ? inActiveWindow(cfg.active_hours, now) : true;

  // leaving the window while enabled -> morning report
  if (cfg.enabled && lastInWindow === true && !inWin) {
    sendWindowReport();
  }
  lastInWindow = inWin;

  if (!cfg.enabled || !inWin) return;

  // Human/UI tasks are main-orchestrated; only explicit compatibility/cron
  // tasks retain the historical direct scheduler path, so capacity accounting
  // and spawning both operate on the direct-dispatch queue.
  const ready = readyTasks("direct");
  const liveWorkers = listAgents({ live: true }).filter(
    (a) => a.kind === "worker",
  );
  let capacity = cfg.max_concurrent - liveWorkers.length;
  if (capacity <= 0) {
    // Ready work but no free slots: without this the scheduler no-ops silently
    // (the exact bug that let finished workers squat every slot). Surface it,
    // throttled so it's a once-an-hour heads-up, not a per-tick alarm.
    if (ready.length > 0) noteCapacityBlocked(cfg, liveWorkers, now);
    return;
  }

  // auto-spawned reviewers draw from the same daily budget as worker spawns
  let spawnsToday =
    countEventsToday("scheduler.spawned") +
    countEventsToday("reviewer.auto_spawned");

  for (const task of ready) {
    if (capacity <= 0) break;
    if (spawnsToday >= cfg.daily_spawn_limit) {
      const day = now.toISOString().slice(0, 10);
      if (budgetNotifiedDay !== day) {
        budgetNotifiedDay = day;
        notify(
          "scheduler budget reached",
          `${cfg.daily_spawn_limit} autonomous spawns today — pausing until tomorrow (manual spawns still work)`,
          { priority: "high", tags: "moneybag" },
        );
        logEvent("scheduler.budget_reached");
      }
      break;
    }
    try {
      deps.spawn(task.id);
      logEvent("scheduler.spawned", { taskId: task.id });
      spawnsToday++;
      capacity--;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logEvent("scheduler.spawn_error", {
        taskId: task.id,
        payload: { error: msg },
      });
      // block it so the scheduler doesn't hot-loop on a broken task
      updateTask(task.id, {
        status: "blocked",
        result_summary: `scheduler spawn failed: ${msg}`,
      });
      notify(`task #${task.id} blocked`, `spawn failed: ${msg}`, {
        priority: "high",
        tags: "rotating_light",
      });
    }
  }
}

/** Record (throttled) that the auto-spawn pass has ready work but no free
 *  slots, naming the workers holding them and their task statuses so the
 *  dashboard/attention panel can show WHY the queue stopped moving. */
function noteCapacityBlocked(
  cfg: SchedulerConfig,
  liveWorkers: Agent[],
  now: Date,
): void {
  const last = latestEventTs("scheduler.capacity_blocked");
  if (last && now.getTime() - Date.parse(last) < BLOCKED_EVENT_THROTTLE_MS) {
    return;
  }
  const workers = liveWorkers.map((w) => {
    const task = w.task_id ? getTask(w.task_id) : undefined;
    return { agent_id: w.id, task_id: w.task_id, task_status: task?.status ?? null };
  });
  logEvent("scheduler.capacity_blocked", {
    payload: { max_concurrent: cfg.max_concurrent, live_workers: liveWorkers.length, workers },
  });
  notify(
    "scheduler stalled — no free slots",
    `${liveWorkers.length}/${cfg.max_concurrent} worker slots taken while tasks wait — check for idle workers holding slots`,
    { tags: "construction" },
  );
}

function pendingPermissionFor(
  deps: SchedulerDeps,
  agent: Agent,
): PendingPermission | null {
  try {
    return deps.pendingPermission?.(agent) ?? null;
  } catch {
    return null;
  }
}

function isTrustPermission(pending: PendingPermission): boolean {
  return (
    /trust/i.test(pending.question) ||
    pending.options.some((option) => /trust/i.test(option.label))
  );
}

function announceStartupPermission(
  agent: Agent,
  pending: PendingPermission,
): void {
  const trust = isTrustPermission(pending);
  updateAgent(agent.id, { state: "waiting_input" });
  logEvent("agent.startup_permission", {
    agentId: agent.id,
    taskId: agent.task_id ?? undefined,
    payload: { provider: agent.provider, kind: agent.kind, trust },
  });
  notify(
    `${agent.kind === "main" ? "main agent" : `a${agent.id}`} needs ${trust ? "trust review" : "startup approval"}`,
    trust
      ? `${agent.provider} is asking for a one-time workspace/repository trust decision. Review it in Command Center; trust is intentionally never delegated to another model.`
      : `${agent.provider} is waiting for approval before its lifecycle hooks are ready. Review it in Command Center.`,
    { priority: "high", tags: "warning" },
  );
}

/**
 * Repair the exact split-brain case caused by a false `agent.vanished`
 * observation: the DB says dead, but the same tmux target still has a live
 * process. Intentional kills win because a later `agent.killed` event blocks
 * recovery. Workers are restored only when their task has not been claimed by
 * a replacement.
 */
function recoverFalseVanishes(
  deps: SchedulerDeps,
  windowIds: string[],
): void {
  const live = listAgents({ live: true });
  for (const agent of listAgents().filter((candidate) => candidate.state === "dead")) {
    if (!agent.tmux_target || !windowIds.includes(agent.tmux_target)) continue;
    const vanished = latestAgentEvent(agent.id, ["agent.vanished"]);
    const killed = latestAgentEvent(agent.id, ["agent.killed"]);
    if (!vanished || (killed && killed.id > vanished.id)) continue;

    if (agent.kind === "main") {
      if (live.some((candidate) => candidate.kind === "main")) continue;
    } else if (agent.kind === "worker") {
      const task = agent.task_id ? getTask(agent.task_id) : undefined;
      const recoverable =
        task &&
        ((task.status === "queued" && task.agent_id === null) ||
          (["in_progress", "review"].includes(task.status) &&
            task.agent_id === agent.id));
      if (
        !recoverable ||
        live.some(
          (candidate) =>
            candidate.kind === "worker" && candidate.task_id === agent.task_id,
        )
      ) {
        continue;
      }
      if (task.status === "queued") {
        updateTask(task.id, { status: "in_progress", agent_id: agent.id });
        logEvent("task.recovered", { taskId: task.id, agentId: agent.id });
      }
    } else {
      const task = agent.task_id ? getTask(agent.task_id) : undefined;
      if (
        !task ||
        task.status !== "review" ||
        live.some(
          (candidate) =>
            candidate.kind === "reviewer" && candidate.task_id === agent.task_id,
        )
      ) {
        continue;
      }
    }

    const pending = pendingPermissionFor(deps, agent);
    const state = pending ? "waiting_input" : agent.session_id ? "working" : "spawning";
    updateAgent(agent.id, { state });
    missingWindowChecks.delete(agent.id);
    logEvent("agent.recovered", {
      agentId: agent.id,
      taskId: agent.task_id ?? undefined,
      payload: { state },
    });
    live.push({ ...agent, state });
    if (pending) announceStartupPermission({ ...agent, state }, pending);
  }
}

/** Health pass: confirm vanished tmux windows before requeueing, recover a
 *  false vanish if its process is still live, surface startup trust prompts,
 *  and flag silent workers as stalled. Runs every 10s even when scheduling is
 *  disabled. */
export function watchdog(deps: SchedulerDeps = defaultDeps): void {
  const cfg = getSchedulerConfig();
  const kill = deps.kill ?? ((id: number) => void killAgent(id));
  const windowIds = deps.windowIds();
  const nowMs = deps.now().getTime();

  warnIfStale();

  if (windowIds === null) {
    if (!tmuxObservationUnavailable) {
      tmuxObservationUnavailable = true;
      logEvent("watchdog.tmux_unavailable");
    }
    return;
  }
  if (tmuxObservationUnavailable) {
    tmuxObservationUnavailable = false;
    logEvent("watchdog.tmux_recovered");
  }

  recoverFalseVanishes(deps, windowIds);

  for (const agent of listAgents({ live: true })) {
    // A single missing snapshot is not enough to kill live control-plane
    // state. Confirm on the next watchdog pass so a transient tmux failure
    // cannot orphan still-running Claude/Codex processes.
    if (agent.tmux_target && !windowIds.includes(agent.tmux_target)) {
      const checks = (missingWindowChecks.get(agent.id) ?? 0) + 1;
      missingWindowChecks.set(agent.id, checks);
      if (checks < WINDOW_MISSING_CONFIRMATIONS) {
        logEvent("agent.window_missing", {
          agentId: agent.id,
          taskId: agent.task_id ?? undefined,
        });
        continue;
      }
      missingWindowChecks.delete(agent.id);
      updateAgent(agent.id, { state: "dead" });
      logEvent("agent.vanished", {
        agentId: agent.id,
        taskId: agent.task_id ?? undefined,
      });
      const task = agent.task_id ? getTask(agent.task_id) : undefined;
      if (task && ["in_progress", "claimed"].includes(task.status)) {
        // A false vanish that was reconciled does not consume the task's one
        // genuine retry budget.
        const vanishes =
          countTaskEvents(task.id, "agent.vanished") -
          countTaskEvents(task.id, "task.recovered");
        if (vanishes <= 1) {
          updateTask(task.id, { status: "queued", agent_id: null });
          logEvent("task.requeued", { taskId: task.id });
          notify(
            `task #${task.id} requeued`,
            `${task.title} — its worker vanished; will retry once`,
            { tags: "recycle" },
          );
        } else {
          updateTask(task.id, { status: "failed" });
          logEvent("task.failed", { taskId: task.id });
          notify(
            `task #${task.id} failed`,
            `${task.title} — worker vanished twice, giving up`,
            { priority: "high", tags: "x" },
          );
        }
      }
      continue;
    }
    missingWindowChecks.delete(agent.id);

    if (["spawning", "stalled"].includes(agent.state)) {
      const pending = pendingPermissionFor(deps, agent);
      if (pending) {
        announceStartupPermission(agent, pending);
        continue;
      }
    }

    if (
      agent.state === "spawning" &&
      nowMs - Date.parse(agent.spawned_at) > SESSION_START_TIMEOUT_MS
    ) {
      updateAgent(agent.id, { state: "stalled" });
      logEvent("agent.session_start_missing", {
        agentId: agent.id,
        taskId: agent.task_id ?? undefined,
        payload: { provider: agent.provider },
      });
      notify(
        `a${agent.id} did not initialize`,
        `${agent.provider} SessionStart was not received; inspect its terminal and provider hook setup`,
        { priority: "high", tags: "warning" },
      );
      continue;
    }

    // auto-reap: a worker whose task has reached a terminal state (done/
    // cancelled/failed) has nothing left to do, but it sits idle in tmux
    // forever — counted as live, silently starving max_concurrent. After a
    // grace period (reap_after_minutes, enough for a human to read the
    // terminal right after completion) kill its window and free the slot.
    // NEVER requeue and NEVER rm the worktree — the branch/worktree may still
    // be read by a dependent task or a reviewer. Reviewers (own worktree, may
    // still be reviewing) and the main agent are excluded by the kind check.
    if (agent.kind === "worker") {
      const task = agent.task_id ? getTask(agent.task_id) : undefined;
      if (task && TERMINAL_STATUSES.includes(task.status)) {
        const last = Date.parse(agent.last_event_at ?? agent.spawned_at);
        if (nowMs - last > cfg.reap_after_minutes * 60_000) {
          kill(agent.id);
          logEvent("agent.reaped", {
            agentId: agent.id,
            taskId: task.id,
            payload: { task_status: task.status },
          });
          continue;
        }
      }
    }

    // Retry flushing notifications queued for an idle main whose flush was
    // deferred because the human was mid-typing at Stop. flushMainQueue
    // re-checks the prompt and respects its own backoff; a busy prompt just
    // defers again. Fire-and-forget — a flush must never break the watchdog.
    if (agent.kind === "main" && agent.state === "idle") {
      void flushMainQueue(agent.id, { nowMs }).catch(() => {});
    }

    // waiting_input was delegated to the main agent (hooks.ts); if nobody
    // rescued the worker within escalate_minutes, page the human — once per
    // wait episode (a fresh provider wait hook starts a new episode).
    if (agent.kind !== "main" && agent.state === "waiting_input") {
      const waitStart = latestAgentEventTs(agent.id, [...WAIT_HOOK_EVENTS]);
      if (
        waitStart &&
        nowMs - Date.parse(waitStart) > cfg.escalate_minutes * 60_000
      ) {
        const escalated = latestAgentEventTs(agent.id, ["waiting.escalated"]);
        if (!escalated || escalated < waitStart) {
          logEvent("waiting.escalated", {
            agentId: agent.id,
            taskId: agent.task_id ?? undefined,
          });
          notify(
            `a${agent.id}${agent.task_id ? ` (task #${agent.task_id})` : ""} still needs input`,
            `waiting ${cfg.escalate_minutes}m+ and the main agent didn't resolve it — peek or attach`,
            { priority: "high", tags: "warning" },
          );
        }
      }
    }

    // silent too long while supposedly working -> stalled. "review" is
    // included because resumed workers (PR feedback answered mid-review,
    // input delivered via /send) can be working while the task shows
    // review — without it, a resume that failed to unblock the agent
    // would never be surfaced to anyone.
    if (agent.kind === "worker" && agent.state === "working") {
      const last = Date.parse(agent.last_event_at ?? agent.spawned_at);
      if (nowMs - last > cfg.stall_minutes * 60_000) {
        const task = agent.task_id ? getTask(agent.task_id) : undefined;
        if (task && ["in_progress", "review"].includes(task.status)) {
          updateAgent(agent.id, { state: "stalled" });
          logEvent("agent.stalled", { agentId: agent.id, taskId: task.id });
          notify(
            `a${agent.id} stalled on task #${task.id}`,
            `${task.title} — no activity for ${cfg.stall_minutes}m; peek or kill --requeue`,
            { priority: "high", tags: "hourglass" },
          );
        }
      }
    }
  }
}

// Stale daemon = every feature since the last rebuild silently doesn't run.
// Warn once per rebuild, not once per minute.
let staleWarnedFor: string | null = null;

function warnIfStale(): void {
  const v = versionInfo();
  if (!v.stale || v.dist_mtime === staleWarnedFor) return;
  staleWarnedFor = v.dist_mtime;
  logEvent("daemon.stale", { payload: v });
  notify(
    "agentd is running STALE code",
    `dist/ was rebuilt at ${v.dist_mtime} but the daemon started ${v.started_at} — run: agp upgrade`,
    { priority: "high", tags: "warning" },
  );
}

function sendWindowReport(): void {
  const tasks = listTasks();
  const count = (s: string) => tasks.filter((t) => t.status === s).length;
  notify(
    "scheduler window closed — report",
    `done ${count("done")} · review ${count("review")} · blocked ${count("blocked")} · failed ${count("failed")} · queued ${count("queued")}`,
    { tags: "sunrise" },
  );
  logEvent("scheduler.window_report");
}

export function startScheduler(): void {
  const runOrchestrationRecovery = () => {
    void delegatePendingTaskToLiveMain().catch(() => {
      // Delivery is best-effort here; the task remains queued and the next
      // sweep, main lifecycle hook, or manual notify button retries it.
      logEvent("task.delegation_failed");
    });
  };
  const runWatchdog = () => {
    try {
      watchdog();
    } catch (err) {
      console.error("watchdog failed:", err);
    }
  };

  // Reconcile control-plane state as soon as the daemon returns. Waiting a
  // full minute would leave a still-running provider session orphaned after a
  // daemon restart or transient tmux observation failure.
  runWatchdog();
  runOrchestrationRecovery();
  setInterval(() => {
    try {
      tick();
    } catch (err) {
      console.error("scheduler tick failed:", err);
    }
  }, 30_000);
  setInterval(runWatchdog, WATCHDOG_INTERVAL_MS);
  setInterval(runOrchestrationRecovery, WATCHDOG_INTERVAL_MS);
  console.log(
    `scheduler: ${getSchedulerConfig().enabled ? "ENABLED" : "disabled"} (toggle: agp scheduler on|off)`,
  );
}
