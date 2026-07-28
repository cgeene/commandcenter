import { dismissedKeys } from "../db/attention.js";
import { listAgents } from "../db/agents.js";
import { liveUsageEnabled } from "../config.js";
import { workerSlots } from "./capacity.js";
import {
  countEventsToday,
  earliestEventTsAfter,
  latestAgentEvent,
  latestAgentEventTs,
  latestEventTs,
  latestTaskEvent,
  logEvent,
} from "../db/events.js";
import { JIRA_SYNC_FAIL_THRESHOLD } from "../lib/jira.js";
import { normalizePrState } from "../lib/prstate.js";
import { quotaConditions, quotaIsCritical } from "../lib/quotaalert.js";
import { resetsIn } from "../lib/usage.js";
import {
  getLiveUsageCache,
  getQuotaAlertLatch,
  getQuotaSettings,
  getSchedulerConfig,
} from "../db/settings.js";
import { listTasks, readyTasks } from "../db/tasks.js";
import { reviewMaxCycles } from "./review.js";
import { WAIT_HOOK_EVENTS } from "./waiting.js";

/**
 * The "Needs You" action queue: an ordered list of things only the human can
 * do, derived purely from tasks/agents/events. Nothing here is persisted
 * except dismissals — recompute on every request and the queue self-heals as
 * the underlying state changes.
 */

export type AttentionKind =
  | "publish_task"
  | "merge_pr"
  | "merge_and_apply"
  | "decision"
  | "escalation"
  | "stale_waiting"
  | "scheduler_stalled"
  | "orchestration"
  | "jira_sync"
  | "quota";

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
  /** Confirmed-open -> true. Merged, closed AND unknown -> false (see
   *  computeAttention: unknown fails closed). */
  isPrOpen: (url: string) => boolean;
}

/**
 * Pure derivation over current DB state. `isPrOpen` is injected so the PR
 * lifecycle policy (which states count as actionable, and what to do about an
 * unresolved one) lives in exactly one place — see computeAttention.
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

  // Automated review finished first; the human now reviews the exact approved
  // uncommitted tree and performs every publication action.
  for (const t of tasks) {
    if (
      t.publication_mode !== "human" ||
      t.publication_state !== "awaiting_human" ||
      t.review_verdict !== "approve" ||
      t.status !== "review"
    ) {
      continue;
    }
    push({
      id: `publish_task:${t.id}:${t.review_snapshot_tree ?? t.updated_at}`,
      kind: "publish_task",
      title: `Review and publish — #${t.id} ${t.title}`,
      context:
        "Automated review approved the snapshot. Review the uncommitted changes in GitHub Desktop, commit and publish them, then confirm publication.",
      severity: "yellow",
      urgent: false,
      task_id: t.id,
      agent_id: t.agent_id,
      pr_url: null,
      created_at: t.updated_at,
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

  // --- jira_sync: a task's JIRA ticket has failed to sync/create ≥ threshold
  //     times in a row. Mirrors the PR "sync broken" pattern (§5): the daemon
  //     already pages once via notify() at the threshold; this makes the
  //     degraded state a standing item until it's fixed or resolves. Anchored
  //     to the jira.sync_broken event (fired once per failure episode at the
  //     threshold) so a dismissed item re-raises with a fresh key on a NEW
  //     episode after a recovery, but a dismissal sticks while one episode's
  //     streak keeps climbing. ------------------------------------------------
  for (const t of tasks) {
    if ((t.jira_sync_fails ?? 0) < JIRA_SYNC_FAIL_THRESHOLD) continue;
    const broke = latestTaskEvent(t.id, ["jira.sync_broken"]);
    if (!broke) continue; // no episode anchor yet — daemon logs it at threshold
    const pending = !t.jira_key; // creation failing vs. sync of an existing key
    push({
      id: `jira_sync:${t.id}:${broke.id}`, // new episode -> new event id -> new key
      kind: "jira_sync",
      title: pending
        ? `JIRA ticket creation failing — #${t.id} ${t.title}`
        : `JIRA sync failing — #${t.id} ${t.title} (${t.jira_key})`,
      context: `${t.jira_sync_fails} consecutive JIRA ${pending ? "creation" : "sync"} failures; check CC_JIRA_TOKEN / config or JIRA availability`,
      severity: "orange",
      urgent: false,
      task_id: t.id,
      agent_id: t.agent_id,
      pr_url: t.pr_url,
      created_at: broke.ts,
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
      // Same accounting as the scheduler's auto-spawn pass: workers parked in
      // review are exempt, so they are never named as the blockage.
      const { counted: liveWorkers } = workerSlots({ agents, tasks });

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

  // --- quota: the live Claude feed says we are near (or past) a ceiling. The
  //     daemon pages once per crossing via runQuotaAlerts; this is the standing
  //     item, so the situation stays visible until the window rolls over or
  //     utilization drops.
  //
  //     Derived from the cached reading rather than the latch so it self-heals
  //     like every other kind here — the latch only supplies the crossing time
  //     (the age anchor) and the dismissal discriminator.
  //
  //     Two guards, because unlike tasks/agents/events this source can go
  //     STALE while still holding a hot value: usagelive's noteFailure keeps
  //     the last good `usage` on failure, and nothing clears it when the poller
  //     stops for good. So (a) an install that opted out of reading the
  //     credential surfaces nothing at all, and (b) quotaConditions discards a
  //     reading older than QUOTA_READING_MAX_AGE_MS. Without (b) a single poll
  //     that happened to catch spend.limit_reached would re-raise a red, urgent
  //     item on every render forever — that item has no reset instant to age it
  //     out the way the threshold item does. ---------------------------------
  const live = liveUsageEnabled()
    ? getLiveUsageCache()
    : { usage: null, error: null, checked_at: null };
  const quotaCond = quotaConditions(
    live.usage,
    getQuotaSettings().alert_threshold_percent,
    nowMs,
  );
  const quotaLatch = getQuotaAlertLatch();
  if (quotaCond.over) {
    const over = quotaCond.over;
    const pct = Math.round(over.percent);
    const left = resetsIn(over.resets_at, now);
    // The latch's crossing time only describes THIS window. It can legitimately
    // be left behind on an older one — alerting off, or an unreadable stretch,
    // leaves the latch untouched by design — and stamping a new window with an
    // hours-old instant would both mis-badge the age and mis-rank the item in
    // the oldest-first sort below.
    const crossedAt =
      quotaLatch.threshold_window === over.window ? quotaLatch.threshold_at : null;
    push({
      // Window id in the key: the next window is a new situation, so a
      // dismissal covers this crossing only.
      id: `quota:threshold:${over.window}`,
      kind: "quota",
      title: `Claude quota ${pct}% used — ${over.label}`,
      context: left
        ? `Past the ${over.threshold}% alert threshold; window resets in ${left}`
        : `Past the ${over.threshold}% alert threshold`,
      severity: quotaIsCritical(over.percent) ? "orange" : "yellow",
      urgent: false,
      task_id: null,
      agent_id: null,
      pr_url: null,
      created_at: crossedAt ?? live.usage?.fetched_at ?? now.toISOString(),
    });
  }
  if (quotaCond.spend_limit === true) {
    const since = quotaLatch.spend_limit_at ?? live.usage?.fetched_at ?? now.toISOString();
    push({
      id: `quota:spend_limit:${since}`, // a later episode re-raises a dismissal
      kind: "quota",
      title: "Claude spend limit reached",
      context:
        "Extra-usage spending is capped — agents will fail mid-task until the limit is raised or the cycle rolls over.",
      severity: "red",
      urgent: true,
      task_id: null,
      agent_id: null,
      pr_url: null,
      created_at: since,
    });
  }

  // severity desc, then oldest first (a problem that has festered ranks above
  // a fresh one of the same severity)
  items.sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.age_ms - a.age_ms,
  );
  return items;
}

/** Latch so a PR stuck without a resolvable state logs once per episode rather
 *  than once per poll — the dashboard hits /api/attention every couple of
 *  seconds. Re-arms as soon as a known state lands for that task. */
