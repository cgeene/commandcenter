import { describe, expect, it } from "vitest";
import {
  PRICE_SCHEDULE,
  cycleWindow,
  dayKey,
  daysInWindow,
  estimateCostUsd,
  normalizeModel,
  paceTarget,
  projectedCycleSpend,
  resolveModelPrice,
} from "../src/lib/pricing.js";
import {
  normalizeOauthUsage,
  orgCycleSpend,
  pickHeadline,
  resetsIn,
  type UsageMeter,
} from "../src/lib/usage.js";

describe("model price resolution", () => {
  it("resolves short slugs, full ids, and dated/prefixed variants", () => {
    expect(normalizeModel("opus")).toBe("claude-opus-5");
    expect(normalizeModel("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(normalizeModel("anthropic.claude-opus-5")).toBe("claude-opus-5");
    expect(normalizeModel("claude-opus-4-5-20251101")).toBe("claude-opus-4-5");
    expect(normalizeModel("CLAUDE-HAIKU-4-5")).toBe("claude-haiku-4-5");
  });

  it("returns undefined for models it cannot price rather than guessing", () => {
    expect(resolveModelPrice("gpt-5-codex")).toBeUndefined();
    expect(resolveModelPrice(null)).toBeUndefined();
    expect(resolveModelPrice("")).toBeUndefined();
  });

  it("derives cache rates from input at the published multipliers", () => {
    const opus = resolveModelPrice("claude-opus-5")!;
    expect(opus.cache_read).toBeCloseTo(opus.input * 0.1, 10);
    expect(opus.cache_write_5m).toBeCloseTo(opus.input * 1.25, 10);
    expect(opus.cache_write_1h).toBeCloseTo(opus.input * 2, 10);
  });

  it("keeps every schedule sorted so the newest applicable rate wins", () => {
    for (const [model, points] of Object.entries(PRICE_SCHEDULE)) {
      const froms = points.map((p) => p.from);
      expect(froms, model).toEqual([...froms].sort());
    }
  });
});

describe("scheduled rate changes", () => {
  // One table: every row is resolveModelPrice(model, date) against the published
  // schedule. Sonnet 5 ships at an introductory rate that steps up on
  // 2026-09-01; models with a single rate must ignore the date entirely.
  it("resolves the rate in effect on the given day", () => {
    for (const { why, model, day, input, output } of [
      { why: "Sonnet 5 the day before the switchover", model: "claude-sonnet-5", day: "2026-08-31", input: 2, output: 10 },
      { why: "Sonnet 5 on the switchover day itself", model: "claude-sonnet-5", day: "2026-09-01", input: 3, output: 15 },
      { why: "a Date accepted in place of a day string", model: "claude-sonnet-5", day: new Date("2026-09-02T00:00:00Z"), input: 3 },
      { why: "a single-rate model, long before any schedule", model: "claude-opus-5", day: "2020-01-01", input: 5 },
      { why: "a single-rate model, long after", model: "claude-opus-5", day: "2030-01-01", input: 5 },
    ] as const) {
      const price = resolveModelPrice(model, day)!;
      expect(price, why).toBeDefined();
      expect(price.input, why).toBe(input);
      if (output !== undefined) expect(price.output, why).toBe(output);
    }
  });

  // Kept separate: this goes through estimateCostUsd rather than the resolver, so
  // it proves a day's BURN is priced at that day's rate, not just that the
  // schedule lookup works.
  it("prices each day's burn at the rate in effect that day", () => {
    const tokens = {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_read: 0,
      cache_creation: 0,
    };
    expect(estimateCostUsd(tokens, "sonnet", "2026-08-15")).toBeCloseTo(2, 6);
    expect(estimateCostUsd(tokens, "sonnet", "2026-09-15")).toBeCloseTo(3, 6);
  });
});

describe("cost estimation", () => {
  const tokens = {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_read: 1_000_000,
    cache_creation: 1_000_000,
  };

  it("prices each token class at its own rate", () => {
    // Opus 5: $5 in + $25 out + $0.50 cache read + $6.25 cache write (5m).
    expect(estimateCostUsd(tokens, "claude-opus-5")).toBeCloseTo(36.75, 6);
  });

  it("charges 1-hour cache writes at 2x, not the 5-minute 1.25x", () => {
    // Same bundle, but the writes are all 1h TTL: $10 instead of $6.25.
    expect(estimateCostUsd({ ...tokens, cache_creation_1h: 1_000_000 }, "claude-opus-5"))
      .toBeCloseTo(40.5, 6);
  });

  it("splits a mixed-TTL write bundle across both rates", () => {
    // 400k at 2x ($4.00) + 600k at 1.25x ($3.75) = $7.75 of writes.
    const cost = estimateCostUsd(
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_read: 0,
        cache_creation: 1_000_000,
        cache_creation_1h: 400_000,
      },
      "claude-opus-5",
    );
    expect(cost).toBeCloseTo(7.75, 6);
  });

  it("falls back to the cheaper rate when the TTL split is absent", () => {
    const withoutSplit = estimateCostUsd(
      { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_creation: 1_000_000 },
      "claude-opus-5",
    );
    expect(withoutSplit).toBeCloseTo(6.25, 6);
  });

  it("never lets a malformed 1h figure exceed or go below the total", () => {
    const base = { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_creation: 1_000_000 };
    // 1h larger than the total clamps to the total (all at 2x).
    expect(estimateCostUsd({ ...base, cache_creation_1h: 9_000_000 }, "claude-opus-5"))
      .toBeCloseTo(10, 6);
    // Negative 1h clamps to zero (all at 1.25x).
    expect(estimateCostUsd({ ...base, cache_creation_1h: -5 }, "claude-opus-5"))
      .toBeCloseTo(6.25, 6);
  });

  it("costs an unpriceable model at zero so it can be reported separately", () => {
    expect(estimateCostUsd(tokens, "gpt-5-codex")).toBe(0);
  });

});

describe("cycle window", () => {
  const at = (iso: string) => new Date(`${iso}T12:00:00Z`);

  // One table: every row is cycleWindow(day, resetDay) -> the same four fields.
  // The interesting inputs are the calendar edges, so they are named rather than
  // left implicit.
  it("runs reset-day to reset-day across every calendar edge", () => {
    for (const { why, day, reset, start, end, total, elapsed } of [
      { why: "mid-cycle, reset on the 1st", day: "2026-07-27", reset: 1, start: "2026-07-01", end: "2026-08-01", total: 31, elapsed: 27 },
      { why: "the reset day itself is day 1 of the NEW cycle", day: "2026-07-15", reset: 15, start: "2026-07-15", end: "2026-08-15", elapsed: 1 },
      { why: "the day before the reset looks back a month", day: "2026-07-14", reset: 15, start: "2026-06-15", end: "2026-07-15", elapsed: 30 },
      { why: "the year rolls over at a January boundary", day: "2026-01-05", reset: 20, start: "2025-12-20", end: "2026-01-20" },
      // A stored reset day of 31 must land on February's last day, not spill into
      // March and produce an empty or doubled cycle.
      { why: "a reset day past a short month's end pins to its last day", day: "2026-02-15", reset: 31, start: "2026-01-31", end: "2026-02-28" },
      { why: "...and the following cycle starts from that pinned day", day: "2026-03-01", reset: 31, start: "2026-02-28", end: "2026-03-31" },
      { why: "a leap-February", day: "2028-02-29", reset: 30, start: "2028-02-29", end: "2028-03-30" },
      { why: "a garbage reset day of 0 defaults to the 1st", day: "2026-07-27", reset: 0, start: "2026-07-01" },
      { why: "a NaN reset day defaults to the 1st", day: "2026-07-27", reset: Number.NaN, start: "2026-07-01" },
    ] as const) {
      const c = cycleWindow(at(day), reset);
      expect(c.start, why).toBe(start);
      if (end !== undefined) expect(c.end, why).toBe(end);
      if (total !== undefined) expect(c.days_total, why).toBe(total);
      if (elapsed !== undefined) expect(c.days_elapsed, why).toBe(elapsed);
    }
  });
});

describe("window helpers", () => {
  it("enumerates every day in the window, end-exclusive", () => {
    const days = daysInWindow("2026-07-01", "2026-07-05");
    expect(days).toEqual(["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"]);
  });

  it("uses UTC day keys", () => {
    expect(dayKey(new Date("2026-07-27T23:59:59Z"))).toBe("2026-07-27");
  });

  it("paces linearly and clamps at the cycle ends", () => {
    const cycle = cycleWindow(new Date("2026-07-10T12:00:00Z"), 1);
    expect(paceTarget(310, cycle, 0)).toBeCloseTo(0, 6);
    expect(paceTarget(310, cycle, 10)).toBeCloseTo(100, 6);
    expect(paceTarget(310, cycle, 99)).toBeCloseTo(310, 6);
  });

  it("projects cycle-end spend from burn so far", () => {
    const cycle = cycleWindow(new Date("2026-07-10T12:00:00Z"), 1); // day 10 of 31
    expect(projectedCycleSpend(100, cycle)).toBeCloseTo(310, 6);
  });
});

describe("live usage normalizer", () => {
  // Trimmed from a real /api/oauth/usage 200, including the null codename keys
  // the endpoint ships and the dollar fields that are null on a Team plan.
  const REAL = {
    five_hour: { utilization: 57, resets_at: "2026-07-28T02:40:00Z", limit_dollars: null },
    seven_day: { utilization: 31, resets_at: "2026-07-28T23:59:59Z", limit_dollars: null },
    seven_day_opus: null,
    tangelo: null,
    extra_usage: {
      is_enabled: false,
      monthly_limit: null,
      spend_limit_reached: true,
      disabled_reason: "org_level_disabled_until",
    },
    limits: [
      { kind: "session", group: "session", percent: 57, severity: "normal", resets_at: "2026-07-28T02:40:00Z", scope: null },
      { kind: "weekly_all", group: "weekly", percent: 31, severity: "normal", resets_at: "2026-07-28T23:59:59Z", scope: null },
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 30,
        severity: "normal",
        resets_at: "2026-07-29T00:00:00Z",
        scope: { model: { id: "x", display_name: "Fable" } },
      },
    ],
    spend: { used: { amount_minor: 0, currency: "USD", exponent: 2 }, limit: null, percent: 0, enabled: false },
  };

  it("reads the limits array into labelled meters", () => {
    const u = normalizeOauthUsage(REAL, "2026-07-27T23:00:00Z");
    expect(u.meters.map((m) => m.label)).toEqual([
      "Session (5h)",
      "Weekly (all models)",
      "Weekly · Fable",
    ]);
    expect(u.meters[0].percent).toBe(57);
    expect(u.meters[2].key).toBe("weekly_scoped:fable");
  });

  it("picks the meter closest to its ceiling as the headline", () => {
    expect(normalizeOauthUsage(REAL, "now").headline?.key).toBe("session");
  });

  it("surfaces a reached spend limit even when dollars are unavailable", () => {
    const spend = normalizeOauthUsage(REAL, "now").spend!;
    expect(spend.limit_reached).toBe(true);
    expect(spend.enabled).toBe(false);
    expect(spend.limit_usd).toBeNull();
  });

  it("converts minor-unit money to dollars", () => {
    const u = normalizeOauthUsage(
      { ...REAL, spend: { used: { amount_minor: 12_345, exponent: 2 }, limit: { amount_minor: 50_000, exponent: 2 }, enabled: true } },
      "now",
    );
    expect(u.spend!.used_usd).toBeCloseTo(123.45, 6);
    expect(u.spend!.limit_usd).toBeCloseTo(500, 6);
  });

  it("falls back to the legacy top-level windows when limits[] is absent", () => {
    const { limits, ...legacy } = REAL;
    void limits;
    const u = normalizeOauthUsage(legacy, "now");
    expect(u.meters.map((m) => m.key)).toEqual(["five_hour", "seven_day"]);
    expect(u.headline?.percent).toBe(57);
  });

  it("accepts 0-1 fractions as well as 0-100 percentages", () => {
    const u = normalizeOauthUsage(
      { limits: [{ kind: "session", percent: 0.42, resets_at: null }] },
      "now",
    );
    expect(u.meters[0].percent).toBeCloseTo(42, 6);
  });

  it("keeps an unrecognized window rather than dropping it", () => {
    const u = normalizeOauthUsage(
      { limits: [{ kind: "monthly_whatsit", percent: 12 }] },
      "now",
    );
    expect(u.meters[0].label).toBe("Monthly whatsit");
  });

  it("degrades to empty on a shape it cannot read, without throwing", () => {
    for (const junk of [null, undefined, "nope", 42, {}, { limits: "not-an-array" }]) {
      const u = normalizeOauthUsage(junk, "now");
      expect(u.meters).toEqual([]);
      expect(u.headline).toBeNull();
    }
  });
});

