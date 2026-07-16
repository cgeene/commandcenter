import { dismissedKeys } from "../db/attention.js";
import { listAgents } from "../db/agents.js";
import {
  countEventsToday,
  earliestEventTsAfter,
  latestAgentEvent,
  latestAgentEventTs,
  latestEventTs,
} from "../db/events.js";
import { getSchedulerConfig } from "../db/settings.js";
import { listTasks, readyTasks } from "../db/tasks.js";
import { reviewMaxCycles } from "./review.js";
import { prStates } from "./prcache.js";
import { WAIT_HOOK_EVENTS } from "./waiting.js";

/**
 * The "Needs You" action queue: an ordered list of things only the human can
 * do, derived purely from tasks/agents/events. Nothing here is persisted
 * except dismissals — recompute on every request and the queue self-heals as
 * the underlying state changes.
 */

export type AttentionKind =
  | "merge_pr"
  | "merge_and_apply"
  | "decision"
  | "escalation"
  | "stale_waiting"
  | "scheduler_stalled"
  | "orchestration";

export type Severity = "red" | "orange" | "yellow";

export interface AttentionItem {
  /** Stable dismissal key: kind + task/agent id + a re-trigger discriminator. */
  id: string;
  kind: AttentionKind;
  title: string;
  context: string;
  severity: Severity;
  /** Time-sensitive (merge_and_apply) — the UI badges it. */
  urgent: boolean;
  task_id: number | null;
  agent_id: number | null;
  pr_url: string | null;
  /** ISO instant the situation began — drives the age badge and sort. */
  created_at: string;
  age_ms: number;
}

const SEVERITY_RANK: Record<Severity, number> = { red: 3, orange: 2, yellow: 1 };

// terraform/gcloud/kubectl apply steps rot every day they go unapplied
// (e.g. the cost-allocation PR lost COGS history) — worth their own kind.
const APPLY_RE = /terraform apply|gcloud .* apply|kubectl apply/i;

// The scheduler emits capacity_blocked / budget_reached the moment auto-spawn
// stalls, but a brief stall is normal churn. Only nag the human once it has
// persisted past this — long enough that it's a real stuck queue, not a blip.
const SCHEDULER_STALL_MS = 15 * 60_000;

function excerpt(s: string | null | undefined, n = 200): string {
  if (!s) return "";
  const trimmed = s.trim();
  return trimmed.length > n ? trimmed.slice(0, n) + "…" : trimmed;
}

export interface DeriveDeps {
  now?: Date;
  /** OPEN/unknown -> true, MERGED/CLOSED -> false. */
  isPrOpen: (url: string) => boolean;
}

/**
 * Pure derivation over current DB state. `isPrOpen` is injected because the
 * only external dependency (a `gh` PR-state lookup) must be cached/awaited by
 * the caller before this synchronous pass runs.
 */
