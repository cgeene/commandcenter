import { logEvent } from "../db/events.js";
import {
  getQuotaAlertLatch,
  getQuotaSettings,
  setQuotaAlertLatch,
} from "../db/settings.js";
import { evaluateQuotaAlerts, sameQuotaLatch } from "../lib/quotaalert.js";
import type { LiveUsage } from "../lib/usage.js";
import { notify } from "./notify.js";

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
    // Persist the latch BEFORE sending: notify() is fire-and-forget, so a
    // crash between the two would otherwise re-page on the next poll.
    if (!sameQuotaLatch(before, latch)) setQuotaAlertLatch(latch);
    for (const alert of alerts) {
      logEvent(alert.event, { payload: alert.payload });
      notify(alert.title, alert.message, { priority: "high", tags: alert.tags });
    }
  } catch (err) {
    console.error("quota alert evaluation failed:", err);
  }
}
