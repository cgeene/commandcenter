import { describe, expect, it } from "vitest";
import {
  MODEL_PRICES,
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
    const opus = MODEL_PRICES["claude-opus-5"];
    expect(opus.cache_read).toBeCloseTo(opus.input * 0.1, 10);
    expect(opus.cache_write).toBeCloseTo(opus.input * 1.25, 10);
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
    // Opus 5: $5 in + $25 out + $0.50 cache read + $6.25 cache write.
    expect(estimateCostUsd(tokens, "claude-opus-5")).toBeCloseTo(36.75, 6);
  });

  it("scales linearly below a million tokens", () => {
    const cost = estimateCostUsd(
      { input_tokens: 500_000, output_tokens: 0, cache_read: 0, cache_creation: 0 },
      "claude-sonnet-5",
    );
    expect(cost).toBeCloseTo(1.5, 6);
  });

  it("costs an unpriceable model at zero so it can be reported separately", () => {
    expect(estimateCostUsd(tokens, "gpt-5-codex")).toBe(0);
  });

  it("treats cache reads as far cheaper than fresh input", () => {
    const fresh = estimateCostUsd(
      { input_tokens: 1_000_000, output_tokens: 0, cache_read: 0, cache_creation: 0 },
      "claude-opus-5",
    );
    const cached = estimateCostUsd(
      { input_tokens: 0, output_tokens: 0, cache_read: 1_000_000, cache_creation: 0 },
      "claude-opus-5",
    );
    expect(cached * 10).toBeCloseTo(fresh, 6);
  });
});

describe("cycle window", () => {
  const at = (iso: string) => new Date(`${iso}T12:00:00Z`);

  it("runs reset-day to reset-day", () => {
    const c = cycleWindow(at("2026-07-27"), 1);
    expect(c.start).toBe("2026-07-01");
    expect(c.end).toBe("2026-08-01");
    expect(c.days_total).toBe(31);
    expect(c.days_elapsed).toBe(27);
  });

  it("treats the reset day itself as day 1 of the NEW cycle", () => {
    const c = cycleWindow(at("2026-07-15"), 15);
    expect(c.start).toBe("2026-07-15");
    expect(c.end).toBe("2026-08-15");
    expect(c.days_elapsed).toBe(1);
  });

  it("looks back to the previous month before the reset day", () => {
    const c = cycleWindow(at("2026-07-14"), 15);
    expect(c.start).toBe("2026-06-15");
    expect(c.end).toBe("2026-07-15");
    expect(c.days_elapsed).toBe(30);
  });

  it("rolls the year over at a January boundary", () => {
    const c = cycleWindow(at("2026-01-05"), 20);
    expect(c.start).toBe("2025-12-20");
    expect(c.end).toBe("2026-01-20");
  });

  it("pins a reset day past the month's end onto its last day (short months)", () => {
    // February 2026 has 28 days, so a stored 31 must land on the 28th — not
    // spill into March and produce an empty or doubled cycle.
    const c = cycleWindow(at("2026-02-15"), 31);
    expect(c.start).toBe("2026-01-31");
    expect(c.end).toBe("2026-02-28");

    const march = cycleWindow(at("2026-03-01"), 31);
    expect(march.start).toBe("2026-02-28");
    expect(march.end).toBe("2026-03-31");
  });

  it("handles a leap-February", () => {
    const c = cycleWindow(at("2028-02-29"), 30);
    expect(c.start).toBe("2028-02-29");
    expect(c.end).toBe("2028-03-30");
  });

  it("defaults a garbage reset day to the 1st instead of throwing", () => {
    expect(cycleWindow(at("2026-07-27"), 0).start).toBe("2026-07-01");
    expect(cycleWindow(at("2026-07-27"), Number.NaN).start).toBe("2026-07-01");
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
