import { logEvent } from "../db/events.js";
import {
  getQuotaAlertLatch,
  getQuotaSettings,
  setQuotaAlertLatch,
} from "../db/settings.js";
import { evaluateQuotaAlerts, sameQuotaLatch } from "../lib/quotaalert.js";
import type { LiveUsage } from "../lib/usage.js";
import { notifyEvent } from "./notify.js";

/**
 * The impure half of quota alerting: read the threshold and the latch, run the
 * pure evaluation (lib/quotaalert.ts), persist the new latch, and page.
 *
 * Called from the live-usage poller on SUCCESSFUL fetches only. A failed poll
 * leaves the previous reading in the cache, and paging off a stale number is
 * exactly the false alarm this feature must not produce — so a broken feed goes
 * quiet rather than noisy. For the same reason the whole body is wrapped: an
 * alerting bug must never turn a good usage refresh into a failed one.
 */
export function runQuotaAlerts(usage: LiveUsage | null, now = new Date()): void {
  try {
    const { alert_threshold_percent } = getQuotaSettings();
    const before = getQuotaAlertLatch();
    const { alerts, latch } = evaluateQuotaAlerts(
      usage,
      alert_threshold_percent,
      before,
      now,
    );
    // Persist the latch BEFORE sending: the push is fire-and-forget, so a
    // crash between the two would otherwise re-page on the next poll.
    //
    // This latch — not notifyEvent's generic `once` — stays the sole de-dup for
    // quota pages, so no `once` key is passed below. It is strictly richer than
    // a key could be: it re-arms when the rate-limit WINDOW rolls over or
    // utilization falls back below the line, and it is written before the send
    // rather than after. Passing `once` as well would add a second, weaker
    // gate that could only ever suppress a page this one already allowed.
    if (!sameQuotaLatch(before, latch)) setQuotaAlertLatch(latch);
    for (const alert of alerts) {
      logEvent(alert.event, { payload: alert.payload });
      // alert.kind is deliberately the notification event key: a new QuotaAlert
      // kind must fail to compile here until it is added to the catalog, rather
      // than quietly bypassing the Settings toggle.
      notifyEvent(alert.kind, alert.title, alert.message, {
        priority: "high",
        tags: alert.tags,
      });
    }
  } catch (err) {
    console.error("quota alert evaluation failed:", err);
  }
}
