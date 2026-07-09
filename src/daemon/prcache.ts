import { execFile } from "node:child_process";
import { parsePrUrl } from "./prsync.js";

/**
 * Cheap, cached PR-state lookups for the "Needs You" panel. The dashboard
 * polls /api/attention every couple of seconds; a `gh` call per poll per PR
 * would hammer the API, so each URL's state is cached for TTL_MS. On a `gh`
 * failure we keep any stale value (else cache "unknown" for the TTL) so a
 * flaky call never turns into a call storm.
 *
 * "unknown" is deliberately treated as still-open by callers: if we can't
 * confirm a merge, surfacing a stale merge reminder is safer than hiding a
 * real one.
 */

export type PrLifecycle = "OPEN" | "MERGED" | "CLOSED" | "unknown";

interface CacheEntry {
  state: PrLifecycle;
  at: number; // epoch ms of the fetch
}

const TTL_MS = 5 * 60_000;
const cache = new Map<string, CacheEntry>();

function ghState(url: string): Promise<PrLifecycle> {
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      ["pr", "view", url, "--json", "state"],
      { timeout: 15_000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr.trim() || err.message));
        try {
          const parsed = JSON.parse(stdout) as { state?: string };
          const s = (parsed.state ?? "").toUpperCase();
          resolve(s === "OPEN" || s === "MERGED" || s === "CLOSED" ? s : "unknown");
        } catch {
          resolve("unknown");
        }
      },
    );
  });
}

/** Cached PR state for one URL. `nowMs` is injectable for tests. */
export async function prState(url: string, nowMs = Date.now()): Promise<PrLifecycle> {
  if (!parsePrUrl(url)) return "unknown";
  const hit = cache.get(url);
  if (hit && nowMs - hit.at < TTL_MS) return hit.state;
  try {
    const state = await ghState(url);
    cache.set(url, { state, at: nowMs });
    return state;
  } catch {
    if (hit) return hit.state; // keep last known rather than churn on failure
    cache.set(url, { state: "unknown", at: nowMs });
    return "unknown";
  }
}

/** Resolve many URLs to their (cached) states in one map. */
export async function prStates(
  urls: string[],
  nowMs = Date.now(),
): Promise<Map<string, PrLifecycle>> {
  const map = new Map<string, PrLifecycle>();
  await Promise.all(
    [...new Set(urls)].map(async (url) => {
      map.set(url, await prState(url, nowMs));
    }),
  );
  return map;
}

/** Test helpers — seed/clear the cache so unit tests never shell out to gh. */
export function _seedPrCache(url: string, state: PrLifecycle, atMs: number): void {
  cache.set(url, { state, at: atMs });
}

export function _clearPrCache(): void {
  cache.clear();
}