describe("org cost cache usability", () => {
  const fresh = {
    total_usd: 123.45,
    cycle_start: "2026-08-01",
    fetched_at: "2026-08-05T10:00:00Z",
  };

  it("uses the org figure when it describes the cycle on screen", () => {
    expect(orgCycleSpend(fresh, "2026-08-01")).toEqual({
      usd: 123.45,
      fetched_at: "2026-08-05T10:00:00Z",
    });
  });

  it("refuses a cache built for a previous cycle", () => {
    // The realistic failure: July's cache is kept through an August poll
    // failure (401 after a key rotation, or the admin key being removed, both
    // of which leave the previous figures in place). Showing July's dollars
    // against August's quota under an "org billing" label would silently
    // override the correct local estimate.
    const stale = { ...fresh, cycle_start: "2026-07-01" };
    expect(orgCycleSpend(stale, "2026-08-01")).toBeNull();
  });

  it("reports nothing when the report never succeeded", () => {
    expect(orgCycleSpend({ total_usd: null, cycle_start: null, fetched_at: null }, "2026-08-01"))
      .toBeNull();
  });

  it("keeps a genuine zero-spend cycle rather than treating it as missing", () => {
    expect(orgCycleSpend({ ...fresh, total_usd: 0 }, "2026-08-01")?.usd).toBe(0);
  });

});

