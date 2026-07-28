import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { claudeHomeDir, liveUsageEnabled } from "../config.js";
import { logEvent } from "../db/events.js";
import { getLiveUsageCache, setLiveUsageCache } from "../db/settings.js";
import { normalizeOauthUsage, type LiveUsageState } from "../lib/usage.js";
import { runQuotaAlerts } from "./quotaalert.js";

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
/** Hard ceiling on the keychain lookup. A locked keychain or an un-approved
 *  ACL makes `security` sit on a GUI prompt indefinitely; we'd rather report
 *  the credential as unavailable and fall back to the local estimate. */
const KEYCHAIN_TIMEOUT_MS = 5_000;

interface Credential {
  token: string;
  /** Epoch ms. Null when the payload omitted it. */
  expires_at: number | null;
}

/* ---- test seams: swap the two impure edges ---- */

type Fetcher = (token: string) => Promise<unknown>;
type CredentialReader = () => Credential | undefined | Promise<Credential | undefined>;
let fetchUsage: Fetcher = defaultFetchUsage;
let readCredential: CredentialReader = defaultReadCredential;

export function _setUsageFetch(fn: Fetcher | null): void {
  fetchUsage = fn ?? defaultFetchUsage;
}
export function _setCredentialReader(fn: CredentialReader | null): void {
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

const execFileAsync = promisify(execFile);

/**
 * Read the current OAuth credential. Fully async and hard-bounded.
 *
 * `security` is not a safe synchronous call: if /usr/bin/security isn't already
 * ACL-approved for the keychain item, or the keychain is locked, macOS raises a
 * GUI prompt and the process waits on a human. Doing that synchronously would
 * wedge the whole event loop — blocking daemon startup and every HTTP request,
 * including the /api/usage/refresh route that reaches this same code. So: never
 * execFileSync, and always a timeout with a hard kill.
 */
async function defaultReadCredential(): Promise<Credential | undefined> {
  // macOS: the login keychain. Ask for the specific account — the bare
  // service lookup resolves to a long-dead duplicate entry.
  if (process.platform === "darwin") {
    for (const args of [
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
    ]) {
      try {
        const { stdout } = await execFileAsync("security", args, {
          encoding: "utf8",
          timeout: KEYCHAIN_TIMEOUT_MS,
          killSignal: "SIGKILL",
        });
        const cred = parseCredential(stdout);
        if (cred) return cred;
      } catch {
        /* absent, locked, or timed out — try the next lookup */
      }
    }
  }
  // Linux / WSL, and macOS installs that keep credentials on disk.
  try {
    return parseCredential(
      await fs.promises.readFile(path.join(claudeHomeDir(), ".credentials.json"), "utf8"),
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
  // Gate the manual-refresh route too, not just the poller — otherwise an
  // opt-out install could still be made to read the credential over HTTP.
  if (!liveUsageEnabled()) return noteFailure("live usage not enabled (set CC_LIVE_USAGE=1)");

  const cred = await readCredential();
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
  // Only on the success path: alerting off a stale cached reading would page
  // for a window that may already have rolled over.
  runQuotaAlerts(usage);
  return state;
}

/** Last known state without hitting the network. */
export function getLiveUsage(): LiveUsageState {
  return getLiveUsageCache();
}

export function startLiveUsageSync(): void {
  if (!liveUsageEnabled()) {
    // Opt-in only: without CC_LIVE_USAGE=1 the daemon never reads the stored
    // OAuth credential, and the dashboard falls back to the local estimate.
    console.log("live usage disabled: set CC_LIVE_USAGE=1 to enable");
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
