import { describe, expect, it } from "vitest";
import {
  EMPTY_QUOTA_ALERT_LATCH,
  evaluateQuotaAlerts,
  quotaConditions,
  type QuotaAlertLatch,
} from "../src/lib/quotaalert.js";
import type { LiveUsage, UsageMeter } from "../src/lib/usage.js";

const NOW = new Date("2026-07-27T12:00:00.000Z");
/** Comfortably inside the window relative to NOW. */
const LATER = "2026-07-27T17:00:00.000Z";

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
  it("pages once on the crossing", () => {
    const below = poll(usage({ headline: meter({ percent: 70 }) }), EMPTY_QUOTA_ALERT_LATCH);
    expect(below.alerts).toHaveLength(0);
    expect(below.latch.threshold_window).toBeNull();

    const crossed = poll(usage({ headline: meter({ percent: 82 }) }), below.latch);
    expect(crossed.alerts).toHaveLength(1);
    expect(crossed.alerts[0]).toMatchObject({ kind: "quota_threshold" });
    expect(crossed.alerts[0].title).toContain("82%");
    expect(crossed.latch.threshold_window).toBe(`session@${LATER}`);
    expect(crossed.latch.threshold_at).toBe(NOW.toISOString());
  });

  it("stays quiet while utilization stays above the threshold", () => {
    let latch = poll(usage({ headline: meter({ percent: 82 }) }), EMPTY_QUOTA_ALERT_LATCH)
      .latch;
    for (const percent of [85, 91, 99, 100]) {
      const next = poll(usage({ headline: meter({ percent }) }), latch);
      expect(next.alerts).toHaveLength(0);
      // and the crossing time is preserved, so the panel's age keeps counting
      expect(next.latch.threshold_at).toBe(NOW.toISOString());
      latch = next.latch;
    }
  });

  it("re-pages after the window resets and utilization climbs again", () => {
    const crossed = poll(usage({ headline: meter({ percent: 90 }) }), EMPTY_QUOTA_ALERT_LATCH);
    expect(crossed.alerts).toHaveLength(1);

    // New window: the feed hands back a later reset instant and a fresh, low number.
    const nextWindow = "2026-07-27T22:00:00.000Z";
    const rolled = poll(
      usage({ headline: meter({ percent: 4, resets_at: nextWindow }) }),
      crossed.latch,
    );
    expect(rolled.alerts).toHaveLength(0);
    expect(rolled.latch.threshold_window).toBeNull();

    const recrossed = poll(
      usage({ headline: meter({ percent: 87, resets_at: nextWindow }) }),
      rolled.latch,
    );
    expect(recrossed.alerts).toHaveLength(1);
    expect(recrossed.latch.threshold_window).toBe(`session@${nextWindow}`);
  });

  it("re-pages after dropping back below and crossing again inside one window", () => {
    const crossed = poll(usage({ headline: meter({ percent: 90 }) }), EMPTY_QUOTA_ALERT_LATCH);
    const dropped = poll(usage({ headline: meter({ percent: 12 }) }), crossed.latch);
    expect(dropped.alerts).toHaveLength(0);
    expect(dropped.latch.threshold_window).toBeNull();
    expect(poll(usage({ headline: meter({ percent: 81 }) }), dropped.latch).alerts).toHaveLength(1);
  });

  it("never pages off a reading whose window already elapsed, but does re-arm", () => {
    const latched = poll(usage({ headline: meter({ percent: 90 }) }), EMPTY_QUOTA_ALERT_LATCH)
      .latch;
    // Same reading observed after its window closed — the feed just hasn't
    // refreshed yet. Stale percentage: no page, latch cleared for the next one.
    const stale = poll(usage({ headline: meter({ percent: 90 }) }), latched, {
      now: new Date("2026-07-27T18:00:00.000Z"),
    });
    expect(stale.alerts).toHaveLength(0);
    expect(stale.latch.threshold_window).toBeNull();
  });

  it("respects a non-default threshold and an explicit disable", () => {
    expect(
      poll(usage({ headline: meter({ percent: 55 }) }), EMPTY_QUOTA_ALERT_LATCH, {
        threshold: 50,
      }).alerts,
    ).toHaveLength(1);
    expect(
      poll(usage({ headline: meter({ percent: 99 }) }), EMPTY_QUOTA_ALERT_LATCH, {
        threshold: null,
      }).alerts,
    ).toHaveLength(0);
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
