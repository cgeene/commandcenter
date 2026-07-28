/**
 * Normalizer for Claude Code's live usage payload.
 *
 * The source is `GET /api/oauth/usage` — the same call `/usage` makes inside
 * Claude Code, and the same numbers the claude.ai usage page shows. It is an
 * INTERNAL, UNDOCUMENTED endpoint: fields appear, get renamed, and go null
 * between releases (the live payload today carries a dozen null keys with
 * codenames like `tangelo` and `iguana_necktie`). So every field read here is
 * defensive, unknown keys are ignored rather than fatal, and a payload we
 * can't make sense of yields zero meters instead of throwing.
 *
 * Pure: no fetch, no node, no DOM. Shared with the web bundle (src/lib pattern).
 */

/** One quota bar — a rate-limit window, or a dollar budget when the plan has one. */
export interface UsageMeter {
  /** Stable identity for React keys and ordering. */
  key: string;
  label: string;
  /** 0-100, or null when the payload gave us a window with no percentage. */
  percent: number | null;
  /** ISO timestamp this window rolls over, if known. */
  resets_at: string | null;
  /** Upstream's own banding: normal | warning | ... (passed through, not interpreted). */
  severity: string | null;
  used_usd: number | null;
  limit_usd: number | null;
}

export interface LiveSpend {
  used_usd: number;
  limit_usd: number | null;
  percent: number | null;
  /** Whether the org has extra-usage/credits switched on at all. */
  enabled: boolean;
  /** True once spend is capped — the state that stops work mid-task. */
  limit_reached: boolean;
  disabled_reason: string | null;
}

export interface LiveUsage {
  fetched_at: string;
  /** Which upstream produced this. Drives the UI's provenance label. */
  source: "claude-code-oauth" | "anthropic-admin-api";
  meters: UsageMeter[];
  /** The binding constraint — the meter closest to its ceiling. */
  headline: UsageMeter | null;
  spend: LiveSpend | null;
  /** e.g. "team", "max" — informational only. */
  plan: string | null;
}

/** What the daemon caches between polls, and what the API hands the dashboard. */
export interface LiveUsageState {
  /** Last successfully fetched usage, kept across failures and restarts. */
  usage: LiveUsage | null;
  /** Why the most recent attempt failed, or null if it succeeded. */
  error: string | null;
  checked_at: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

/** Percentages have arrived as both 0-1 fractions and 0-100 integers across
 *  releases. Treat a value at or below 1 as a fraction only when it is not a
 *  whole number, so a literal `1` still means one percent, not 100%. */
function percent(v: unknown): number | null {
  const n = num(v);
  if (n === null) return null;
  const scaled = n > 0 && n < 1 ? n * 100 : n;
  return Math.max(0, Math.min(100, scaled));
}

/** `{amount_minor: 1234, exponent: 2}` → 12.34. Also accepts a bare number. */
function money(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (!isRecord(v)) return null;
  const minor = num(v.amount_minor);
  if (minor === null) return null;
  const exponent = num(v.exponent) ?? 2;
  return minor / 10 ** exponent;
}

const KIND_LABELS: Record<string, string> = {
  session: "Session (5h)",
  five_hour: "Session (5h)",
  weekly_all: "Weekly (all models)",
  seven_day: "Weekly (all models)",
  weekly_scoped: "Weekly",
  overage: "Extra usage",
};

/** Turn an unrecognized kind into something readable rather than dropping it —
 *  a new window type should still show up as a bar, just with a plain name. */
function humanizeKind(kind: string): string {
  return (
    KIND_LABELS[kind] ??
    kind.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())
  );
}

function meterFromLimitEntry(entry: unknown, index: number): UsageMeter | null {
  if (!isRecord(entry)) return null;
  const kind = str(entry.kind) ?? str(entry.group) ?? `limit_${index}`;
  const model = isRecord(entry.scope) && isRecord(entry.scope.model)
    ? str(entry.scope.model.display_name)
    : null;
  const base = humanizeKind(kind);
  return {
    key: model ? `${kind}:${model.toLowerCase()}` : kind,
    label: model ? `${base} · ${model}` : base,
    percent: percent(entry.percent ?? entry.utilization),
    resets_at: str(entry.resets_at),
    severity: str(entry.severity),
    used_usd: money(entry.used_dollars ?? entry.used),
    limit_usd: money(entry.limit_dollars ?? entry.limit),
  };
}

/** Legacy/top-level windows, used when `limits[]` is absent or empty. */
const LEGACY_WINDOW_KEYS = [
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_oauth_apps",
  "seven_day_cowork",
];