export function deriveAttention(deps: DeriveDeps): AttentionItem[] {
  const now = deps.now ?? new Date();
  const nowMs = now.getTime();
  const cfg = getSchedulerConfig();
  const dismissed = dismissedKeys();
  const tasks = listTasks();
  const agents = listAgents({ live: true });
  const items: AttentionItem[] = [];

  const push = (item: Omit<AttentionItem, "age_ms">) => {
    if (dismissed.has(item.id)) return;
    items.push({ ...item, age_ms: Math.max(0, nowMs - Date.parse(item.created_at)) });
  };

  // An orchestrated task must never silently fall back to the direct
  // scheduler. If Claude main is absent or blocked on its own input, make the
  // queue ownership visible to the human.
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const pendingOrchestration = tasks.filter((task) => {
    if (task.status !== "queued" || task.dispatch_mode !== "orchestrated") {
      return false;
    }
    return task.blocked_by === null || tasksById.get(task.blocked_by)?.status === "done";
  });
  const main = agents.find((agent) => agent.kind === "main");
  const mainAvailable = main && ["working", "idle"].includes(main.state);
  if (pendingOrchestration.length > 0 && !mainAvailable) {
    const ordered = [...pendingOrchestration].sort((a, b) => a.id - b.id);
    const oldest = ordered[0];
    const newest = ordered[ordered.length - 1];
    push({
      id: `orchestration:${newest.id}:${main?.id ?? "none"}`,
      kind: "orchestration",
      title: main
        ? `Unblock Claude main — ${pendingOrchestration.length} task${pendingOrchestration.length === 1 ? "" : "s"} awaiting triage`
        : `Start Claude main — ${pendingOrchestration.length} task${pendingOrchestration.length === 1 ? "" : "s"} awaiting triage`,
      context: `Oldest: #${oldest.id} ${oldest.title}`,
      severity: "yellow",
      urgent: false,
      task_id: oldest.id,
      agent_id: main?.id ?? null,
      pr_url: null,
      created_at: oldest.created_at,
    });
  }

  // --- merge_pr / merge_and_apply: approved work waiting on a human merge ---
  for (const t of tasks) {
    if (t.review_verdict !== "approve") continue;
    if (!t.pr_url || t.open_pr === 0) continue;
    if (t.status !== "review" && t.status !== "done") continue;
    // Defense in depth: a still-draft PR has not passed internal review, so it
    // must never be offered for merge. Approval flips it to ready (pr_is_draft
    // 0); pr_is_draft === 1 here means the ready-flip failed or is stale.
    if (t.pr_is_draft === 1) continue;
    if (!deps.isPrOpen(t.pr_url)) continue; // already merged/closed — nothing to do

    const apply = APPLY_RE.test(t.prompt);
    push({
      id: `${apply ? "merge_and_apply" : "merge_pr"}:${t.id}`,
      kind: apply ? "merge_and_apply" : "merge_pr",
      title: apply
        ? `Merge & apply PR — #${t.id} ${t.title}`
        : `Merge PR — #${t.id} ${t.title}`,
      context: excerpt(t.result_summary ?? t.review_notes),
      severity: apply ? "red" : "yellow",
      urgent: apply,
      task_id: t.id,
      agent_id: t.agent_id,
      pr_url: t.pr_url,
      created_at: t.updated_at,
    });
  }

  // --- decision: a task blocked after the review⇄fix loop was exhausted ---
  const maxCycles = reviewMaxCycles();
  for (const t of tasks) {
    if (t.status !== "blocked" || t.review_cycles < maxCycles) continue;
    push({
      // review_cycles in the key: a later cycle re-raises a dismissed item
      id: `decision:${t.id}:${t.review_cycles}`,
      kind: "decision",
      title: `Decision needed — #${t.id} ${t.title} (review loop exhausted after ${t.review_cycles} rounds)`,
      context: excerpt(t.review_notes ?? t.result_summary),
      severity: "orange",
      urgent: false,
      task_id: t.id,
      agent_id: t.agent_id,
      pr_url: t.pr_url,
      created_at: t.updated_at,
    });
  }

  // --- escalation: a live worker still waiting after the human was paged ---
  const escalated = new Set<number>();
  for (const a of agents) {
    if (a.kind === "main" || a.state !== "waiting_input") continue;
    const waitStart = latestAgentEventTs(a.id, [...WAIT_HOOK_EVENTS]);
    const esc = latestAgentEvent(a.id, ["waiting.escalated"]);
    // only if THIS wait episode was escalated (esc newer than the wait start)
    if (!waitStart || !esc || esc.ts < waitStart) continue;
    escalated.add(a.id);
    const task = a.task_id ? tasks.find((t) => t.id === a.task_id) : undefined;
    push({
      id: `escalation:a${a.id}:${esc.id}`, // event id -> new episode, new key
      kind: "escalation",
      title: task
        ? `Unblock a${a.id} — #${task.id} ${task.title}`
        : `Unblock a${a.id} — waiting for input`,
      context: task ? excerpt(task.result_summary) || task.title : "agent is waiting for input",
      severity: "red",
      urgent: false,
      task_id: a.task_id,
      agent_id: a.id,
      pr_url: task?.pr_url ?? null,
      created_at: esc.ts,
    });
  }

  // --- stale_waiting: a live agent parked in waiting_input past the threshold
  //     (skip any already surfaced as an escalation to avoid double-listing) --
  const staleMs = cfg.attention_stale_minutes * 60_000;
  for (const a of agents) {
    if (a.kind === "main" || a.state !== "waiting_input") continue;
    if (escalated.has(a.id)) continue;
    const waitStart = latestAgentEventTs(a.id, [...WAIT_HOOK_EVENTS]);
    if (!waitStart || nowMs - Date.parse(waitStart) < staleMs) continue;
    const task = a.task_id ? tasks.find((t) => t.id === a.task_id) : undefined;
    push({
      id: `stale_waiting:a${a.id}:${waitStart}`, // new wait episode -> new key
      kind: "stale_waiting",
      title: task
        ? `a${a.id} waiting — #${task.id} ${task.title}`
        : `a${a.id} waiting for input`,
      context: task ? excerpt(task.result_summary) || task.title : "agent is waiting for input",
      severity: "yellow",
      urgent: false,
      task_id: a.task_id,
      agent_id: a.id,
      pr_url: task?.pr_url ?? null,
      created_at: waitStart,
    });
  }

  // --- scheduler_stalled: auto-spawn has ready work it can't start, because
  //     every worker slot is held (idle finished workers squatting, the bug
  //     this whole feature exists to surface) or the daily budget is spent.
  //     Only shown once the blockage has persisted, and only when the
  //     scheduler is actually enabled (a disabled scheduler isn't "stalled"). -
  if (cfg.enabled) {
    const ready = readyTasks();
    if (ready.length > 0) {
      const liveWorkers = agents.filter((a) => a.kind === "worker");

      // capacity: all slots taken. Anchor to the FIRST capacity_blocked event
      // of the current episode (since the last successful spawn) so the age is
      // stable across the scheduler's hourly re-emits.
      if (cfg.max_concurrent - liveWorkers.length <= 0) {
        const since = latestEventTs("scheduler.spawned") ?? null;
        const anchor = earliestEventTsAfter("scheduler.capacity_blocked", since);
        if (anchor && nowMs - Date.parse(anchor) > SCHEDULER_STALL_MS) {
          const who = liveWorkers.map((w) => `a${w.id}`).join(", ");
          push({
            id: `scheduler_stalled:capacity:${anchor}`,
            kind: "scheduler_stalled",
            title: `Scheduler stalled — ${liveWorkers.length} idle workers holding slots`,
            context: `${ready.length} task${ready.length === 1 ? "" : "s"} ready but all ${cfg.max_concurrent} worker slots are taken (${who}); kill idle workers or raise max_concurrent`,
            severity: "yellow",
            urgent: false,
            task_id: null,
            agent_id: null,
            pr_url: null,
            created_at: anchor,
          });
        }
      }

      // budget: today's autonomous spawn budget is spent while work waits.
      const spawnsToday =
        countEventsToday("scheduler.spawned") +
        countEventsToday("reviewer.auto_spawned");
      if (spawnsToday >= cfg.daily_spawn_limit) {
        const anchor = latestEventTs("scheduler.budget_reached");
        if (anchor && nowMs - Date.parse(anchor) > SCHEDULER_STALL_MS) {
          push({
            id: `scheduler_stalled:budget:${anchor}`,
            kind: "scheduler_stalled",
            title: `Scheduler paused — daily spawn budget spent`,
            context: `${ready.length} task${ready.length === 1 ? "" : "s"} ready but ${spawnsToday}/${cfg.daily_spawn_limit} autonomous spawns used today; raise the limit or spawn manually`,
            severity: "yellow",
            urgent: false,
            task_id: null,
            agent_id: null,
            pr_url: null,
            created_at: anchor,
          });
        }
      }
    }
  }

  // severity desc, then oldest first (a problem that has festered ranks above
  // a fresh one of the same severity)
  items.sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.age_ms - a.age_ms,
  );
  return items;
}

/**
 * Build the queue for the API: resolve the (cached) open/closed state of every
 * approved task's PR, then run the pure derivation.
 */
export async function computeAttention(now = new Date()): Promise<AttentionItem[]> {
  const prUrls = listTasks()
    .filter(
      (t) =>
        t.review_verdict === "approve" &&
        t.pr_url &&
        t.open_pr !== 0 &&
        (t.status === "review" || t.status === "done"),
    )
    .map((t) => t.pr_url!);
  const states = await prStates(prUrls, now.getTime());
  const isPrOpen = (url: string) => {
    const s = states.get(url);
    return s !== "MERGED" && s !== "CLOSED"; // unknown/OPEN -> still actionable
  };
  return deriveAttention({ now, isPrOpen });
}
