import { getAgent, listAgents, type Agent } from "../db/agents.js";
import { logEvent } from "../db/events.js";
import { getSchedulerConfig } from "../db/settings.js";
import { getTask, readyTasks } from "../db/tasks.js";
import {
  clearQueuedNotifications,
  enqueueNotification,
  listQueuedNotifications,
  noteDeliveryAttempt,
  pendingDeliveryMains,
  type NotificationOrigin,
  type QueuedNotification,
} from "../db/notifications.js";
import type { AgentProvider } from "../providers.js";
import { notify } from "./notify.js";
import { parsePane } from "./pane.js";
import { resumeAgent } from "./resume.js";
import { capturePane, windowExists } from "./tmux.js";

const PANE_TAIL_LINES = 60;

/**
 * Orchestrator "worker aN is waiting for input" notifications are injected
 * into the MAIN agent's tmux prompt. Doing that while the human is mid-typing
 * there merges the injected text into their draft, and doing it mid-turn is
 * likewise unwanted. This module gates delivery on the main's prompt being
 * genuinely idle-and-empty, queuing otherwise and flushing (batched) when the
 * main next goes idle with a clear prompt.
 *
 * Queuing NEVER touches the waiting worker's state or its hook.notification
 * timestamp, so the scheduler's escalate-to-human page (scheduler.ts watchdog)
 * still fires on time regardless — the page goes to the human's phone, not the
 * prompt, so it is unaffected by any of this.
 */

/** Retry backoff for flushes deferred because the human was typing. Held in
 *  memory for speed, but mirrored onto the queued rows (attempts/next_retry_at)
 *  so a daemon restart reseeds it rather than retry-storming a prompt that was
 *  already backing off — see resumePendingDeliveries. */
const flushBackoff = new Map<number, { until: number; step: number }>();
const BACKOFF_STEPS_MS = [15_000, 30_000, 60_000, 120_000, 300_000];

/** Test-only: backoff is process-global but agent ids reset per in-memory db. */
export function __clearFlushBackoffForTests(): void {
  flushBackoff.clear();
}

function bumpBackoff(mainId: number, nowMs: number): number {
  const step = Math.min(flushBackoff.get(mainId)?.step ?? 0, BACKOFF_STEPS_MS.length - 1);
  const until = nowMs + BACKOFF_STEPS_MS[step];
  flushBackoff.set(mainId, { until, step: step + 1 });
  noteDeliveryAttempt(mainId, new Date(until).toISOString());
  return step;
}

/**
 * Re-adopt the delivery queue left behind by a previous daemon process.
 *
 * The rows themselves have always been durable, but nothing announced them at
 * boot and the backoff that paced their retries did not survive, so a delivery
 * deferred just before a restart came back with no trail at all — which is how
 * a "Notify Claude Main" click could vanish across two restarts with no error,
 * no event and no retry. This logs the resumption and restores each main's
 * backoff; the actual sending is the watchdog's job (scheduler.ts flushes every
 * idle main each tick), so no delivery is attempted here against a tmux session
 * that may not be up yet.
 */
export function resumePendingDeliveries(nowMs: number = Date.now()): number {
  let resumed = 0;
  for (const row of pendingDeliveryMains()) {
    resumed += row.pending;
    const until = row.next_retry_at ? Date.parse(row.next_retry_at) : NaN;
    if (Number.isFinite(until) && until > nowMs) {
      flushBackoff.set(row.main_id, {
        until,
        step: Math.min(row.attempts, BACKOFF_STEPS_MS.length - 1),
      });
    }
    logEvent("delivery.resumed_on_boot", {
      agentId: row.main_id,
      payload: {
        pending: row.pending,
        attempts: row.attempts,
        next_retry_at: row.next_retry_at,
      },
    });
  }
  return resumed;
}

/**
 * Persist one pending delivery and leave a trail that it happened. Returns
 * false when an equivalent delivery was already queued (a repeat click, or a
 * worker that pinged twice) so callers can tell the human "already queued"
 * instead of implying a fresh one was accepted.
 */
export function queueDelivery(n: {
  mainId: number;
  workerId?: number;
  taskId?: number;
  message: string;
  origin: NotificationOrigin;
  reason: string;
}): boolean {
  const { row, created } = enqueueNotification(n);
  logEvent("delivery.persisted", {
    agentId: n.mainId,
    taskId: n.taskId,
    payload: {
      origin: n.origin,
      reason: n.reason,
      worker_id: n.workerId ?? null,
      queued_id: row.id,
      duplicate: !created,
    },
  });
  return created;
}

