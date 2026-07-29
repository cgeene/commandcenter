import { describe, expect, it } from "vitest";
import {
  EMPTY_QUOTA_ALERT_LATCH,
  evaluateQuotaAlerts,
  quotaConditions,
  quotaReadingFresh,
  type QuotaAlertLatch,
} from "../src/lib/quotaalert.js";
import type { LiveUsage, UsageMeter } from "../src/lib/usage.js";

const NOW = new Date("2026-07-27T12:00:00.000Z");
/** Comfortably inside the window relative to NOW. */
const LATER = "2026-07-27T17:00:00.000Z";
/** The reset instant the feed reports once the session window rolls over. */
const NEXT_WINDOW = "2026-07-27T22:00:00.000Z";

function meter(over: Partial<UsageMeter> = {}): UsageMeter {
  return {
    key: "session",
    label: "Session (5h)",
    percent: 50,
    resets_at: LATER,
    severity: null,
    used_usd: null,
    limit_usd: null,
    ...over,
  };
}

function usage(over: Partial<LiveUsage> = {}): LiveUsage {
  const headline = over.headline ?? meter();
  return {
    fetched_at: NOW.toISOString(),
    source: "claude-code-oauth",
    meters: headline ? [headline] : [],
    headline,
    spend: null,
    plan: "team",
    ...over,
  };
}

/** One poll: fold a reading into the latch, returning both halves. */
function poll(
  reading: LiveUsage | null,
  latch: QuotaAlertLatch,
  opts: { threshold?: number | null; now?: Date } = {},
) {
  return evaluateQuotaAlerts(
    reading,
    opts.threshold === undefined ? 80 : opts.threshold,
    latch,
    opts.now ?? NOW,
  );
}

describe("quotaConditions", () => {
  it("reads an in-window meter above the threshold as over", () => {
    const cond = quotaConditions(
      usage({ headline: meter({ percent: 88 }) }),
      80,
      NOW.getTime(),
    );
    expect(cond.threshold_state).toBe("over");
    expect(cond.over).toMatchObject({ percent: 88, threshold: 80, label: "Session (5h)" });
  });

  it("treats a window whose reset instant has passed as window_reset, not over", () => {
    const stale = usage({
      headline: meter({ percent: 99, resets_at: "2026-07-27T11:00:00.000Z" }),
    });
    expect(quotaConditions(stale, 80, NOW.getTime()).threshold_state).toBe("window_reset");
  });

  it("is unknown with no feed, no percentage, or alerting disabled", () => {
    expect(quotaConditions(null, 80, NOW.getTime()).threshold_state).toBe("unknown");
    expect(
      quotaConditions(usage({ headline: meter({ percent: null }) }), 80, NOW.getTime())
        .threshold_state,
    ).toBe("unknown");
    expect(
      quotaConditions(usage({ headline: meter({ percent: 99 }) }), null, NOW.getTime())
        .threshold_state,
    ).toBe("unknown");
  });

  it("distinguishes an absent spend block from one that reports false", () => {
    expect(quotaConditions(usage(), 80, NOW.getTime()).spend_limit).toBeNull();
    const withSpend = usage({
      spend: {
        used_usd: 10,
        limit_usd: 50,
        percent: 20,
        enabled: true,
        limit_reached: false,
        disabled_reason: null,
      },
    });
    expect(quotaConditions(withSpend, 80, NOW.getTime()).spend_limit).toBe(false);
  });
});