const unknownPrStates = new Set<string>();

/**
 * Build the queue for the API. A PR's lifecycle comes exclusively from the
 * tasks.pr_state column that prsync refreshes every two minutes — one source of
 * truth, free to read, and durable across daemon restarts.
 *
 * This makes NO `gh` calls, by design. The panel used to resolve states itself
 * through an in-memory cache, which cost it both ways: a cold start fanned one
 * `gh pr view` out per approved PR at once, and an unresolved state counted as
 * "still open", so a machine-wide `gh` outage right after a restart surfaced
 * every merged PR in history as a merge reminder (~91 items, 2026-07-28).
 * Reading a persisted column is burst-free and restart-proof. Two minutes of
 * staleness is immaterial for a panel a human reads.
 *
 * An unknown state — never synced, or a value normalizePrState doesn't
 * recognize — FAILS CLOSED: the merge item is withheld and the situation logged.
 * Prsync fills the column in on its next pass, so a genuine merge reminder is at
 * most one poll cycle late; ghost items, by contrast, cost the panel its
 * credibility.
 */
export async function computeAttention(now = new Date()): Promise<AttentionItem[]> {
  const open = new Map<string, boolean>();
  for (const t of listTasks()) {
    if (t.review_verdict !== "approve") continue;
    if (!t.pr_url || t.open_pr === 0) continue;
    if (t.status !== "review" && t.status !== "done") continue;
    const state = normalizePrState(t.pr_state);
    const key = `${t.id}:${t.pr_url}`;
    if (state === null) {
      if (!unknownPrStates.has(key)) {
        unknownPrStates.add(key);
        logEvent("attention.pr_state_unknown", {
          taskId: t.id,
          payload: {
            pr_url: t.pr_url,
            pr_state: t.pr_state,
            pr_synced_at: t.pr_synced_at,
            pr_sync_fails: t.pr_sync_fails,
          },
        });
      }
    } else {
      unknownPrStates.delete(key);
    }
    // Two tasks could in principle carry the same pr_url; a confirmed OPEN wins
    // over an unresolved one.
    open.set(t.pr_url, open.get(t.pr_url) === true || state === "open");
  }
  return deriveAttention({ now, isPrOpen: (url) => open.get(url) === true });
}

/** Test helper — the latch is module state, so a fresh DB needs a fresh latch. */
export function _resetPrStateLatch(): void {
  unknownPrStates.clear();
}
