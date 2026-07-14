import { type Agent, listAgents, updateAgent } from "../db/agents.js";
import { dueCrons, nextRun, openTasksFor, updateCron } from "../db/crons.js";
import {
  countEventsToday,
  countTaskEvents,
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
import { notify } from "./notify.js";
import { killAgent, spawnWorker } from "./spawn.js";
import { listWindowIds } from "./tmux.js";
import { versionInfo } from "./version.js";

/** Task statuses that mean the worker has nothing left to do — safe to reap. */
const TERMINAL_STATUSES = ["done", "cancelled", "failed"];
/** capacity_blocked / budget events fire at most this often (throttle). */
const BLOCKED_EVENT_THROTTLE_MS = 60 * 60_000;

export interface SchedulerDeps {
  spawn: (taskId: number) => void;
  /** Kill an agent's window and mark it dead (no requeue, no worktree rm). */
  kill?: (agentId: number) => void;
  windowIds: () => string[];
  now: () => Date;
}

const defaultDeps: SchedulerDeps = {
  spawn: (id) => void spawnWorker(id),
  kill: (id) => void killAgent(id),
  windowIds: listWindowIds,
  now: () => new Date(),
};

// module state for edge-triggered behavior (reset via _resetSchedulerState)
let lastInWindow: boolean | null = null;
let budgetNotifiedDay: string | null = null;

export function _resetSchedulerState(): void {
  lastInWindow = null;
  budgetNotifiedDay = null;
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
      model: cron.model ?? undefined,
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

  fireDueCrons(now);
  const inWin = cfg.active_hours ? inActiveWindow(cfg.active_hours, now) : true;

  // leaving the window while enabled -> morning report
  if (cfg.enabled && lastInWindow === true && !inWin) {
    sendWindowReport();
  }
  lastInWindow = inWin;

  if (!cfg.enabled || !inWin) return;

  const ready = readyTasks();
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

/** Health pass: reap vanished tmux windows (requeue once, then fail the
 *  task) and flag silent workers as stalled. Runs every 60s, even when the
 *  scheduler is disabled — it only observes and repairs, never spawns. */
export function watchdog(deps: SchedulerDeps = defaultDeps): void {
  const cfg = getSchedulerConfig();
  const kill = deps.kill ?? ((id: number) => void killAgent(id));
  const windowIds = deps.windowIds();
  const nowMs = deps.now().getTime();

  warnIfStale();

  for (const agent of listAgents({ live: true })) {
    // window gone -> agent is dead, whatever the DB thinks
    if (agent.tmux_target && !windowIds.includes(agent.tmux_target)) {
      updateAgent(agent.id, { state: "dead" });
      logEvent("agent.vanished", {
        agentId: agent.id,
        taskId: agent.task_id ?? undefined,
      });
      const task = agent.task_id ? getTask(agent.task_id) : undefined;
      if (task && ["in_progress", "claimed"].includes(task.status)) {
        const vanishes = countTaskEvents(task.id, "agent.vanished");
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

    // waiting_input was delegated to the main agent (hooks.ts); if nobody
    // rescued the worker within escalate_minutes, page the human — once per
    // wait episode (a fresh Notification starts a new episode).
    if (agent.kind !== "main" && agent.state === "waiting_input") {
      const waitStart = latestAgentEventTs(agent.id, ["hook.notification"]);
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
  setInterval(() => {
    try {
      tick();
    } catch (err) {
      console.error("scheduler tick failed:", err);
    }
  }, 30_000);
  setInterval(() => {
    try {
      watchdog();
    } catch (err) {
      console.error("watchdog failed:", err);
    }
  }, 60_000);
  console.log(
    `scheduler: ${getSchedulerConfig().enabled ? "ENABLED" : "disabled"} (toggle: agp scheduler on|off)`,
  );
}
