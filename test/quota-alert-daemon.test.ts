import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveUsage, UsageMeter } from "../src/lib/usage.js";

/**
 * The wired-up half of quota alerting: the settings-backed threshold, the
 * persisted latch, the ntfy push, and the guarantee that a broken live feed
 * stays silent. The latch logic itself is covered purely in quota-alert.test.ts.
 */

let tmpDir: string;
let notifyModule: typeof import("../src/daemon/notify.js");
let fetchMock: ReturnType<typeof vi.fn>;

/** Pushes produced so far. Dispatch is daemon-only, so a test run records the
 *  intent instead of sending it (see test/notify-dispatch-guard.test.ts). */
function pushes(): { title: string; body: string }[] {
  return notifyModule
    .recordedPushes()
    .map((push) => ({ title: push.title, body: push.message }));
}

const ENV_KEYS = ["CC_NTFY_URL", "CC_NTFY_TOKEN", "CC_LIVE_USAGE", "CC_CLAUDE_HOME"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-quota-alert-")));
  process.env.CC_DATA_DIR = path.join(tmpDir, "data");
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.CC_NTFY_URL = "https://ntfy.example/cc-test";
  // No test may reach the real keychain or a developer's on-disk credential.
  process.env.CC_CLAUDE_HOME = path.join(tmpDir, "claude-home");

  // A tripwire, not a collector: no test here may reach the network.
  fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  notifyModule = await import("../src/daemon/notify.js");
  notifyModule.clearRecordedPushes();
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  expect(fetchMock).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const RESETS = "2099-01-01T00:00:00.000Z"; // always in the window

function usage(percent: number, over: Partial<LiveUsage> = {}): LiveUsage {
  const headline: UsageMeter = {
    key: "session",
    label: "Session (5h)",
    percent,
    resets_at: RESETS,
    severity: null,
    used_usd: null,
    limit_usd: null,
  };
  return {
    fetched_at: new Date().toISOString(),
    source: "claude-code-oauth",
    meters: [headline],
    headline,
    spend: null,
    plan: "team",
    ...over,
  };
}

/** Wait for notify()'s fire-and-forget fetch to be observed. */
const flush = () => new Promise((r) => setImmediate(r));

describe("runQuotaAlerts", () => {
  it("pushes once on the crossing, persists the latch, and stays quiet after", async () => {
    const { runQuotaAlerts } = await import("../src/daemon/quotaalert.js");
    const { getQuotaAlertLatch } = await import("../src/db/settings.js");

    runQuotaAlerts(usage(70));
    await flush();
    expect(pushes()).toHaveLength(0);

    runQuotaAlerts(usage(85));
    await flush();
    expect(pushes()).toHaveLength(1);
    expect(pushes()[0].title).toContain("85%");
    expect(getQuotaAlertLatch().threshold_window).toBe(`session@${RESETS}`);

    runQuotaAlerts(usage(92));
    await flush();
    expect(pushes()).toHaveLength(1); // the hourly re-observation must not re-page
  });

  it("logs an event for the crossing", async () => {
    const { runQuotaAlerts } = await import("../src/daemon/quotaalert.js");
    const { listEvents } = await import("../src/db/events.js");
    runQuotaAlerts(usage(85));
    const logged = listEvents().filter((e) => e.kind === "usage.quota_threshold");
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0].payload!)).toMatchObject({ percent: 85, threshold: 80 });
  });

  it("honours the configured threshold", async () => {
    const { runQuotaAlerts } = await import("../src/daemon/quotaalert.js");
    const { setQuotaSettings } = await import("../src/db/settings.js");

    setQuotaSettings({ alert_threshold_percent: 50 });
    runQuotaAlerts(usage(55));
    await flush();
    expect(pushes()).toHaveLength(1);
  });

  it("never pushes when the threshold is cleared", async () => {
    const { runQuotaAlerts } = await import("../src/daemon/quotaalert.js");
    const { setQuotaSettings } = await import("../src/db/settings.js");

    setQuotaSettings({ alert_threshold_percent: null });
    runQuotaAlerts(usage(99));
    await flush();
    expect(pushes()).toHaveLength(0);
  });

  it("pushes on the spend cap", async () => {
    const { runQuotaAlerts } = await import("../src/daemon/quotaalert.js");
    runQuotaAlerts(
      usage(10, {
        spend: {
          used_usd: 50,
          limit_usd: 50,
          percent: 100,
          enabled: true,
          limit_reached: true,
          disabled_reason: null,
        },
      }),
    );
    await flush();
    expect(pushes()).toHaveLength(1);
    expect(pushes()[0].title).toContain("spend limit");
  });
});

describe("refreshLiveUsage — a broken feed never pages", () => {
  it("stays silent when the credential is missing", async () => {
    process.env.CC_LIVE_USAGE = "1";
    const { refreshLiveUsage, _setCredentialReader, _resetLiveUsageState } = await import(
      "../src/daemon/usagelive.js"
    );
    _resetLiveUsageState();
    _setCredentialReader(() => undefined);
    try {
      const state = await refreshLiveUsage();
      expect(state.error).toBeTruthy();
      await flush();
      expect(pushes()).toHaveLength(0);
    } finally {
      _setCredentialReader(null);
    }
  });

  it("stays silent when the fetch fails, even with a hot cached reading", async () => {
    process.env.CC_LIVE_USAGE = "1";
    const { refreshLiveUsage, _setCredentialReader, _setUsageFetch, _resetLiveUsageState } =
      await import("../src/daemon/usagelive.js");
    const { setLiveUsageCache, getQuotaAlertLatch } = await import("../src/db/settings.js");
    _resetLiveUsageState();
    setLiveUsageCache({ usage: usage(97), error: null, checked_at: new Date().toISOString() });
    _setCredentialReader(() => ({ token: "t", expires_at: null }));
    _setUsageFetch(async () => {
      throw new Error("HTTP 503");
    });
    try {
      await refreshLiveUsage();
      await flush();
      expect(pushes()).toHaveLength(0);
      expect(getQuotaAlertLatch().threshold_window).toBeNull();
    } finally {
      _setCredentialReader(null);
      _setUsageFetch(null);
    }
  });

  it("pages off a successful poll that comes back over the threshold", async () => {
    process.env.CC_LIVE_USAGE = "1";
    const { refreshLiveUsage, _setCredentialReader, _setUsageFetch, _resetLiveUsageState } =
      await import("../src/daemon/usagelive.js");
    _resetLiveUsageState();
    _setCredentialReader(() => ({ token: "t", expires_at: null }));
    _setUsageFetch(async () => ({
      limits: [{ kind: "session", percent: 93, resets_at: RESETS, is_active: true }],
    }));
    try {
      const state = await refreshLiveUsage();
      expect(state.error).toBeNull();
      await flush();
      expect(pushes().map((p) => p.title)).toEqual(["Claude quota 93% used"]);
    } finally {
      _setCredentialReader(null);
      _setUsageFetch(null);
    }
  });
});
