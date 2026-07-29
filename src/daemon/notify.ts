import { logEvent } from "../db/events.js";
import { latchNotify, notifyLatched } from "../db/notifylatch.js";
import {
  resolveNotifyEventEnabled,
  resolveNtfyToken,
  resolveNtfyUrl,
} from "../db/settings.js";
import type { NotifyEventKey } from "../notify-events.js";
import { isDaemonProcess } from "../process-role.js";

/** A push a non-daemon process would have sent. Carries no URL and no token:
 *  the point of recording is what the operator would have read, and a
 *  verification script that dumps these must not print the topic URL. */
export interface RecordedPush {
  title: string;
  message: string;
  priority: "high" | "default" | "low";
  tags?: string;
}

/** Bounded: a long-lived non-daemon process (a watch-mode test run) must not
 *  accumulate these without limit. Oldest entries are dropped first. */
const RECORDED_LIMIT = 500;
const recorded: RecordedPush[] = [];

/** Pushes this process would have sent, oldest first. Always empty in the
 *  daemon, which sends them for real instead. */
export function recordedPushes(): readonly RecordedPush[] {
  return recorded;
}

export function clearRecordedPushes(): void {
  recorded.length = 0;
}

/**
 * Fire-and-forget push via ntfy (https://docs.ntfy.sh). No-op unless an ntfy
 * URL is configured (Settings tab overrides CC_NTFY_URL). Failures are
 * swallowed — push is best-effort and must never affect platform state.
 *
 * This is the raw transport. Call sites go through `notifyEvent` instead, so
 * every push is classified and individually switchable.
 *
 * Only the daemon puts a request on the network. Every other process that loads
 * this module — the test suite, a dist-driving verification script, the MCP
 * server, `node -e` — records the push in memory (see `recordedPushes`) and
 * sends nothing, so fixture rows can never reach the operator's phone. Both
 * paths behave identically to every caller, which keeps de-dup latches and
 * `notify.pushed` events assertable outside the daemon.
 *
 * Returns whether a URL is configured and the push was therefore ACCEPTED — not
 * whether it arrived. The fetch is fire-and-forget by design (a push must never
 * affect platform state), so a network error or a 4xx from ntfy still counts.
 * notifyEvent uses this to avoid burning a de-dup latch on a push that was
 * never even attempted; a push lost in flight is not recoverable.
 */
export function notify(
  title: string,
  message: string,
  opts?: { priority?: "high" | "default" | "low"; tags?: string },
): boolean {
  const url = resolveNtfyUrl();
  if (!url) return false;
  const priority = opts?.priority ?? "default";
  if (!isDaemonProcess()) {
    if (recorded.length >= RECORDED_LIMIT) recorded.shift();
    recorded.push({
      title,
      message,
      priority,
      ...(opts?.tags ? { tags: opts.tags } : {}),
    });
    return true;
  }
  const headers: Record<string, string> = { Title: title, Priority: priority };
  if (opts?.tags) headers.Tags = opts.tags;
  const token = resolveNtfyToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  fetch(url, { method: "POST", body: message, headers }).catch(() => {});
  return true;
}

export interface NotifyEventOpts {
  priority?: "high" | "default" | "low";
  tags?: string;
  taskId?: number | null;
  agentId?: number | null;
  /**
   * De-dup latch key. When given, the push fires at most once for that key,
   * ever (persisted). Bake the discriminator into the key — an approved SHA, a
   * round number, a streak count — so a genuinely new occurrence re-arms
   * naturally. Omit it for pushes that are edges rather than standing state
   * (the escalate tool, a per-day budget warning that already throttles itself),
   * and for callers that already own a richer escalate-once latch of their own
   * (quotaalert.ts — see the comment there for why layering both is wrong).
   */
  once?: string;
}

/**
 * The single entry point for every daemon push.
 *
 *  1. `event` classifies the push. Its default (src/notify-events.ts) decides
 *     whether it goes out at all; the operator can flip any event in Settings →
 *     Notifications.
 *  2. `once` de-duplicates a standing condition down to one push.
 *
 * Returns true when the push was accepted by the transport (see `notify`).
 */
export function notifyEvent(
  event: NotifyEventKey,
  title: string,
  message: string,
  opts?: NotifyEventOpts,
): boolean {
  if (!resolveNotifyEventEnabled(event)) return false;
  // Check before sending, claim after: a push that went nowhere (no ntfy URL
  // configured) must not consume the latch, or configuring the URL later would
  // leave the human permanently un-notified about it.
  if (opts?.once && notifyLatched(opts.once)) return false;
  const sent = notify(title, message, {
    priority: opts?.priority,
    tags: opts?.tags,
  });
  if (!sent) return false;
  if (opts?.once) latchNotify(opts.once, event, opts.taskId);
  logEvent("notify.pushed", {
    taskId: opts?.taskId ?? undefined,
    agentId: opts?.agentId ?? undefined,
    payload: {
      event,
      title,
      ...(opts?.once ? { once: opts.once } : {}),
      ...(isDaemonProcess() ? {} : { recorded_only: true }),
    },
  });
  return true;
}
