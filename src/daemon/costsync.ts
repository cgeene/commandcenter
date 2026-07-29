import { anthropicAdminKey } from "../config.js";
import { logEvent } from "../db/events.js";
import { getOrgCostCache, getQuotaSettings, setOrgCostCache } from "../db/settings.js";
import type { OrgCostCache } from "../db/settings.js";
import { cycleWindow } from "../lib/pricing.js";
import { isDaemonProcess } from "../process-role.js";

/**
 * Org billing dollars from the Anthropic Admin API cost report.
 *
 * Optional and env-gated (CC_ANTHROPIC_ADMIN_KEY): with no key the poller never
 * arms and costs nothing, exactly like startJiraSync with no CC_JIRA_TOKEN.
 *
 * SCOPE CAVEAT, because it is easy to misread this number: the cost report
 * covers Claude *Console/Platform API* spend. A Claude Code Team/Max seat bills
 * through a different surface, and its plan limits show up in the live usage
 * feed (usagelive.ts), not here. So on a subscription-only org this reports
 * $0 rather than the figure on the usage page — which is why the live feed,
 * not this, is the headline source.
 *
 * The admin key is read from env per request and never logged, persisted, or
 * returned over the API — only its presence is ever exposed.
 */

const COST_URL = "https://api.anthropic.com/v1/organizations/cost_report";
const POLL_MS = 3_600_000;

interface CostResult {
  amount?: unknown;
  currency?: unknown;
}
interface CostBucket {
  starting_at?: unknown;
  results?: unknown;
}

type Fetcher = (url: string, key: string) => Promise<unknown>;
let fetchCost: Fetcher = defaultFetchCost;

/** Test seam. */
export function _setCostFetch(fn: Fetcher | null): void {
  fetchCost = fn ?? defaultFetchCost;
}

async function defaultFetchCost(url: string, key: string): Promise<unknown> {
  // Daemon-only, like every other credentialed outbound call: a test run or a
  // dist-driving script must inject `_setCostFetch` rather than spend the
  // organization's admin key.
  if (!isDaemonProcess()) {
    throw new Error("cost reporting is daemon-only; inject _setCostFetch instead");
  }
  const res = await fetch(url, {
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Roll a (possibly paginated) cost report up into per-day USD.
 *
 * `amount` is a decimal string in the currency's MINOR units — "123.45" in USD
 * is $1.2345, not $123.45. Getting that wrong inflates every figure 100x, so
 * the division is the load-bearing line here.
 */
export function summarizeCostReport(pages: unknown[]): {
  total_usd: number;
  days: Record<string, number>;
} {
  const days: Record<string, number> = {};
  let total = 0;
  for (const page of pages) {
    if (typeof page !== "object" || page === null) continue;
    const data = (page as { data?: unknown }).data;
    if (!Array.isArray(data)) continue;
    for (const bucket of data as CostBucket[]) {
      const day =
        typeof bucket?.starting_at === "string" ? bucket.starting_at.slice(0, 10) : null;
      if (!day || !Array.isArray(bucket.results)) continue;
      for (const r of bucket.results as CostResult[]) {
        const amount = typeof r?.amount === "string" ? Number(r.amount) : Number.NaN;
        if (!Number.isFinite(amount)) continue;
        const usd = amount / 100;
        days[day] = (days[day] ?? 0) + usd;
        total += usd;
      }
    }
  }
  return { total_usd: total, days };
}

/** One poll. Always resolves; a failure leaves the previous figures in place. */
export async function costSyncPass(now = new Date()): Promise<OrgCostCache> {
  const key = anthropicAdminKey();
  const prev = getOrgCostCache();
  if (!key) return prev;

  const cycle = cycleWindow(now, getQuotaSettings().cycle_reset_day);
  try {
    const pages: unknown[] = [];
    let url = `${COST_URL}?starting_at=${cycle.start}T00:00:00Z&group_by[]=description`;
    // Bounded: a monthly window is ~31 daily buckets, so this is one or two
    // pages in practice. The cap only stops a malformed next_page looping.
    for (let i = 0; i < 12; i++) {
      const page = await fetchCost(url, key);
      pages.push(page);
      const p = page as { has_more?: unknown; next_page?: unknown };
      if (p?.has_more !== true || typeof p.next_page !== "string") break;
      url = `${COST_URL}?starting_at=${cycle.start}T00:00:00Z&group_by[]=description&page=${encodeURIComponent(p.next_page)}`;
    }
    const { total_usd, days } = summarizeCostReport(pages);
    const cache: OrgCostCache = {
      total_usd,
      days,
      cycle_start: cycle.start,
      fetched_at: now.toISOString(),
      error: null,
    };
    setOrgCostCache(cache);
    return cache;
  } catch (err) {
    // Message only, never the key or the response body.
    const reason = err instanceof Error ? err.message : "cost report fetch failed";
    if (prev.error !== reason) logEvent("usage.org_cost_unavailable", { payload: { reason } });
    const cache: OrgCostCache = { ...prev, error: reason };
    setOrgCostCache(cache);
    return cache;
  }
}

export function startCostSync(): void {
  if (!anthropicAdminKey()) {
    console.log("org cost sync disabled: no CC_ANTHROPIC_ADMIN_KEY");
    return;
  }
  costSyncPass().catch((err) => console.error("cost sync (startup) failed:", err));
  setInterval(() => {
    costSyncPass().catch((err) => console.error("cost sync failed:", err));
  }, POLL_MS);
}
