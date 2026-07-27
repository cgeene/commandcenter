import { getDb } from "./db.js";
import {
  dayKey,
  estimateCostUsd,
  normalizeModel,
  totalTokens,
  type TokenCounts,
} from "../lib/pricing.js";

/**
 * Per-day token burn — the time dimension `tasks.tokens_used` doesn't have.
 *
 * tasks.tokens_used is a lifetime total per task, rewritten in place at every
 * Stop hook, so it can answer "what has this task cost" but never "what did we
 * burn this billing cycle". This table records the DELTA each Stop sample adds,
 * bucketed by the UTC day it landed on and by model (models are priced
 * differently, so a lumped count can't be costed).
 *
 * These are LOCAL ESTIMATES from session transcripts, not billing truth: they
 * only cover work this daemon orchestrated. The live feed (daemon/usagelive.ts)
 * is the number that reconciles with the operator's usage page.
 */

export interface DayBucket extends TokenCounts {
  day: string;
  agent_kind: string;
  model: string;
}

export interface DaySpend {
  day: string;
  tokens: number;
  /** Estimated USD across every priced model in the bucket. */
  cost_usd: number;
  /** Tokens from models with no entry in the price table (e.g. Codex/GPT
   *  workers, which aren't Anthropic-billed). Excluded from cost_usd. */
  unpriced_tokens: number;
}

export interface ModelSpend {
  model: string;
  tokens: number;
  cost_usd: number;
  priced: boolean;
}

const ZERO: TokenCounts = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read: 0,
  cache_creation: 0,
};

/**
 * Fold one session's cumulative per-model totals into the day buckets.
 *
 * Transcripts report cumulative session totals, so the amount this sample owes
 * today is (cumulative - what we already recorded for this session). The
 * watermark is keyed by (session, model): a fresh session starts from zero, a
 * resumed one picks up where it left off instead of re-counting its history,
 * and a sample taken after midnight adds only the new work to the new day.
 *
 * A cumulative total that went DOWN (a re-created transcript, a truncated
 * file) yields a negative delta; those are dropped rather than subtracted, so
 * a corrupt read can never eat previously recorded burn.
 */
export function recordTokenSample(
  sessionId: string,
  agentKind: string,
  totals: Map<string, TokenCounts>,
  now = new Date(),
): void {
  if (totals.size === 0) return;
  const db = getDb();
  const day = dayKey(now);

  const readMark = db.prepare(
    `SELECT input_tokens, output_tokens, cache_read, cache_creation
       FROM token_samples WHERE session_id = ? AND model = ?`,
  );
  const writeMark = db.prepare(
    `INSERT INTO token_samples
       (session_id, model, input_tokens, output_tokens, cache_read, cache_creation, sampled_at)
     VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(session_id, model) DO UPDATE SET
       input_tokens = excluded.input_tokens,
       output_tokens = excluded.output_tokens,
       cache_read = excluded.cache_read,
       cache_creation = excluded.cache_creation,
       sampled_at = excluded.sampled_at`,
  );
  const addDay = db.prepare(
    `INSERT INTO token_daily
       (day, agent_kind, model, input_tokens, output_tokens, cache_read, cache_creation)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(day, agent_kind, model) DO UPDATE SET
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       cache_read = cache_read + excluded.cache_read,
       cache_creation = cache_creation + excluded.cache_creation`,
  );

  db.transaction(() => {
    for (const [model, cumulative] of totals) {
      const prev = (readMark.get(sessionId, model) as TokenCounts | undefined) ?? ZERO;
      const delta: TokenCounts = {
        input_tokens: Math.max(0, cumulative.input_tokens - prev.input_tokens),
        output_tokens: Math.max(0, cumulative.output_tokens - prev.output_tokens),
        cache_read: Math.max(0, cumulative.cache_read - prev.cache_read),
        cache_creation: Math.max(0, cumulative.cache_creation - prev.cache_creation),
      };
      // Always advance the watermark, even on a no-op delta: a cumulative total
      // that shrank should re-baseline rather than replay on the next sample.
      writeMark.run(
        sessionId,
        model,
        cumulative.input_tokens,
        cumulative.output_tokens,
        cumulative.cache_read,
        cumulative.cache_creation,
      );
      if (totalTokens(delta) === 0) continue;
      addDay.run(
        day,
        agentKind,
        model,
        delta.input_tokens,
        delta.output_tokens,
        delta.cache_read,
        delta.cache_creation,
      );
    }
  })();
}

/** Raw buckets in [start, end) — end exclusive, both YYYY-MM-DD. */
export function dayBuckets(start: string, end: string): DayBucket[] {
  return getDb()
    .prepare(
      `SELECT day, agent_kind, model, input_tokens, output_tokens, cache_read, cache_creation
         FROM token_daily WHERE day >= ? AND day < ? ORDER BY day`,
    )
    .all(start, end) as DayBucket[];
}

export function allBuckets(): DayBucket[] {
  return getDb()
    .prepare(
      `SELECT day, agent_kind, model, input_tokens, output_tokens, cache_read, cache_creation
         FROM token_daily ORDER BY day`,
    )
    .all() as DayBucket[];
}

/** Earliest day we have any burn for — the honest "tracked since" the UI shows
 *  so a partial first cycle isn't read as a complete one. */
export function earliestTrackedDay(): string | null {
  const row = getDb().prepare("SELECT MIN(day) AS day FROM token_daily").get() as
    | { day: string | null }
    | undefined;
  return row?.day ?? null;
}

/** Collapse buckets to one row per day, costed. */
export function summarizeByDay(buckets: DayBucket[]): DaySpend[] {
  const byDay = new Map<string, DaySpend>();
  for (const b of buckets) {
    const row = byDay.get(b.day) ?? { day: b.day, tokens: 0, cost_usd: 0, unpriced_tokens: 0 };
    const tokens = totalTokens(b);
    row.tokens += tokens;
    if (normalizeModel(b.model)) row.cost_usd += estimateCostUsd(b, b.model);
    else row.unpriced_tokens += tokens;
    byDay.set(b.day, row);
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** Collapse buckets to one row per model, costed, biggest first. */
export function summarizeByModel(buckets: DayBucket[]): ModelSpend[] {
  const byModel = new Map<string, ModelSpend>();
  for (const b of buckets) {
    const row =
      byModel.get(b.model) ??
      { model: b.model, tokens: 0, cost_usd: 0, priced: normalizeModel(b.model) !== undefined };
    row.tokens += totalTokens(b);
    if (row.priced) row.cost_usd += estimateCostUsd(b, b.model);
    byModel.set(b.model, row);
  }
  return [...byModel.values()].sort((a, b) => b.tokens - a.tokens);
}

export function totalCostUsd(buckets: DayBucket[]): number {
  return buckets.reduce((sum, b) => sum + estimateCostUsd(b, b.model), 0);
}
