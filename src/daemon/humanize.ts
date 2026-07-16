import type { Event } from "../db/events.js";

/**
 * Turn a raw platform event into a one-line human sentence for the dashboard's
 * narrated feed. Pure over the event (id/kind/task_id/agent_id + JSON payload)
 * so it's trivially testable and needs no DB lookups. Unknown kinds fall back
 * to "<kind> #<task> a<agent> <raw payload>" so nothing is ever swallowed.
 */

type Payload = Record<string, unknown>;

function payloadOf(e: Event): Payload {
  if (!e.payload) return {};
  try {
    const v = JSON.parse(e.payload);
    return v && typeof v === "object" ? (v as Payload) : {};
  } catch {
    return {};
  }
}

function str(v: unknown): string {
  return v == null ? "" : String(v);
}

/** Trim to n chars with an ellipsis, collapsing whitespace first. */
function clip(v: unknown, n: number): string {
  const s = str(v).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

const taskRef = (e: Event) => (e.task_id != null ? `#${e.task_id}` : "the task");
const worker = (e: Event) => (e.agent_id != null ? `worker ${e.agent_id}` : "a worker");
const agentRef = (e: Event) => (e.agent_id != null ? `agent ${e.agent_id}` : "an agent");

type Template = (e: Event, p: Payload) => string;

const TEMPLATES: Record<string, Template> = {
  // --- tasks ---
  "task.created": (e) => `New task ${taskRef(e)} queued`,
  "task.status": (e, p) =>
    `${taskRef(e)} moved ${str(p.from) || "?"} → ${str(p.to) || "?"}`,
  "task.claimed": (e) => `${taskRef(e)} claimed`,
  "task.review": (e) => `${taskRef(e)} is ready for review`,
  "task.blocked": (e, p) =>
    `${taskRef(e)} blocked${p.reason ? `: ${clip(p.reason, 80)}` : ""}`,
  "task.failed": (e) => `${taskRef(e)} failed`,
  "task.cancelled": (e) => `${taskRef(e)} cancelled`,
  "task.reopened": (e, p) =>
    `Reopened ${taskRef(e)}${p.reason ? ` (${clip(p.reason, 60)})` : ""}`,
  "task.requeued": (e, p) =>
    `Requeued ${taskRef(e)}${p.reason ? ` (${clip(p.reason, 60)})` : ""}`,
  "task.autocompleted": (e, p) =>
    `Auto-completed ${taskRef(e)}${p.reason ? ` (${clip(p.reason, 60)})` : ""}`,
  "task.recovered": (e) => `Recovered ${taskRef(e)} after a false window-loss signal`,
  "task.awaiting_main": (e) => `${taskRef(e)} is waiting for Claude main to triage it`,
  "task.delegated_to_main": (e) => `Sent ${taskRef(e)} to Claude main for triage`,
  "task.delegation_failed": () => `Main-agent task delivery will be retried`,

  // --- review ---
  "review.approved": (e, p) =>
    `Reviewer approved ${taskRef(e)}${p.notes ? `: ${clip(p.notes, 80)}` : ""}`,
  "review.rejected": (e, p) =>
    `Reviewer rejected ${taskRef(e)}${p.notes ? `: ${clip(p.notes, 80)}` : ""}`,
  "review.escalated": (e) =>
    `${taskRef(e)} escalated — too many rejected reviews`,
  "review.round_started": (e, p) => {
    const round = Number(p.round) || 0;
    const max = Number(p.max) || 0;
    return `Started review round ${round}${max ? `/${max}` : ""} for ${taskRef(e)}`;
  },
  "review.loop_exhausted": (e, p) => {
    const rounds = Number(p.rounds) || 0;
    return `${taskRef(e)} blocked — review loop exhausted after ${rounds} round${rounds === 1 ? "" : "s"}, human decision needed`;
  },
  "review.verdict_superseded": (e, p) =>
    `${taskRef(e)}'s approval was superseded by a new push (${clip(p.new_head, 12)}) — re-drafting and re-reviewing`,
  "reviewer.auto_spawned": (e) => `Auto-spawned a reviewer for ${taskRef(e)}`,
  "reviewer.spawned": (e) => `Spawned a reviewer for ${taskRef(e)}`,
  "reviewer.budget_skipped": (e) =>
    `Skipped auto-review of ${taskRef(e)} — daily spawn budget spent`,

  // --- verify ---
  "verify.passed": (e) => `${taskRef(e)} passed verification`,
  "verify.failed": (e) => `${taskRef(e)} failed verification`,

  // --- PRs ---
  // pr.merged now fires ONLY in the guarded override branch: a human merged the
  // PR of a rejected/cycle-capped task, which prsync deliberately does NOT
  // auto-complete (left for the orchestrator). A normal merge completes via
  // task.autocompleted, so this line must never claim the task is done.
  "pr.merged": (e) =>
    `PR merged for ${taskRef(e)} — left in review (rejected verdict; needs orchestrator)`,
  "pr.closed": (e) => `PR closed without merge — ${taskRef(e)} blocked`,
  "pr.feedback": (e, p) => {
    const n = Number(p.comments) || 0;
    const cr = p.changes_requested ? ", changes requested" : "";
    return `New PR feedback on ${taskRef(e)} (${n} comment${n === 1 ? "" : "s"}${cr})`;
  },
  "pr.human_approved": (e, p) => {
    const who = Array.isArray(p.reviewers) ? (p.reviewers as string[]).join(", ") : "";
    return `Human approved the PR for ${taskRef(e)}${who ? ` (${who})` : ""} — no changes requested`;
  },
  "pr.sync_error": (e, p) =>
    `PR sync failed for ${taskRef(e)}: ${clip(p.error, 80)}`,
  "pr.sync_broken": (e, p) =>
    `PR sync broken for ${taskRef(e)} after ${str(p.fails) || "several"} tries: ${clip(p.error, 80)}`,

  // --- agents ---
  "agent.spawned": (e) => `Spawned ${agentRef(e)}${e.task_id != null ? ` on ${taskRef(e)}` : ""}`,
  "agent.killed": (e) => `Killed ${agentRef(e)}`,
  "agent.stalled": (e) => `${worker(e)} stalled on ${taskRef(e)}`,
  "agent.reaped": (e, p) =>
    `Reaped ${worker(e)} — ${taskRef(e)} finished${p.task_status ? ` (${str(p.task_status)})` : ""}, freeing its slot`,
  "agent.vanished": (e) => `${worker(e)} vanished`,
  "agent.window_missing": (e) =>
    `${agentRef(e)} window missing once — awaiting confirmation`,
  "agent.recovered": (e) => `${agentRef(e)} recovered while its process was still live`,
  "agent.startup_permission": (e, p) =>
    `${agentRef(e)} needs ${p.trust ? "one-time trust review" : "startup approval"}`,
  "agent.sent": (e) => `Sent input to ${worker(e)}`,
  "agent.send_failed": (e) => `Failed to send input to ${worker(e)}`,
  "agent.input_submitted": (e) => `Submitted ${worker(e)}'s pending input`,
  "agent.input_cleared": (e) => `Cleared ${worker(e)}'s input`,
  "agent.auto_nudged": (e, p) => {
    const attempt = Number(p.attempt) || 0;
    return `Auto-nudged ${worker(e)} (transient API stall${attempt > 1 ? `, attempt ${attempt}` : ""})`;
  },

  // --- waiting / delegation ---
  "waiting.escalated": (e) => `Escalated ${worker(e)} — still waiting for input`,
  "waiting.delegated": (e) => `Delegated ${worker(e)}'s question to the main agent`,
  "notification.queued": (e) =>
    `Held ${worker(e)}'s notification — main agent's prompt was busy`,
  "notification.flushed": (_e, p) => {
    const n = Number(p.count) || 0;
    return `Delivered ${n} queued notification${n === 1 ? "" : "s"} to the main agent`;
  },

  // --- scheduler / crons ---
  "scheduler.spawned": (e) => `Scheduler spawned a worker for ${taskRef(e)}`,
  "scheduler.spawn_error": (e, p) =>
    `Scheduler failed to spawn for ${taskRef(e)}: ${clip(p.error, 80)}`,
  "scheduler.budget_reached": () => `Daily spawn budget reached`,
  "scheduler.capacity_blocked": (_e, p) => {
    const live = Number(p.live_workers) || 0;
    const max = Number(p.max_concurrent) || 0;
    return `Scheduler stalled — ${live}/${max} worker slots taken while tasks wait`;
  },
  "scratch.pruned": (_e, p) =>
    `Removed ${str(p.count) || "expired"} expired scratch workspace${Number(p.count) === 1 ? "" : "s"}`,
  "scratch.prune_failed": () => `Scratch workspace retention cleanup failed`,
  "cron.fired": (e, p) =>
    `Ran cron ${str(p.name) || `#${str(p.cron_id)}`} → ${taskRef(e)}`,
  "cron.skipped": (e, p) =>
    `Skipped ${str(p.name) || "a cron"}: ${clip(p.reason, 80) || "previous run still open"}`,
  "cron.created": (_e, p) => `Created cron ${str(p.name) || `#${str(p.cron_id)}`}`,
  "cron.updated": (_e, p) => `Updated cron #${str(p.cron_id)}`,
  "cron.deleted": (_e, p) => `Deleted cron #${str(p.cron_id)}`,

  // --- memory / docs ---
  "memory.added": () => `Stored a memory`,
  "memory.deleted": () => `Forgot a memory`,
  "memory.recalled": (_e, p) => {
    const n = Array.isArray(p.ids) ? p.ids.length : 0;
    return `Recalled ${n} ${n === 1 ? "memory" : "memories"}`;
  },
  "memory.injected": (e) => `Injected a memory into ${worker(e)}`,
  "doc.saved": (_e, p) =>
    `Saved doc ${str(p.project)}/${str(p.slug)}${p.created ? "" : " (updated)"}`,

  // --- worktrees ---
  "worktree.fallback_local_head": (e, p) =>
    `Cut ${taskRef(e)}'s worktree from local HEAD (${str(p.reason) || "no origin"}) — origin start-point unavailable`,
  "worktree.review_fallback_local_branch": (e, p) =>
    `Reviewing ${taskRef(e)} from a stale local branch — fetch failed (${clip(p.detail, 80) || "unknown error"})`,
  "worktree.review_local_branch_expected": (e, p) =>
    `Reviewing ${taskRef(e)} from the local branch (${str(p.reason) || "not on origin"}) — expected, origin has no newer copy`,

  // --- misc ---
  "main.escalated": (_e, p) => `Main agent escalated: ${clip(p.title, 80)}`,
  "attention.dismissed": () => `Dismissed a "needs you" item`,
  "scheduler.config": () => `Scheduler settings changed`,
  "watchdog.tmux_unavailable": () => `tmux health observation unavailable — no agents changed`,
  "watchdog.tmux_recovered": () => `tmux health observation recovered`,
  "daemon.stale": () => `Daemon is running stale code`,
};

export function humanizeEvent(e: Event): string {
  const p = payloadOf(e);
  const tmpl = TEMPLATES[e.kind];
  if (tmpl) return tmpl(e, p);
  // Unknown kind — never swallow it: show kind + refs + raw payload.
  const refs = [
    e.task_id != null ? `#${e.task_id}` : "",
    e.agent_id != null ? `a${e.agent_id}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const raw = e.payload ? ` ${clip(e.payload, 120)}` : "";
  return `${e.kind}${refs ? ` ${refs}` : ""}${raw}`;
}
