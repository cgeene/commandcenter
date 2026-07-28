/**
 * Quota alerting: decide when the live Claude usage feed warrants paging the
 * operator, and remember that we already did.
 *
 * The feed (daemon/usagelive.ts) polls hourly, so the naive "percent >= 80 ⇒
 * notify" would page once an hour for as long as the window stays hot. This is
 * the same escalate-once shape prsync/jirasync use for sync failures: fire on
 * the CROSSING, stay quiet while the condition persists, and re-arm only when
 * the situation genuinely changes — the rate-limit window rolls over, or
 * utilization falls back below the threshold.
 *
 * Fail-soft is the governing rule. A feed that is missing, erroring, or reports
 * a shape we can't read must never produce an alert, and must never disturb the
 * latch either — otherwise a flapping feed would page on every recovery.
 *
 * Pure: no db, no fetch, no node. Shared with the web bundle (src/lib pattern).
 */

import { resetsIn, type LiveUsage, type UsageMeter } from "./usage.js";

/** Default page-me line, as a percentage of the headline meter's window. */
export const QUOTA_ALERT_THRESHOLD_DEFAULT = 80;

/** Above this the item is drawn hotter — a meter this close to its ceiling is
 *  going to stop work inside the current window, not eventually. */
const CRITICAL_PERCENT = 95;

/**
 * The escalate-once state, persisted between polls (and across restarts).
 * `threshold_window` doubles as the latch flag and as the identity of what we
 * latched on: a different window id means a different crossing.
 */
export interface QuotaAlertLatch {
  /** Window id ({@link quotaWindowId}) the threshold page already fired for. */
  threshold_window: string | null;
  /** ISO instant that crossing was first observed — the item's age anchor. */
  threshold_at: string | null;
  /** Whether the spend-cap page already fired for the current episode. */
  spend_limit: boolean;
  spend_limit_at: string | null;
}

export const EMPTY_QUOTA_ALERT_LATCH: QuotaAlertLatch = {
  threshold_window: null,
  threshold_at: null,
  spend_limit: false,
  spend_limit_at: null,
};

/**
 * What the current reading says about the threshold, kept distinct from a plain
 * boolean because "we can't tell" and "we're fine" must be handled differently:
 *
 *  - `over`         — at/above the threshold in a window that is still running.
 *  - `below`        — measurably under it. Clears the latch.
 *  - `window_reset` — the window this reading describes has already elapsed, so
 *                     its percentage belongs to a cycle that is over. Clears the
 *                     latch (the next window gets a fresh page) but never pages
 *                     off the stale number itself.
 *  - `unknown`      — no feed, no headline percentage, or alerting disabled.
 *                     Leaves the latch untouched.
 */
export type QuotaThresholdState = "over" | "below" | "window_reset" | "unknown";

export interface QuotaOverage {
  /** Window identity — see {@link quotaWindowId}. */
  window: string;
  label: string;
  percent: number;
  resets_at: string | null;
  threshold: number;
}

export interface QuotaConditions {
  threshold_state: QuotaThresholdState;
  /** Set only when `threshold_state === "over"`. */
  over: QuotaOverage | null;
  /** Org spend cap. `null` = the payload carried no spend block at all. */
  spend_limit: boolean | null;
}

/**
 * Identity of the window a meter is measuring. The reset instant is part of it
 * so the next 5-hour window is a different window even though the meter key is
 * unchanged — that is what makes "reset, then cross again" page a second time.
 */
export function quotaWindowId(meter: UsageMeter): string {
  return `${meter.key}@${meter.resets_at ?? "-"}`;
}

/** Read the current situation off a cached usage snapshot. Never throws. */
export function quotaConditions(
  usage: LiveUsage | null,
  threshold: number | null,
  nowMs: number,
): QuotaConditions {
  const none: QuotaConditions = {
    threshold_state: "unknown",
    over: null,
    spend_limit: null,
  };
  if (!usage) return none;

  // A spend block that exists but reports false is real evidence the cap is not
  // hit; an absent block tells us nothing and must not clear the latch.
  const spend_limit = usage.spend ? usage.spend.limit_reached : null;
  const base = { ...none, spend_limit };

  const meter = usage.headline;
  if (threshold === null || !Number.isFinite(threshold)) return base;
  if (!meter || meter.percent === null) return base;

  if (meter.resets_at !== null) {
    const resets = Date.parse(meter.resets_at);
    if (Number.isFinite(resets) && resets <= nowMs) {
      return { ...base, threshold_state: "window_reset" };
    }
  }
  if (meter.percent < threshold) return { ...base, threshold_state: "below" };
  return {
    ...base,
    threshold_state: "over",
    over: {
      window: quotaWindowId(meter),
      label: meter.label,
      percent: meter.percent,
      resets_at: meter.resets_at,
      threshold,
    },
  };
}

