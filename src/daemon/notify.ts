import { logEvent } from "../db/events.js";
import { latchNotify, notifyLatched } from "../db/notifylatch.js";
import {
  resolveNotifyEventEnabled,
  resolveNtfyToken,
  resolveNtfyUrl,
} from "../db/settings.js";
import type { NotifyEventKey } from "../notify-events.js";

/**
 * Fire-and-forget push via ntfy (https://docs.ntfy.sh). No-op unless an ntfy
 * URL is configured (Settings tab overrides CC_NTFY_URL). Failures are
 * swallowed — push is best-effort and must never affect platform state.
 *
 * This is the raw transport. Call sites go through `notifyEvent` instead, so
 * every push is classified and individually switchable.
 *
 * Returns whether a request was DISPATCHED — i.e. a URL is configured — not
 * whether it arrived. The fetch is fire-and-forget by design (a push must never
 * affect platform state), so a network error or a 4xx from ntfy still counts as
 * dispatched. notifyEvent uses this to avoid burning a de-dup latch on a push
 * that was never even attempted; a push lost in flight is not recoverable.
 */
export function notify(
  title: string,
  message: string,
  opts?: { priority?: "high" | "default" | "low"; tags?: string },
): boolean {
  const url = resolveNtfyUrl();
  if (!url) return false;
  const headers: Record<string, string> = {
    Title: title,
    Priority: opts?.priority ?? "default",
  };
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
 * Returns true when a push was dispatched.
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
    payload: { event, title, ...(opts?.once ? { once: opts.once } : {}) },
  });
  return true;
}
