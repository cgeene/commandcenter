import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { claudeHomeDir, liveUsageEnabled } from "../config.js";
import { logEvent } from "../db/events.js";
import { getLiveUsageCache, setLiveUsageCache } from "../db/settings.js";
import { normalizeOauthUsage, type LiveUsageState } from "../lib/usage.js";

export type { LiveUsageState };

/**
 * Live "how much of my quota have I used" feed — the headline number.
 *
 * This is the one source that matches what the operator sees on the claude.ai
 * usage page, because it is literally the call Claude Code's own `/usage`
 * command makes. That matters: the local transcript estimate (tokens.ts) only
 * ever sees work this daemon orchestrated, so it can never reconcile with a
 * figure that also includes interactive Claude Code sessions on this machine.
 *
 * Two deliberate constraints:
 *
 *  1. READ-ONLY on the credential. Claude Code owns the OAuth token and
 *     refreshes it (~2h lifetime) in its own process. We read whatever is
 *     current and use it. We never run the refresh_token grant ourselves —
 *     refresh tokens rotate, and racing Claude Code for one would invalidate
 *     the operator's login. An expired token here is simply a skipped poll.
 *  2. UNDOCUMENTED upstream. `/api/oauth/usage` is internal to Claude Code and
 *     its response shape drifts between releases, so parsing lives behind the
 *     tolerant normalizer in lib/usage.ts and every failure degrades to the
 *     local estimate instead of surfacing an error to the operator.
 *
 * The token is never logged, never written to the DB, and never returned over
 * the HTTP API — same handling contract as CC_JIRA_TOKEN.
 */

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const POLL_MS = 3_600_000; // hourly; the dashboard also exposes a manual refresh
const KEYCHAIN_SERVICE = "Claude Code-credentials";
/** The live entry's account. A second, stale entry exists under the operator's
 *  email address and a bare lookup returns THAT one — always ask by account. */
const KEYCHAIN_ACCOUNT = "claude-code-user";

interface Credential {
  token: string;
  /** Epoch ms. Null when the payload omitted it. */
  expires_at: number | null;
}

/* ---- test seams: swap the two impure edges ---- */

type Fetcher = (token: string) => Promise<unknown>;
let fetchUsage: Fetcher = defaultFetchUsage;
let readCredential: () => Credential | undefined = defaultReadCredential;

export function _setUsageFetch(fn: Fetcher | null): void {
  fetchUsage = fn ?? defaultFetchUsage;
}
export function _setCredentialReader(fn: (() => Credential | undefined) | null): void {
  readCredential = fn ?? defaultReadCredential;
}

/* ---- credential access ---- */

/** Pull the accessToken out of a credentials payload without ever copying the
 *  rest of it around. Shape: {claudeAiOauth: {accessToken, expiresAt, ...}}. */
function parseCredential(raw: string): Credential | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const outer = parsed as Record<string, unknown>;
  const inner =
    typeof outer.claudeAiOauth === "object" && outer.claudeAiOauth !== null
      ? (outer.claudeAiOauth as Record<string, unknown>)
      : outer;
  const token = inner.accessToken;
  if (typeof token !== "string" || !token) return undefined;
  const expires = inner.expiresAt;
  return {
    token,
    expires_at: typeof expires === "number" && Number.isFinite(expires) ? expires : null,
  };
}

function defaultReadCredential(): Credential | undefined {
  // macOS: the login keychain. Ask for the specific account — the bare
  // service lookup resolves to a long-dead duplicate entry.
  if (process.platform === "darwin") {
    for (const args of [
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
    ]) {
      try {
        const out = execFileSync("security", args, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        const cred = parseCredential(out);
        if (cred) return cred;
      } catch {
        /* entry absent or locked — try the next lookup */
      }
    }
  }
  // Linux / WSL, and macOS installs that keep credentials on disk.
  try {
    return parseCredential(
      fs.readFileSync(path.join(claudeHomeDir(), ".credentials.json"), "utf8"),
    );
  } catch {
    return undefined;
  }
}

async function defaultFetchUsage(token: string): Promise<unknown> {
  const res = await fetch(USAGE_URL, {
    headers: {
      // The token goes on the wire and nowhere else — not into logs, events,
      // the settings table, or any API response.
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/* ---- poll ---- */

/** Distinct failure reasons already logged this run, so a persistently missing
 *  credential doesn't write an event every hour. */
const loggedReasons = new Set<string>();

export function _resetLiveUsageState(): void {
  loggedReasons.clear();
}

function noteFailure(reason: string): LiveUsageState {
  const prev = getLiveUsageCache();
  if (!loggedReasons.has(reason)) {
    loggedReasons.add(reason);
    logEvent("usage.live_unavailable", { payload: { reason } });
  }
  const state: LiveUsageState = {
    usage: prev.usage,
    error: reason,
    checked_at: new Date().toISOString(),
  };
  setLiveUsageCache(state);
  return state;
}

/**
 * Fetch once and cache. Always resolves — callers treat a non-null `error`
 * with a null `usage` as "show the local estimate instead".
 */
export async function refreshLiveUsage(): Promise<LiveUsageState> {
  if (!liveUsageEnabled()) return noteFailure("disabled by CC_LIVE_USAGE=0");

  const cred = readCredential();
  if (!cred) return noteFailure("no Claude Code credentials found on this machine");
  // Claude Code refreshes on its own cadence; if it hasn't yet, skip rather
  // than burn a guaranteed-401 request (and never refresh the token ourselves).
  if (cred.expires_at !== null && cred.expires_at <= Date.now()) {
    return noteFailure("Claude Code OAuth token expired — it refreshes on next use");
  }

  let raw: unknown;
  try {
    raw = await fetchUsage(cred.token);
  } catch (err) {
    // Message only — an upstream error body could echo request context, and a
    // stack could carry the URL with credentials attached by a future change.
    return noteFailure(err instanceof Error ? err.message : "usage fetch failed");
  }

  const usage = normalizeOauthUsage(raw, new Date().toISOString());
  if (usage.meters.length === 0 && !usage.spend) {
    return noteFailure("usage payload had no recognizable quota fields");
  }
  loggedReasons.clear(); // recovered — let the next distinct failure log again
  const state: LiveUsageState = {
    usage,
    error: null,
    checked_at: new Date().toISOString(),
  };
  setLiveUsageCache(state);
  return state;
}

/** Last known state without hitting the network. */
export function getLiveUsage(): LiveUsageState {
  return getLiveUsageCache();
}

export function startLiveUsageSync(): void {
  if (!liveUsageEnabled()) {
    console.log("live usage disabled: CC_LIVE_USAGE=0");
    return;
  }
  // Startup fetch, then hourly — mirrors startPrSync / startJiraSync.
  refreshLiveUsage().catch((err) =>
    console.error("live usage (startup) failed:", err),
  );
  setInterval(() => {
    refreshLiveUsage().catch((err) => console.error("live usage refresh failed:", err));
  }, POLL_MS);
}