describe("headline + reset formatting", () => {
  const meter = (key: string, percent: number | null, resets_at: string | null): UsageMeter => ({
    key,
    label: key,
    percent,
    resets_at,
    severity: null,
    used_usd: null,
    limit_usd: null,
  });

  it("breaks a tie toward the sooner reset", () => {
    const picked = pickHeadline([
      meter("weekly", 50, "2026-08-01T00:00:00Z"),
      meter("session", 50, "2026-07-28T00:00:00Z"),
    ]);
    expect(picked?.key).toBe("session");
  });

  it("still returns something when no meter has a percentage", () => {
    expect(pickHeadline([meter("a", null, null)])?.key).toBe("a");
    expect(pickHeadline([])).toBeNull();
  });

  it("formats time remaining, and blanks out past or unknown resets", () => {
    const now = new Date("2026-07-27T23:00:00Z");
    expect(resetsIn("2026-07-28T01:40:00Z", now)).toBe("2h 40m");
    expect(resetsIn("2026-07-27T23:30:00Z", now)).toBe("30m");
    expect(resetsIn("2026-07-30T23:00:00Z", now)).toBe("3d");
    expect(resetsIn("2026-07-01T00:00:00Z", now)).toBe("");
    expect(resetsIn(null, now)).toBe("");
  });
});