describe("evaluateQuotaAlerts — threshold latch", () => {
  // The latch state machine, one row per scenario. These were six tests that all
  // fed a SEQUENCE of readings and asserted the alerts and latch after each
  // step, so they share one driver: `fresh` restarts from an empty latch,
  // otherwise the previous step's latch is carried forward — which is what makes
  // "pages once" and "re-pages" meaningfully different.
  it("pages exactly once per crossing, and re-arms when it should", () => {
    for (const { why, steps } of [
      {
        why: "pages once on the crossing",
        steps: [
          { percent: 70, alerts: 0, window: null },
          {
            percent: 82,
            alerts: 1,
            kind: "quota_threshold",
            title: "82%",
            window: `session@${LATER}`,
            at: NOW.toISOString(),
          },
        ],
      },
      {
        why: "stays quiet while utilization stays above the threshold",
        steps: [
          { percent: 82, alerts: 1 },
          // the crossing time is preserved, so the panel's age keeps counting
          { percent: 85, alerts: 0, at: NOW.toISOString() },
          { percent: 91, alerts: 0, at: NOW.toISOString() },
          { percent: 99, alerts: 0, at: NOW.toISOString() },
          { percent: 100, alerts: 0, at: NOW.toISOString() },
        ],
      },
      {
        why: "re-pages after the window resets and utilization climbs again",
        steps: [
          { percent: 90, alerts: 1 },
          // new window: a later reset instant and a fresh, low number
          { percent: 4, resets_at: NEXT_WINDOW, alerts: 0, window: null },
          {
            percent: 87,
            resets_at: NEXT_WINDOW,
            alerts: 1,
            window: `session@${NEXT_WINDOW}`,
          },
        ],
      },
      {
        why: "re-pages after dropping back below and crossing again inside one window",
        steps: [
          { percent: 90, alerts: 1 },
          { percent: 12, alerts: 0, window: null },
          { percent: 81, alerts: 1 },
        ],
      },
      {
        why: "never pages off a reading whose window already elapsed, but does re-arm",
        steps: [
          { percent: 90, alerts: 1 },
          // A recent poll (17:30) whose window closed at 17:00 — the upstream
          // feed hasn't rolled over yet. Stale percentage: no page, but the latch
          // clears so the new window gets its own.
          {
            percent: 90,
            fetched_at: "2026-07-27T17:30:00.000Z",
            now: new Date("2026-07-27T18:00:00.000Z"),
            alerts: 0,
            window: null,
          },
        ],
      },
      {
        why: "respects a non-default threshold and an explicit disable",
        steps: [
          { percent: 55, threshold: 50, alerts: 1, fresh: true },
          { percent: 99, threshold: null, alerts: 0, fresh: true },
        ],
      },
    ] as const) {
      let latch = EMPTY_QUOTA_ALERT_LATCH;
      for (const step of steps) {
        const label = `${why} @ ${step.percent}%`;
        const opts: Record<string, unknown> = {};
        if ("now" in step && step.now) opts.now = step.now;
        if ("threshold" in step) opts.threshold = step.threshold;
        const reading = usage({
          headline: meter({
            percent: step.percent,
            ...("resets_at" in step && step.resets_at ? { resets_at: step.resets_at } : {}),
          }),
          ...("fetched_at" in step && step.fetched_at ? { fetched_at: step.fetched_at } : {}),
        });
        const out = poll(reading, "fresh" in step && step.fresh ? EMPTY_QUOTA_ALERT_LATCH : latch, opts);

        expect(out.alerts, label).toHaveLength(step.alerts);
        if ("kind" in step && step.kind) {
          expect(out.alerts[0], label).toMatchObject({ kind: step.kind });
        }
        if ("title" in step && step.title) {
          expect(out.alerts[0].title, label).toContain(step.title);
        }
        if ("window" in step) {
          expect(out.latch.threshold_window, label).toBe(step.window);
        }
        if ("at" in step && step.at) {
          expect(out.latch.threshold_at, label).toBe(step.at);
        }
        latch = out.latch;
      }
    }
  });
});