/** A page to send. The daemon turns these into notify() + an event row. */
export interface QuotaAlert {
  kind: "quota_threshold" | "quota_spend_limit";
  event: string;
  title: string;
  message: string;
  tags: string;
  payload: Record<string, unknown>;
}

function thresholdAlert(over: QuotaOverage, now: Date): QuotaAlert {
  const left = resetsIn(over.resets_at, now);
  const pct = Math.round(over.percent);
  return {
    kind: "quota_threshold",
    event: "usage.quota_threshold",
    title: `Claude quota ${pct}% used`,
    message:
      `${over.label} is at ${pct}% of its limit (alert threshold ${over.threshold}%)` +
      (left ? `; resets in ${left}` : ""),
    tags: pct >= CRITICAL_PERCENT ? "rotating_light" : "warning",
    payload: {
      window: over.window,
      label: over.label,
      percent: over.percent,
      threshold: over.threshold,
      resets_at: over.resets_at,
    },
  };
}

function spendAlert(usage: LiveUsage): QuotaAlert {
  const spend = usage.spend;
  const limit =
    spend && spend.limit_usd !== null ? ` ($${spend.limit_usd.toFixed(2)} cap)` : "";
  return {
    kind: "quota_spend_limit",
    event: "usage.spend_limit_reached",
    title: "Claude spend limit reached",
    message:
      `Extra-usage spending has hit its limit${limit} — agents will start failing ` +
      `mid-task until the cap is raised or the cycle rolls over.`,
    tags: "rotating_light",
    payload: {
      used_usd: spend?.used_usd ?? null,
      limit_usd: spend?.limit_usd ?? null,
      disabled_reason: spend?.disabled_reason ?? null,
    },
  };
}

/**
 * Fold one reading into the latch. Returns the pages to send (empty on every
 * poll that isn't a fresh crossing) and the latch to persist.
 *
 * Deliberately total and side-effect free so the interesting cases — crossing,
 * staying above, window reset, re-crossing — are all unit-testable without a
 * daemon, a database, or a clock.
 */
export function evaluateQuotaAlerts(
  usage: LiveUsage | null,
  threshold: number | null,
  latch: QuotaAlertLatch,
  now: Date,
): { alerts: QuotaAlert[]; latch: QuotaAlertLatch } {
  const cond = quotaConditions(usage, threshold, now.getTime());
  const next: QuotaAlertLatch = { ...latch };
  const alerts: QuotaAlert[] = [];
  const nowIso = now.toISOString();

  switch (cond.threshold_state) {
    case "below":
    case "window_reset":
      next.threshold_window = null;
      next.threshold_at = null;
      break;
    case "over":
      // Same window as the last page ⇒ this is the hourly re-observation of a
      // crossing the operator already knows about. Stay quiet.
      if (cond.over && latch.threshold_window !== cond.over.window) {
        next.threshold_window = cond.over.window;
        next.threshold_at = nowIso;
        alerts.push(thresholdAlert(cond.over, now));
      }
      break;
    case "unknown":
      break; // no evidence either way — leave the latch exactly as it was
  }

  if (cond.spend_limit === true) {
    if (!latch.spend_limit) {
      next.spend_limit = true;
      next.spend_limit_at = nowIso;
      if (usage) alerts.push(spendAlert(usage));
    }
  } else if (cond.spend_limit === false) {
    next.spend_limit = false;
    next.spend_limit_at = null;
  }

  return { alerts, latch: next };
}

/** True when the two latches carry the same state (skip a redundant DB write). */
export function sameQuotaLatch(a: QuotaAlertLatch, b: QuotaAlertLatch): boolean {
  return (
    a.threshold_window === b.threshold_window &&
    a.threshold_at === b.threshold_at &&
    a.spend_limit === b.spend_limit &&
    a.spend_limit_at === b.spend_limit_at
  );
}

/** Whether a percentage warrants the hotter severity in the "Needs You" panel. */
export function quotaIsCritical(percent: number): boolean {
  return percent >= CRITICAL_PERCENT;
}
