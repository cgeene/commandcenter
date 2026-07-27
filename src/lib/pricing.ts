/**
 * Token → dollar estimation and billing-cycle math.
 *
 * Shared between the daemon and the web bundle (the src/lib pattern — see
 * board.ts / panel.ts): pure functions only, no node or DOM imports.
 *
 * NOTHING here is billing truth. Local token counts come from session
 * transcripts, so they miss anything the daemon never saw and they can't know
 * about discounts, batch pricing, or plan-level allowances. Treat every number
 * this module produces as an estimate and label it that way in the UI.
 */

/** USD per MILLION tokens for one model. */
export interface ModelPrice {
  input: number;
  output: number;
  cache_read: number;
  /** Writing a prompt-cache entry. Assumes the 5-minute TTL (1.25x input);
   *  1-hour-TTL writes bill at 2x and are not distinguished in the transcript. */
  cache_write: number;
}

/**
 * Static price table, USD per million tokens.
 *
 * ⚠️ MANUAL MAINTENANCE REQUIRED. Anthropic changes prices and ships new models
 * without notifying this repo. When a price moves or a model lands, edit this
 * map — nothing else in the codebase needs to change. Cache rates follow the
 * published multipliers: reads are 0.1x input, 5-minute writes are 1.25x input.
 *
 * Last checked: 2026-07-27.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-fable-5": price(10, 50),
  "claude-mythos-5": price(10, 50),
  "claude-opus-5": price(5, 25),
  "claude-opus-4-8": price(5, 25),
  "claude-opus-4-7": price(5, 25),
  "claude-opus-4-6": price(5, 25),
  "claude-opus-4-5": price(5, 25),
  "claude-sonnet-5": price(3, 15),
  "claude-sonnet-4-6": price(3, 15),
  "claude-sonnet-4-5": price(3, 15),
  "claude-haiku-4-5": price(1, 5),
};

function price(input: number, output: number): ModelPrice {
  return {
    input,
    output,
    cache_read: input * 0.1,
    cache_write: input * 1.25,
  };
}

/** commandcenter's short model slugs (provider-models.ts) → full API ids. */
const SLUG_ALIASES: Readonly<Record<string, string>> = {
  fable: "claude-fable-5",
  mythos: "claude-mythos-5",
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
};

/**
 * Resolve a model identifier to a price entry. Handles the short slugs the
 * dashboard stores on tasks, the full API ids the transcript records, and
 * dated/prefixed variants (`anthropic.claude-opus-5`, `claude-opus-4-5-20251101`).
 *
 * Returns undefined for anything we can't price — notably Codex/GPT models,
 * which aren't Anthropic-billed at all. Callers must surface those tokens as
 * unpriced rather than silently costing them at zero.
 */
export function resolveModelPrice(model: string | null | undefined): ModelPrice | undefined {
  const key = normalizeModel(model);
  return key ? MODEL_PRICES[key] : undefined;
}

/** Canonical price-table key for a model identifier, or undefined if unknown. */
export function normalizeModel(model: string | null | undefined): string | undefined {
  if (!model) return undefined;
  let id = model.trim().toLowerCase();
  if (!id) return undefined;
  if (SLUG_ALIASES[id]) return SLUG_ALIASES[id];
  // Bedrock-style provider prefix.
  id = id.replace(/^anthropic\./, "");
  // Vertex-style @version separator.
  id = id.replace(/@\d+$/, "");
  if (MODEL_PRICES[id]) return id;
  // Dated snapshot (claude-opus-4-5-20251101) → alias.
  const undated = id.replace(/-\d{8}$/, "");
  if (MODEL_PRICES[undated]) return undated;
  return undefined;
}

export interface TokenCounts {
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_creation: number;
}