describe("quotaReadingFresh", () => {
  it("accepts a recent reading and rejects one past the age bound", () => {
    const recent = usage({ fetched_at: "2026-07-27T11:30:00.000Z" });
    expect(quotaReadingFresh(recent, NOW.getTime())).toBe(true);
    // Anchored on fetched_at (the last SUCCESSFUL poll), so a feed that keeps
    // failing ages out even though its checked_at is bumped every hour.
    const old = usage({ fetched_at: "2026-07-27T02:00:00.000Z" });
    expect(quotaReadingFresh(old, NOW.getTime())).toBe(false);
    expect(quotaReadingFresh(null, NOW.getTime())).toBe(false);
    expect(quotaReadingFresh(usage({ fetched_at: "not a date" }), NOW.getTime())).toBe(false);
  });

  it("makes a stale reading indistinguishable from no feed at all", () => {
    const stale = usage({
      headline: meter({ percent: 99 }),
      fetched_at: "2026-07-20T12:00:00.000Z",
      spend: {
        used_usd: 50,
        limit_usd: 50,
        percent: 100,
        enabled: true,
        limit_reached: true,
        disabled_reason: null,
      },
    });
    const cond = quotaConditions(stale, 80, NOW.getTime());
    expect(cond).toEqual({ threshold_state: "unknown", over: null, spend_limit: null });

    // …and therefore cannot page, nor disturb an existing latch.
    const latched = poll(usage({ headline: meter({ percent: 90 }) }), EMPTY_QUOTA_ALERT_LATCH)
      .latch;
    const out = poll(stale, latched);
    expect(out.alerts).toHaveLength(0);
    expect(out.latch).toEqual(latched);
  });
});

describe("evaluateQuotaAlerts — fail-soft", () => {
  it("pages nothing when there is no live feed at all", () => {
    const out = poll(null, EMPTY_QUOTA_ALERT_LATCH);
    expect(out.alerts).toHaveLength(0);
    expect(out.latch).toEqual(EMPTY_QUOTA_ALERT_LATCH);
  });

  it("leaves an existing latch alone while the feed is unreadable", () => {
    const latched = poll(usage({ headline: meter({ percent: 90 }) }), EMPTY_QUOTA_ALERT_LATCH)
      .latch;
    // A poll that yields nothing must not silently re-arm — otherwise a
    // flapping feed pages again on every recovery.
    const blind = poll(null, latched);
    expect(blind.latch).toEqual(latched);
    const noMeters = poll(usage({ headline: null, meters: [] }), latched);
    expect(noMeters.alerts).toHaveLength(0);
    expect(noMeters.latch.threshold_window).toBe(latched.threshold_window);
  });
});

describe("evaluateQuotaAlerts — spend limit", () => {
  const capped = (limit_reached: boolean) =>
    usage({
      headline: meter({ percent: 10 }),
      spend: {
        used_usd: 50,
        limit_usd: 50,
        percent: 100,
        enabled: true,
        limit_reached,
        disabled_reason: null,
      },
    });

  it("pages once when limit_reached goes true and not again", () => {
    const hit = poll(capped(true), EMPTY_QUOTA_ALERT_LATCH);
    expect(hit.alerts.map((a) => a.kind)).toEqual(["quota_spend_limit"]);
    expect(hit.latch.spend_limit).toBe(true);
    expect(hit.latch.spend_limit_at).toBe(NOW.toISOString());

    const again = poll(capped(true), hit.latch);
    expect(again.alerts).toHaveLength(0);
    expect(again.latch.spend_limit_at).toBe(NOW.toISOString());
  });

  it("re-arms once the cap is lifted", () => {
    const hit = poll(capped(true), EMPTY_QUOTA_ALERT_LATCH);
    const lifted = poll(capped(false), hit.latch);
    expect(lifted.alerts).toHaveLength(0);
    expect(lifted.latch.spend_limit).toBe(false);
    expect(poll(capped(true), lifted.latch).alerts).toHaveLength(1);
  });

  it("holds the latch when the payload carries no spend block", () => {
    const hit = poll(capped(true), EMPTY_QUOTA_ALERT_LATCH);
    const noSpend = poll(usage({ headline: meter({ percent: 10 }) }), hit.latch);
    expect(noSpend.alerts).toHaveLength(0);
    expect(noSpend.latch.spend_limit).toBe(true);
  });

  it("can page for both conditions in the same poll", () => {
    const both = usage({
      headline: meter({ percent: 96 }),
      spend: {
        used_usd: 50,
        limit_usd: 50,
        percent: 100,
        enabled: true,
        limit_reached: true,
        disabled_reason: null,
      },
    });
    expect(poll(both, EMPTY_QUOTA_ALERT_LATCH).alerts.map((a) => a.kind)).toEqual([
      "quota_threshold",
      "quota_spend_limit",
    ]);
  });
});