function meterFromLegacyWindow(key: string, value: unknown): UsageMeter | null {
  if (!isRecord(value)) return null;
  const pct = percent(value.utilization ?? value.percent);
  const resets = str(value.resets_at);
  const used = money(value.used_dollars);
  if (pct === null && resets === null && used === null) return null;
  return {
    key,
    label: humanizeKind(key),
    percent: pct,
    resets_at: resets,
    severity: str(value.severity),
    used_usd: used,
    limit_usd: money(value.limit_dollars),
  };
}

function parseSpend(raw: Record<string, unknown>): LiveSpend | null {
  const spend = isRecord(raw.spend) ? raw.spend : null;
  const extra = isRecord(raw.extra_usage) ? raw.extra_usage : null;
  if (!spend && !extra) return null;
  const used = money(spend?.used) ?? money(extra?.used_credits) ?? 0;
  const limit = money(spend?.limit) ?? money(extra?.monthly_limit);
  return {
    used_usd: used,
    limit_usd: limit,
    percent: percent(spend?.percent ?? extra?.utilization),
    enabled: spend?.enabled === true || extra?.is_enabled === true,
    limit_reached: extra?.spend_limit_reached === true,
    disabled_reason: str(spend?.disabled_reason ?? extra?.disabled_reason),
  };
}

/**
 * Normalize a raw `/api/oauth/usage` body. Never throws: a shape we don't
 * recognize degrades to an empty meter list, which the caller treats the same
 * way as an unreachable endpoint (fall back to the local estimate).
 */
export function normalizeOauthUsage(raw: unknown, fetchedAt: string): LiveUsage {
  const empty: LiveUsage = {
    fetched_at: fetchedAt,
    source: "claude-code-oauth",
    meters: [],
    headline: null,
    spend: null,
    plan: null,
  };
  if (!isRecord(raw)) return empty;

  let meters: UsageMeter[] = [];
  if (Array.isArray(raw.limits)) {
    meters = raw.limits
      .map((entry, i) => meterFromLimitEntry(entry, i))
      .filter((m): m is UsageMeter => m !== null);
  }
  if (meters.length === 0) {
    meters = LEGACY_WINDOW_KEYS.map((k) => meterFromLegacyWindow(k, raw[k])).filter(
      (m): m is UsageMeter => m !== null,
    );
  }

  return {
    ...empty,
    meters,
    headline: pickHeadline(meters),
    spend: parseSpend(raw),
    plan: str(raw.subscription_type) ?? str(raw.plan),
  };
}

/**
 * The meter the operator actually cares about: whichever is closest to its
 * ceiling, since that is the one that will stop the work. Ties break toward
 * the earliest reset so the more urgent window wins.
 */
export function pickHeadline(meters: UsageMeter[]): UsageMeter | null {
  const withPercent = meters.filter((m) => m.percent !== null);
  if (withPercent.length === 0) return meters[0] ?? null;
  return withPercent.reduce((best, m) => {
    if ((m.percent ?? 0) !== (best.percent ?? 0)) {
      return (m.percent ?? 0) > (best.percent ?? 0) ? m : best;
    }
    if (!m.resets_at) return best;
    if (!best.resets_at) return m;
    return m.resets_at < best.resets_at ? m : best;
  });
}

/** The parts of the cached org cost report the UI needs to judge usability. */
export interface OrgCostSnapshot {
  total_usd: number | null;
  cycle_start: string | null;
  fetched_at: string | null;
}

/**
 * Org billing dollars, but only if they describe the cycle being displayed.
 *
 * The cache is deliberately sticky: a failed poll keeps the previous figures
 * so a transient 401 or network blip doesn't blank the number, and removing
 * the admin key stops the poller without clearing what it last saw. The cost
 * of that stickiness is that a July cache outlives July. Showing July's
 * dollars against August's quota under an "org billing" label would be worse
 * than falling back to the local estimate — so the window has to match.
 */
export function orgCycleSpend(
  org: OrgCostSnapshot,
  cycleStart: string,
): { usd: number; fetched_at: string | null } | null {
  if (org.total_usd === null) return null;
  if (!org.cycle_start || org.cycle_start !== cycleStart) return null;
  return { usd: org.total_usd, fetched_at: org.fetched_at };
}

/** "resets in 2h 40m" / "resets in 3d". Empty string when unknown or past. */
export function resetsIn(resetsAt: string | null, now: Date): string {
  if (!resetsAt) return "";
  const ms = Date.parse(resetsAt) - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rem = minutes % 60;
    return rem ? `${hours}h ${rem}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH ? `${days}d ${remH}h` : `${days}d`;
}