/** Estimated USD for a token bundle at a given model's rates. */
export function estimateCostUsd(tokens: TokenCounts, model: string | null | undefined): number {
  const p = resolveModelPrice(model);
  if (!p) return 0;
  return (
    (tokens.input_tokens * p.input +
      tokens.output_tokens * p.output +
      tokens.cache_read * p.cache_read +
      tokens.cache_creation * p.cache_write) /
    1_000_000
  );
}

export function totalTokens(t: TokenCounts): number {
  return t.input_tokens + t.output_tokens + t.cache_read + t.cache_creation;
}

/* ------------------------------------------------------------------ *
 * Billing-cycle windows                                               *
 * ------------------------------------------------------------------ */

export interface CycleWindow {
  /** First day of the cycle, inclusive (YYYY-MM-DD, UTC). */
  start: string;
  /** First day of the NEXT cycle, exclusive (YYYY-MM-DD, UTC). */
  end: string;
  /** Days in the whole cycle. */
  days_total: number;
  /** Days elapsed including today — 1 on the reset day itself. */
  days_elapsed: number;
}

export const DEFAULT_CYCLE_RESET_DAY = 1;

/** UTC calendar day key. Matches how the dashboard buckets everything else. */
export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const DAY_MS = 86_400_000;

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** Reset day pinned into a real day of the given month. A stored 31 lands on
 *  the 28th/29th in February rather than rolling into March. */
function clampDay(resetDay: number, year: number, monthIndex: number): number {
  const wanted = Math.min(Math.max(Math.trunc(resetDay) || 1, 1), 31);
  return Math.min(wanted, daysInMonth(year, monthIndex));
}

/**
 * The billing cycle containing `now`, for a monthly quota that resets on
 * `resetDay`. The cycle runs [start, end): if today IS the reset day, today is
 * day 1 of a fresh cycle, not the last day of the old one.
 */
export function cycleWindow(now: Date, resetDay = DEFAULT_CYCLE_RESET_DAY): CycleWindow {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const today = now.getUTCDate();

  let sy = year;
  let sm = month;
  if (today < clampDay(resetDay, year, month)) {
    sm -= 1;
    if (sm < 0) {
      sm = 11;
      sy -= 1;
    }
  }
  const start = new Date(Date.UTC(sy, sm, clampDay(resetDay, sy, sm)));

  let ey = sy;
  let em = sm + 1;
  if (em > 11) {
    em = 0;
    ey += 1;
  }
  const end = new Date(Date.UTC(ey, em, clampDay(resetDay, ey, em)));

  const days_total = Math.round((end.getTime() - start.getTime()) / DAY_MS);
  const midnightToday = Date.UTC(year, month, today);
  const days_elapsed = Math.round((midnightToday - start.getTime()) / DAY_MS) + 1;
  return { start: dayKey(start), end: dayKey(end), days_total, days_elapsed };
}

/** Every day key in [start, end), in order. Drives the daily burn chart so
 *  zero-spend days still render as gaps rather than being silently dropped. */
export function daysInWindow(start: string, end: string): string[] {
  const out: string[] = [];
  let cur = Date.parse(`${start}T00:00:00Z`);
  const stop = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(cur) || !Number.isFinite(stop)) return out;
  while (cur < stop) {
    out.push(dayKey(new Date(cur)));
    cur += DAY_MS;
  }
  return out;
}

/**
 * Where a linear burn to the quota would have you by day N — the pace line on
 * the chart. Day 1 of the cycle is already 1/days_total of the budget.
 */
export function paceTarget(quotaUsd: number, cycle: CycleWindow, dayIndex: number): number {
  if (cycle.days_total <= 0) return quotaUsd;
  const clamped = Math.min(Math.max(dayIndex, 0), cycle.days_total);
  return (quotaUsd * clamped) / cycle.days_total;
}

/** Straight-line projection of cycle-end spend from the burn so far. */
export function projectedCycleSpend(spentUsd: number, cycle: CycleWindow): number {
  if (cycle.days_elapsed <= 0) return spentUsd;
  return (spentUsd / cycle.days_elapsed) * cycle.days_total;
}
