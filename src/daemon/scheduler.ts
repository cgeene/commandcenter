import { type Agent, listAgents, updateAgent } from "../db/agents.js";
import { dueCrons, nextRun, openTasksFor, updateCron } from "../db/crons.js";
import {
  countEventsToday,
  countTaskEvents,
  countTaskEventsAfter,
  latestAgentEvent,
  latestAgentEventTs,
  latestEventTs,
  latestTaskEvent,
  logEvent,
} from "../db/events.js";
import { getSchedulerConfig, type SchedulerConfig } from "../db/settings.js";
import { createTask, getTask, listTasks, updateTask } from "../db/tasks.js";
import { noteReworkOverCap, workerSlots } from "./capacity.js";
import { strandedReworkTasks } from "./review.js";
import { flushMainQueue } from "./notifqueue.js";
import { notifyEvent } from "./notify.js";
import { parsePane, type PendingPermission } from "./pane.js";
import { killAgent, paneAgeSeconds, spawnWorker } from "./spawn.js";
import { sweepVanishedPaneGroup, type PaneSweepResult } from "./proctree.js";
import {
  capturePane,
  listLiveWindowIds,
  type LiveWindowSnapshot,
} from "./tmux.js";
import { versionInfo } from "./version.js";
import { WAIT_HOOK_EVENTS } from "./waiting.js";
import { pruneScratchWorkspaces } from "./workspaces.js";
import { delegatePendingTaskToLiveMain } from "./orchestration.js";
import { dispatchableTasks } from "./serial.js";

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
  /** Kill what a vanished agent left running in its pane's process group. */
  sweepPaneGroup?: (panePid: number, ageSec: number) => PaneSweepResult;
}

const defaultDeps: SchedulerDeps = {
  spawn: (id) => void spawnWorker(id),
  kill: (id) => void killAgent(id),
  windowIds: listLiveWindowIds,
  now: () => new Date(),
  sweepPaneGroup: sweepVanishedPaneGroup,
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
      open_pr: cron.open_pr !== 0,
      auto_review: cron.auto_review !== 0,
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
  const ready = dispatchableTasks("direct");
  // Workers parked under a running reviewer hold no slot (see capacity.ts) —
  // during a review wave they would otherwise pin the fleet at zero throughput.
  const { counted: liveWorkers, parked } = workerSlots();
  let capacity = cfg.max_concurrent - liveWorkers.length;
  if (capacity <= 0) {
    // Ready work but no free slots: without this the scheduler no-ops silently
    // (the exact bug that let finished workers squat every slot). Surface it,
    // throttled so it's a once-an-hour heads-up, not a per-tick alarm.
    if (ready.length > 0) noteCapacityBlocked(cfg, liveWorkers, parked, now);
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
        notifyEvent(
          "capacity_or_budget",
          "scheduler budget reached",
          `${cfg.daily_spawn_limit} autonomous spawns today — pausing until tomorrow. Manual spawns still work; nothing is lost.`,
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
      notifyEvent(
        "task_blocked",
        `task #${task.id} blocked — could not start`,
        `${task.title}\nThe scheduler failed to spawn a worker: ${msg}\nIt will not retry on its own — fix the cause and requeue it.`,
        {
          priority: "high",
          tags: "rotating_light",
          taskId: task.id,
          once: `task:${task.id}:blocked:spawn_failed`,
        },
      );
    }
  }
}

/** Record (throttled) that the auto-spawn pass has ready work but no free
 *  slots, naming the workers holding them and their task statuses so the
 *  dashboard/attention panel can show WHY the queue stopped moving. */