function label(it: { worker_id: number | null; task_id: number | null }): string {
  return `a${it.worker_id}${it.task_id != null ? ` (task #${it.task_id})` : ""}`;
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * The message injected into the main agent. One queued item reproduces the
 * per-worker delegation prompt; several are batched into a single message so
 * the main is pinged once, not machine-gunned.
 */
export function buildDelegateMessage(
  items: Pick<QueuedNotification, "worker_id" | "task_id" | "message">[],
  escalateMinutes: number,
): string {
  if (items.length === 1) {
    const it = items[0];
    return `[commandcenter] ${label(it)} is waiting for input: "${it.message}". peek_worker(${it.worker_id}) to see exactly what it's asking, then try to unblock it yourself via send_to_worker (for a numbered menu send just the digit). Escalate to the human ONLY if it genuinely needs them: credentials, a judgment call that's theirs, or approval for something destructive/outside the worktree. If unresolved after ${escalateMinutes}m the human is paged automatically.`;
  }
  const list = items.map((it) => `${label(it)}: "${clip(it.message, 100)}"`).join("; ");
  return `[commandcenter] ${items.length} workers are waiting for input — ${list}. peek_worker(<id>) each to see what it's asking, then unblock what you can via send_to_worker (for a numbered menu send just the digit). Escalate to the human ONLY for genuine human calls: credentials, a judgment call that's theirs, or approval for something destructive/outside the worktree. Each is paged automatically if unresolved within ${escalateMinutes}m.`;
}

/** Why the main's composer is (or isn't) safe to type into. Everything except
 *  "clear" defers delivery; the variants exist so the reason is diagnosable. */
export type PromptClarity = "clear" | "draft" | "permission" | "unreadable";

/**
 * Inspect the main's composer. Capturing the pane is the only way to see a draft
 * the human is mid-typing — agent.state alone can't.
 *
 * Only a composer we can positively SEE, and see to be empty, counts as clear.
 * "I found no draft" is not the same claim as "I found an empty input line",
 * and conflating them is exactly how this gate failed in the wild: Claude Code
 * started painting a label into the composer's top border, the pane parser
 * stopped recognizing the frame, every read came back "no draft", and a worker
 * notification was typed into — and submitted with — a human's half-written
 * message. An unparseable capture is therefore "unreadable", never "clear".
 */
export function promptClarity(
  target: string,
  provider: AgentProvider = "claude",
): PromptClarity {
  let pane;
  try {
    // Styled capture so a dim ghost-text suggestion in the main's composer is
    // not mistaken for a human draft (which would wrongly block delivery).
    pane = parsePane(capturePane(target, PANE_TAIL_LINES, { escapes: true }), provider);
  } catch {
    return "unreadable";
  }
  if (pane.pending_permission) return "permission";
  if (!pane.composer_found) return "unreadable";
  return pane.unsubmitted_input === null ? "clear" : "draft";
}

/**
 * Neither reason for blocking delivery resolves on its own.
 *
 * "draft" needs the human: only they can submit or clear it, and a withheld
 * submit leaves an injected message merged into it. "unreadable" needs a code
 * change: the parser no longer recognizes the TUI's composer, exactly the
 * failure this task exists to fix, and it is a permanent steady state until
 * someone looks. Both therefore get the same treatment — an event on the first
 * attempt of a streak so it is diagnosable immediately, and a page to the human
 * once a streak reaches the threshold, so "bounded retry with eventual delivery"
 * cannot degrade into deferring forever behind a log line.
 *
 * "permission" is excluded: a main parked on its own permission prompt is
 * already surfaced (hooks.ts pages the human and parks the agent).
 */
export const BLOCKED_ESCALATE_AFTER = 10;
type BlockedReason = "draft" | "unreadable";
const blockedStreaks = new Map<number, { reason: BlockedReason; attempts: number }>();

function noteDeliveryBlocked(
  mainId: number,
  reason: BlockedReason,
  provider: AgentProvider,
): void {
  const prev = blockedStreaks.get(mainId);
  const attempts = prev?.reason === reason ? prev.attempts + 1 : 1;
  blockedStreaks.set(mainId, { reason, attempts });

  if (attempts === 1) {
    logEvent("main.delivery_blocked", { agentId: mainId, payload: { reason, provider } });
    return;
  }
  if (attempts !== BLOCKED_ESCALATE_AFTER) return;
  logEvent("main.delivery_blocked_escalated", {
    agentId: mainId,
    payload: { reason, attempts },
  });
  notify(
    "Orchestrator prompt is blocked",
    reason === "draft"
      ? `An unsubmitted draft in a${mainId}'s prompt has deferred ${attempts} deliveries. ` +
          `Submit or clear it so queued worker notifications can reach the orchestrator. ` +
          `(If a "[commandcenter]" message is merged into your text, that was an injection ` +
          `held back rather than submitted over you — delete it and send the rest.)`
      : `Command Center cannot read a${mainId}'s composer, so it has deferred ${attempts} ` +
          `deliveries and will keep deferring. The pane parser probably no longer matches ` +
          `the provider's TUI — worker notifications and task triage are not reaching the ` +
          `orchestrator until that is fixed.`,
    { priority: reason === "unreadable" ? "high" : "default", tags: "warning" },
  );
}

function noteDeliveryUnblocked(mainId: number): void {
  blockedStreaks.delete(mainId);
}

/** Test-only: the streak map is process-global but agent ids reset per db. */
export function __clearUnreadableLogForTests(): void {
  blockedStreaks.clear();
}

/**
 * Compare composer content to what we typed with ALL whitespace removed, not
 * merely collapsed. The composer is read back as trimmed physical rows joined
 * with " ", so a message the TUI hard-wrapped mid-word ("destruc" / "tive")
 * reconstructs with a space inside that word. Collapsing whitespace would call
 * that foreign content and withhold the submit on every single delivery —
 * stranding ~600 characters in the prompt and wedging all delivery behind the
 * "draft" that creates.
 */
function squashWhitespace(text: string): string {
  return text.replace(/\s+/g, "");
}

type SubmitVerdict = "submit" | "foreign_content" | "permission";

/**
 * Run once the message is in the composer but before Enter: it must hold
 * nothing but that message. A keystroke can land in the milliseconds between
 * reading the composer and typing into it, and submitting then would merge the
 * human's words into the notification and send the wreckage as their turn.
 * Leaving it unsubmitted instead keeps every character they typed on screen.
 *
 * A permission menu appearing in that window is the dangerous case: Enter would
 * confirm the highlighted option (usually "Yes"). promptClarity already refuses
 * to type into a menu, and this last line of defence must refuse to submit into
 * one — parsePane reports composer_found=false for a menu, so that check must
 * come first.
 *
 * Otherwise deliberately biased toward submitting: the composer was verified
 * empty moments earlier, so at worst a submit carries along the handful of
 * characters typed since, whereas a wrong withhold strands the message in the
 * prompt and blocks every later delivery.
 */
function submitVerdict(
  target: string,
  provider: AgentProvider,
  message: string,
): SubmitVerdict {
  let pane;
  try {
    pane = parsePane(capturePane(target, PANE_TAIL_LINES, { escapes: true }), provider);
  } catch {
    return "submit";
  }
  if (pane.pending_permission) return "permission";
  if (!pane.composer_found) {
    // Anomalous: the composer was read successfully moments ago at beforeType.
    // Submitting is still the lesser risk (see above), but it is worth knowing
    // about — a steady stream of these means the parser is losing the pane.
    logEvent("main.composer_unreadable_mid_send", { payload: { provider } });
    return "submit";
  }
  const seen = squashWhitespace(pane.unsubmitted_input ?? "");
  // `includes` also covers a composer clipped by pane height or still mid-repaint
  // (a subset of the message); "" is a substring of anything.
  return squashWhitespace(message).includes(seen) ? "submit" : "foreign_content";
}

/** Find the one live main agent with a tmux window, whatever its state. */
function liveMain(): Agent | undefined {
  return listAgents({ live: true }).find(
    (a) => a.kind === "main" && a.tmux_target !== null && windowExists(a.tmux_target),
  );
}

/**
 * The ONE gated primitive for injecting text into the main agent's composer.
 * Delivers `message` only when the prompt is genuinely safe to type into — an
 * input line we can see, holding nothing, with no permission menu up
 * (promptClarity) — and, unless `allowWorking` is set, only when the main is
 * idle so a delivery never fires mid-turn. Returns "delivered" on a confirmed
 * send; "deferred" on a busy/mid-draft/unreadable prompt, a lost race, or a
 * dead window — in which case the caller keeps the item queued for the next
 * Stop/idle/watchdog retry.
 *
 * The clarity check runs inside resumeAgent's guard rather than here, so it
 * happens immediately before the keystrokes instead of several tmux round trips
 * earlier, and a second check between the keystrokes and Enter refuses to submit
 * a composer that has picked up anything besides this message.
 *
 * Every path that writes to the main's prompt — task-triage delegation
 * (orchestration.ts), real-time worker-wait delegation and its flush (below),
 * and the startup/idle catch-up (hooks.ts) — funnels through here, so a human's
 * mid-typed draft can never be clobbered and no future caller can bypass the
 * gate by re-implementing (and drifting from) it.
 */
export async function deliverToMainIfClear(
  main: Agent,
  message: string,
  opts: { allowWorking?: boolean } = {},
): Promise<"delivered" | "deferred"> {
  const stateOk = opts.allowWorking
    ? ["working", "idle"].includes(main.state)
    : main.state === "idle";
  const target = main.tmux_target;
  if (!target || !stateOk) return "deferred";

  const outcome = await resumeAgent(main.id, message, {
    guard: {
      beforeType: () => {
        const clarity = promptClarity(target, main.provider);
        if (clarity === "clear") noteDeliveryUnblocked(main.id);
        else if (clarity !== "permission") {
          noteDeliveryBlocked(main.id, clarity, main.provider);
        }
        return clarity === "clear";
      },
      beforeSubmit: () => {
        const verdict = submitVerdict(target, main.provider, message);
        if (verdict === "submit") return true;
        // Held back rather than submitted over whatever else is in the pane. The
        // text stays in the composer, so the human sees both and keeps every
        // character they typed; the notification stays queued for a later retry,
        // and the draft it leaves behind is what noteDraftBlocked escalates.
        logEvent("notification.submit_withheld", {
          agentId: main.id,
          payload: { reason: verdict },
        });
        return false;
      },
    },
  });
  return outcome === "sent" ? "delivered" : "deferred";
}

/**
 * Route a waiting-worker notification to the main agent: deliver immediately
 * only when the main is idle with a clear prompt, otherwise queue it. With no
 * live main at all, fall back to paging the human directly (unchanged
 * behavior — there is no orchestrator to hand it to).
 */
export async function delegateToMain(worker: Agent, message: string): Promise<void> {
  const main = liveMain();
  const who = label({ worker_id: worker.id, task_id: worker.task_id });

  if (!main || !main.tmux_target) {
    notify(`${who} needs input`, message, { priority: "high", tags: "warning" });
    return;
  }

  const item = { worker_id: worker.id, task_id: worker.task_id, message };

  const delivered = await deliverToMainIfClear(
    main,
    buildDelegateMessage([item], getSchedulerConfig().escalate_minutes),
  );
  if (delivered === "delivered") {
    logEvent("waiting.delegated", {
      agentId: worker.id,
      taskId: worker.task_id ?? undefined,
      payload: { to: main.id, message },
    });
    return;
  }
  // Busy, mid-draft, or raced — queue instead of clobbering; the Stop hook and
  // idle-main watchdog flush it once the prompt is clear again.

  queueDelivery({
    mainId: main.id,
    workerId: worker.id,
    taskId: worker.task_id ?? undefined,
    message,
    origin: "worker_waiting",
    reason: `main_${main.state}`,
  });
  logEvent("notification.queued", {
    agentId: worker.id,
    taskId: worker.task_id ?? undefined,
    payload: { to: main.id, main_state: main.state },
  });
}

/**
 * Why a queued delivery is no longer worth making, or null if it still is.
 *
 * Late delivery of a moot ping is worse than no delivery: it sends the
 * orchestrator to triage a task somebody already dispatched, or to rescue a
 * worker that is long since unblocked. Both kinds are therefore re-validated
 * against live state at flush time, not just at enqueue time.
 */
function stalenessReason(
  it: QueuedNotification,
  readyTriageIds: Set<number>,
): string | null {
  if (it.origin === "task_triage") {
    if (it.task_id == null) return "no_task";
    const task = getTask(it.task_id);
    if (!task) return "task_gone";
    if (task.status !== "queued") return `task_${task.status}`;
    if (task.dispatch_mode !== "orchestrated") return "task_not_orchestrated";
    if (!readyTriageIds.has(task.id)) return "task_blocked";
    return null;
  }
  if (it.worker_id == null) return null;
  const worker = getAgent(it.worker_id);
  if (!worker) return "worker_gone";
  if (worker.state !== "waiting_input") return `worker_${worker.state}`;
  return null;
}

/** The batched triage half of a flush. A single row carries the full triage
 *  prompt that would have been delivered live, so it is sent verbatim; several
 *  collapse into one compact ping rather than concatenating whole prompts. */
export function buildTriageMessage(
  items: Pick<QueuedNotification, "task_id" | "message">[],
): string {
  if (items.length === 1) return items[0].message;
  const ids = items.map((it) => `#${it.task_id}`).join(", ");
  return `[commandcenter] ${items.length} tasks are awaiting your triage: ${ids}. Call get_task(<id>, verbose: true) on each — the compact default omits the prompt — study the full prompt, validate the scope and execution settings, then dispatch it. For portfolio tasks, never spawn the parent: mark it in_progress, create per-repository child tasks with parent_task_id set to the parent, preserve the parent's provider/model/reasoning effort unless you deliberately document an override, and spawn those isolated children.`;
}

export type FlushResult = "flushed" | "deferred" | "empty" | "not_live";

/**
 * Attempt to flush a main agent's queued deliveries as one batched message.
 * Re-checks the prompt immediately before sending (the human may have started
 * typing again since the trigger) and, on a busy prompt or failed send, leaves
 * the queue intact and backs off for the watchdog to retry. Stale entries are
 * dropped rather than delivered (see stalenessReason).
 *
 * `force` (the Stop-hook path) bypasses the backoff gate; the watchdog path
 * passes `nowMs` and respects it.
 */
export async function flushMainQueue(
  mainId: number,
  opts: { force?: boolean; nowMs?: number } = {},
): Promise<FlushResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const backoff = flushBackoff.get(mainId);
  if (!opts.force && backoff && nowMs < backoff.until) return "deferred";

  const queued = listQueuedNotifications(mainId);
  if (queued.length === 0) {
    flushBackoff.delete(mainId);
    return "empty";
  }

  const readyTriageIds = queued.some((it) => it.origin === "task_triage")
    ? new Set(readyTasks("orchestrated").map((t) => t.id))
    : new Set<number>();
  const stale: number[] = [];
  const items = queued.filter((it) => {
    const reason = stalenessReason(it, readyTriageIds);
    if (!reason) return true;
    stale.push(it.id);
    logEvent("delivery.expired", {
      agentId: mainId,
      taskId: it.task_id ?? undefined,
      payload: { origin: it.origin, reason, worker_id: it.worker_id, queued_id: it.id },
    });
    return false;
  });
  clearQueuedNotifications(stale);
  if (items.length === 0) {
    flushBackoff.delete(mainId);
    return "empty";
  }

  const main = getAgent(mainId);
  if (
    !main ||
    main.state === "dead" ||
    !main.tmux_target ||
    !windowExists(main.tmux_target)
  ) {
    return "not_live";
  }

  const triage = items.filter((it) => it.origin === "task_triage");
  const waits = items.filter((it) => it.origin !== "task_triage");
  // One send, however many pending deliveries it covers — the main is pinged
  // once, not machine-gunned, and a partial success cannot strand half the
  // queue behind a composer that went busy between two sends.
  const message = [
    triage.length > 0 ? buildTriageMessage(triage) : null,
    waits.length > 0
      ? buildDelegateMessage(waits, getSchedulerConfig().escalate_minutes)
      : null,
  ]
    .filter((part) => part !== null)
    .join("\n\n");

  // The flush fires from the main's Stop hook (just went idle) and the idle-main
  // watchdog, so allow a working main through — but still refuse a mid-draft
  // prompt. A deferred send (busy prompt or lost race) leaves the queue intact.
  const outcome = await deliverToMainIfClear(main, message, { allowWorking: true });
  if (outcome !== "delivered") {
    const step = bumpBackoff(mainId, nowMs);
    // First deferral of a streak only: the watchdog retries on a schedule, and
    // an event per retry would bury the feed.
    if (step === 0) {
      logEvent("delivery.deferred", {
        agentId: mainId,
        payload: { pending: items.length, main_state: main.state },
      });
    }
    return "deferred";
  }

  clearQueuedNotifications(items.map((it) => it.id));
  flushBackoff.delete(mainId);
  logEvent("delivery.delivered", {
    agentId: mainId,
    payload: {
      count: items.length,
      triage: triage.map((it) => it.task_id).filter((t) => t != null),
      workers: waits.map((it) => it.worker_id).filter((w) => w != null),
    },
  });
  if (waits.length > 0) {
    logEvent("notification.flushed", {
      agentId: mainId,
      payload: {
        count: waits.length,
        workers: waits.map((it) => it.worker_id).filter((w) => w != null),
      },
    });
  }
  // A queued triage ping that finally lands is a real delegation: record it so
  // the state-derived retry in orchestration.delegatePendingTaskToMain sees the
  // task as already delegated and does not deliver it a second time.
  for (const it of triage) {
    if (it.task_id != null) {
      logEvent("task.delegated_to_main", {
        taskId: it.task_id,
        agentId: mainId,
        payload: { via: "queue_flush" },
      });
    }
  }
  return "flushed";
}