function noteCapacityBlocked(
  cfg: SchedulerConfig,
  liveWorkers: Agent[],
  parked: Agent[],
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
    payload: {
      max_concurrent: cfg.max_concurrent,
      live_workers: liveWorkers.length,
      // Exempt parked workers are reported so "all slots taken" can never be
      // misread as "these idle review workers are the blockage".
      parked_workers: parked.length,
      workers,
    },
  });
  // The count is the ACTIVE-WORK set: workers parked under a live reviewer are
  // exempt, so they are reported separately rather than sending the human
  // hunting for a slot none of them hold.
  const parkedNote =
    parked.length > 0
      ? ` (+${parked.length} parked under review, not counted)`
      : "";
  notifyEvent(
    "capacity_or_budget",
    "scheduler stalled — no free slots",
    `${liveWorkers.length}/${cfg.max_concurrent} active-work slots taken while tasks wait${parkedNote} — check for workers idling on finished or already-reviewed work`,
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
  notifyEvent(
    "escalation",
    `${agent.kind === "main" ? "main agent" : `a${agent.id}`} needs ${trust ? "your trust decision" : "your startup approval"}`,
    trust
      ? `${agent.provider} is asking for a one-time workspace/repository trust decision. Answer it in Command Center; trust is intentionally never delegated to another model.`
      : `${agent.provider} is waiting for approval before its lifecycle hooks are ready. Answer it in Command Center — it cannot start until you do.`,
    {
      priority: "high",
      tags: "warning",
      agentId: agent.id,
      taskId: agent.task_id,
    },
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
  const sweepPaneGroup = deps.sweepPaneGroup ?? sweepVanishedPaneGroup;
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
      // The window is gone, but whatever the agent backgrounded is not: it has
      // been reparented to pid 1 and will run until the machine reboots. This
      // branch never calls killAgent (the task is requeued, not cancelled), so
      // the sweep has to happen here or nowhere. Clearing pane_pid marks the
      // pane swept; leaving it set would let a later kill sweep it twice.
      const sweep =
        agent.pane_pid !== null
          ? sweepPaneGroup(agent.pane_pid, paneAgeSeconds(agent, nowMs))
          : null;
      // A declined sweep means the pane is demonstrably still alive — this is a
      // false vanish, which recoverFalseVanishes may well undo on a later pass.
      // Keep pane_pid: recovery restores only `state`, so clearing it here
      // would leave a live agent with no handle and permanently disarm the
      // sweep for its eventual real death.
      const paneHandled = sweep !== null && sweep.outcome !== "declined";
      updateAgent(agent.id, {
        state: "dead",
        ...(paneHandled ? { pane_pid: null } : {}),
      });
      logEvent("agent.vanished", {
        agentId: agent.id,
        taskId: agent.task_id ?? undefined,
        payload:
          sweep && sweep.killed.length > 0
            ? { swept_pids: sweep.killed }
            : undefined,
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
          notifyEvent(
            "worker_stalled",
            `task #${task.id} requeued`,
            `${task.title} — its worker vanished; the scheduler will retry it once. Nothing needed from you yet.`,
            { tags: "recycle", taskId: task.id, agentId: agent.id },
          );
        } else {
          updateTask(task.id, { status: "failed" });
          logEvent("task.failed", { taskId: task.id });
          notifyEvent(
            "task_failed",
            `task #${task.id} failed — giving up`,
            `${task.title}\nIts worker vanished twice, so the scheduler stopped retrying. It will not run again until you requeue it.`,
            {
              priority: "high",
              tags: "x",
              taskId: task.id,
              agentId: agent.id,
              once: `task:${task.id}:failed:worker_vanished`,
            },
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
      notifyEvent(
        "worker_stalled",
        `a${agent.id} did not initialize`,
        `${agent.provider} SessionStart was not received; inspect its terminal and provider hook setup`,
        {
          priority: "high",
          tags: "warning",
          agentId: agent.id,
          taskId: agent.task_id,
        },
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
      // Early-reap the approved-awaiting-human-merge case too: an in-review
      // task the internal review already APPROVED, whose PR (if any) has
      // flipped ready (pr_is_draft=0), needs no live worker. PR #36's loop
      // covers the only sequels: approve→merge auto-completes and reaps, and a
      // post-approve rejection re-enters via requeue+respawn-with-session-resume
      // (applyVerdict's reject branch gets not_live from the reaped worker, so
      // it requeues and folds the notes into the respawn prompt). Reap keeps
      // the worktree (branch may still be read) exactly like the terminal case.
      // Require state "idle" so a mid-turn worker (working/waiting_input) or a
      // still-running fix round is never reaped; reject/null verdicts keep the
      // live in-session worker (an in-session resume is faster than a respawn).
      const terminal = task && TERMINAL_STATUSES.includes(task.status);
      const approvedAwaitingMerge =
        task &&
        task.status === "review" &&
        task.review_verdict === "approve" &&
        (task.publication_state === "awaiting_human" ||
          !task.open_pr ||
          task.pr_is_draft === 0) &&
        agent.state === "idle";
      if (task && (terminal || approvedAwaitingMerge)) {
        const last = Date.parse(agent.last_event_at ?? agent.spawned_at);
        if (nowMs - last > cfg.reap_after_minutes * 60_000) {
          kill(agent.id);
          logEvent("agent.reaped", {
            agentId: agent.id,
            taskId: task.id,
            payload: {
              task_status: task.status,
              reason: terminal ? "task_terminal" : "approved_awaiting_merge",
            },
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
          notifyEvent(
            "escalation",
            `a${agent.id}${agent.task_id ? ` (task #${agent.task_id})` : ""} needs your input`,
            `It has been waiting ${cfg.escalate_minutes}m+ and the orchestrator did not resolve it, so it is now yours — peek or attach to unblock it.`,
            {
              priority: "high",
              tags: "warning",
              agentId: agent.id,
              taskId: agent.task_id,
              once: `waiting:${agent.id}:${waitStart}`,
            },
          );
        }
      }
    }

    // silent too long while supposedly working -> stalled. Covers workers AND
    // reviewers (kind !== "main"): a frozen reviewer mid-review must surface
    // too, and this is a different detector from the idle-in-review ping
    // suppression (that keys on the idle_prompt hook + waiting_input; this
    // keys on a "working" agent going silent). "review" is included because a
    // resumed worker (PR feedback answered mid-review, input via /send) can be
    // working while the task shows review, and a reviewer's task is review by
    // definition — without it a resume/review that never unblocks would never
    // be surfaced to anyone.
    if (agent.kind !== "main" && agent.state === "working") {
      const last = Date.parse(agent.last_event_at ?? agent.spawned_at);
      if (nowMs - last > cfg.stall_minutes * 60_000) {
        const task = agent.task_id ? getTask(agent.task_id) : undefined;
        if (task && ["in_progress", "review"].includes(task.status)) {
          updateAgent(agent.id, { state: "stalled" });
          logEvent("agent.stalled", { agentId: agent.id, taskId: task.id });
          notifyEvent(
            "worker_stalled",
            `${agent.kind} a${agent.id} stalled on task #${task.id}`,
            `${task.title} — no activity for ${cfg.stall_minutes}m; peek or kill`,
            {
              priority: "high",
              tags: "hourglass",
              agentId: agent.id,
              taskId: task.id,
            },
          );
        }
      }
    }
  }

  reworkDispatchSweep(deps, nowMs);
}

/** Respawn attempts allowed per rejection. Past this the task is left queued
 *  for the human, named by the Needs-You item strandedReworkTasks feeds. */
const MAX_REWORK_DISPATCH_ATTEMPTS = 3;
/** Minimum gap between those attempts, so a task that cannot spawn at all
 *  cannot burn its whole budget inside one watchdog second. */
const REWORK_DISPATCH_RETRY_MS = 60_000;

/**
 * Restart a worker on work a review rejection sent back to the queue.
 *
 * A rejection is a continuation of work triage already judged and dispatched, so
 * it needs no fresh triage: spawnWorker resumes the worker's own provider session
 * with review_notes folded into the prompt (that is what the requeue was always
 * written to expect — see review.strandedReworkTasks for why nothing else
 * supplied it). Deliberately NOT part of the auto-spawn pass in `tick`: that pass
 * is the autonomous-work policy (active hours, daily budget, direct-dispatch
 * only), while this is control-plane reconciliation of work already started, the
 * same job as the rest of the watchdog. Rework is likewise never refused for
 * capacity, matching the in-place resume path.
 *
 * Runs from the watchdog, so it inherits the tmux-observability guard above —
 * spawning while tmux cannot be read would create windows nothing is tracking.
 */
export function reworkDispatchSweep(
  deps: SchedulerDeps = defaultDeps,
  nowMs: number = deps.now().getTime(),
): void {
  for (const { task, rejected } of strandedReworkTasks()) {
    const attempts = countTaskEventsAfter(
      task.id,
      "review.rework_dispatch_failed",
      rejected.id,
    );
    if (attempts >= MAX_REWORK_DISPATCH_ATTEMPTS) continue;
    if (attempts > 0) {
      const last = latestTaskEvent(task.id, ["review.rework_dispatch_failed"]);
      if (last && nowMs - Date.parse(last.ts) < REWORK_DISPATCH_RETRY_MS) continue;
    }
    try {
      deps.spawn(task.id);
      logEvent("review.rework_respawned", {
        taskId: task.id,
        payload: { round: task.review_cycles },
      });
      const respawned = getTask(task.id);
      if (respawned?.agent_id) noteReworkOverCap(task.id, respawned.agent_id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const attempt = attempts + 1;
      logEvent("review.rework_dispatch_failed", {
        taskId: task.id,
        payload: { error: msg, attempt, max: MAX_REWORK_DISPATCH_ATTEMPTS },
      });
      // Push only once the retries are used up: the standing Needs-You item is
      // already naming this task, so a transient first failure needs no page.
      if (attempt >= MAX_REWORK_DISPATCH_ATTEMPTS) {
        notifyEvent(
          "worker_stalled",
          `task #${task.id} — rejected work has nobody fixing it`,
          `${task.title}\nThe reviewer rejected round ${task.review_cycles} and the task went back to the queue, but a worker could not be started after ${attempt} attempts: ${msg}\nIt will not move on its own — spawn a worker for it, or fix the cause and requeue it.`,
          {
            priority: "high",
            tags: "rotating_light",
            taskId: task.id,
            once: `task:${task.id}:rework_undispatched:${rejected.id}`,
          },
        );
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
  notifyEvent(
    "daemon_stale_build",
    "agentd is running STALE code",
    `dist/ was rebuilt at ${v.dist_mtime} but the daemon started ${v.started_at}. Every change since then is silently not running — run: agp upgrade`,
    { priority: "high", tags: "warning", once: `daemon:stale:${v.dist_mtime}` },
  );
}

function sendWindowReport(): void {
  const tasks = listTasks();
  const count = (s: string) => tasks.filter((t) => t.status === s).length;
  notifyEvent(
    "window_report",
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
