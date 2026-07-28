import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let tmpDir: string;

const ENV_KEYS = [
  "CC_ANTHROPIC_ADMIN_KEY",
  "CC_LIVE_USAGE",
  "CC_CLAUDE_HOME",
  "CC_CLAUDE_PROJECTS",
] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-burn-")));
  process.env.CC_DATA_DIR = path.join(tmpDir, "data");
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  // Point the credential reader at an empty dir so no test can reach the real
  // keychain fallback path on a developer machine.
  process.env.CC_CLAUDE_HOME = path.join(tmpDir, "claude-home");
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const counts = (input: number, output: number, cacheRead = 0, cacheCreation = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read: cacheRead,
  cache_creation: cacheCreation,
});

describe("token_daily migration", () => {
  it("creates the burn tables on an existing database", async () => {
    const { getDb } = await import("../src/db/db.js");
    const db = getDb();
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(tables).toContain("token_daily");
    expect(tables).toContain("token_samples");

    const cols = (
      db.prepare("PRAGMA table_info(token_daily)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toEqual([
      "day",
      "agent_kind",
      "model",
      "input_tokens",
      "output_tokens",
      "cache_read",
      "cache_creation",
    ]);
  });

  it("is idempotent — re-opening the database preserves recorded burn", async () => {
    const { recordTokenSample, allBuckets } = await import("../src/db/tokens.js");
    recordTokenSample("s1", "worker", new Map([["claude-opus-5", counts(100, 20)]]));
    const { closeDb } = await import("../src/db/db.js");
    closeDb();
    expect(allBuckets()).toHaveLength(1);
  });
});

describe("delta bucketing", () => {
  it("accumulates two samples on the same day, counting each turn once", async () => {
    const { recordTokenSample, allBuckets } = await import("../src/db/tokens.js");
    const day = new Date("2026-07-20T09:00:00Z");

    recordTokenSample("s1", "worker", new Map([["claude-opus-5", counts(1000, 100)]]), day);
    // Transcripts are cumulative: the second read includes the first read's
    // tokens, so only the difference may be added.
    recordTokenSample(
      "s1",
      "worker",
      new Map([["claude-opus-5", counts(2500, 300)]]),
      new Date("2026-07-20T17:00:00Z"),
    );

    const rows = allBuckets();
    expect(rows).toHaveLength(1);
    expect(rows[0].day).toBe("2026-07-20");
    expect(rows[0].input_tokens).toBe(2500);
    expect(rows[0].output_tokens).toBe(300);
  });

  it("splits at a day rollover, charging each day only its own delta", async () => {
    const { recordTokenSample, allBuckets } = await import("../src/db/tokens.js");
    recordTokenSample(
      "s1",
      "worker",
      new Map([["claude-opus-5", counts(1000, 100)]]),
      new Date("2026-07-20T23:00:00Z"),
    );
    recordTokenSample(
      "s1",
      "worker",
      new Map([["claude-opus-5", counts(2500, 300)]]),
      new Date("2026-07-21T01:00:00Z"),
    );

    const rows = allBuckets().sort((a, b) => a.day.localeCompare(b.day));
    expect(rows.map((r) => [r.day, r.input_tokens, r.output_tokens])).toEqual([
      ["2026-07-20", 1000, 100],
      ["2026-07-21", 1500, 200],
    ]);
  });

  it("keeps separate watermarks per session and per model", async () => {
    const { recordTokenSample, allBuckets } = await import("../src/db/tokens.js");
    const day = new Date("2026-07-20T09:00:00Z");
    recordTokenSample(
      "s1",
      "worker",
      new Map([
        ["claude-opus-5", counts(1000, 100)],
        ["claude-haiku-4-5", counts(500, 50)],
      ]),
      day,
    );
    // A different session starts from zero, not from s1's watermark.
    recordTokenSample("s2", "worker", new Map([["claude-opus-5", counts(700, 70)]]), day);

    const rows = allBuckets();
    const opus = rows.find((r) => r.model === "claude-opus-5")!;
    const haiku = rows.find((r) => r.model === "claude-haiku-4-5")!;
    expect(opus.input_tokens).toBe(1700);
    expect(haiku.input_tokens).toBe(500);
  });

  it("keeps reviewer and worker burn in separate rows", async () => {
    const { recordTokenSample, allBuckets } = await import("../src/db/tokens.js");
    const day = new Date("2026-07-20T09:00:00Z");
    recordTokenSample("w", "worker", new Map([["claude-opus-5", counts(100, 10)]]), day);
    recordTokenSample("r", "reviewer", new Map([["claude-opus-5", counts(200, 20)]]), day);
    expect(allBuckets().map((r) => r.agent_kind).sort()).toEqual(["reviewer", "worker"]);
  });

  it("ignores a cumulative total that went backwards instead of subtracting", async () => {
    const { recordTokenSample, allBuckets } = await import("../src/db/tokens.js");
    const day = new Date("2026-07-20T09:00:00Z");
    recordTokenSample("s1", "worker", new Map([["claude-opus-5", counts(1000, 100)]]), day);
    // A re-created or truncated transcript reads lower than before.
    recordTokenSample("s1", "worker", new Map([["claude-opus-5", counts(400, 40)]]), day);
    expect(allBuckets()[0].input_tokens).toBe(1000);

    // ...and the watermark re-baselines, so the next genuine delta is correct
    // rather than being swallowed until the old peak is passed.
    recordTokenSample("s1", "worker", new Map([["claude-opus-5", counts(600, 60)]]), day);
    expect(allBuckets()[0].input_tokens).toBe(1200);
  });

  it("records nothing for an empty sample", async () => {
    const { recordTokenSample, allBuckets } = await import("../src/db/tokens.js");
    recordTokenSample("s1", "worker", new Map());
    expect(allBuckets()).toEqual([]);
  });
});

describe("burn summaries", () => {
  it("costs each day and reports unpriced tokens separately", async () => {
    const { recordTokenSample, dayBuckets, summarizeByDay, summarizeByModel, earliestTrackedDay } =
      await import("../src/db/tokens.js");
    const day = new Date("2026-07-20T09:00:00Z");
    recordTokenSample(
      "s1",
      "worker",
      new Map([["claude-opus-5", counts(1_000_000, 0)]]),
      day,
    );
    // A Codex worker: real tokens, but not Anthropic-billed, so it must not
    // silently contribute $0 to a total presented as complete.
    recordTokenSample("s2", "worker", new Map([["gpt-5-codex", counts(2_000_000, 0)]]), day);

    const buckets = dayBuckets("2026-07-01", "2026-08-01");
    const [today] = summarizeByDay(buckets);
    expect(today.cost_usd).toBeCloseTo(5, 6);
    expect(today.tokens).toBe(3_000_000);
    expect(today.unpriced_tokens).toBe(2_000_000);

    const byModel = summarizeByModel(buckets);
    expect(byModel[0].model).toBe("gpt-5-codex");
    expect(byModel[0].priced).toBe(false);
    expect(byModel.find((m) => m.model === "claude-opus-5")!.cost_usd).toBeCloseTo(5, 6);

    expect(earliestTrackedDay()).toBe("2026-07-20");
  });

  it("scopes the cycle query to its window", async () => {
    const { recordTokenSample, dayBuckets } = await import("../src/db/tokens.js");
    recordTokenSample("a", "worker", new Map([["claude-opus-5", counts(10, 1)]]), new Date("2026-06-30T09:00:00Z"));
    recordTokenSample("b", "worker", new Map([["claude-opus-5", counts(20, 2)]]), new Date("2026-07-05T09:00:00Z"));
    recordTokenSample("c", "worker", new Map([["claude-opus-5", counts(30, 3)]]), new Date("2026-08-01T09:00:00Z"));

    expect(dayBuckets("2026-07-01", "2026-08-01").map((r) => r.day)).toEqual(["2026-07-05"]);
  });

  it("reports no tracking history before the first sample", async () => {
    const { earliestTrackedDay } = await import("../src/db/tokens.js");
    expect(earliestTrackedDay()).toBeNull();
  });
});

describe("per-model transcript sums", () => {
  const SID = "bbbb2222-0000-0000-0000-000000000000";

  /** Mirrors a real Claude transcript: `message.model` on every assistant turn
   *  (verified against a live JSONL — the field is present and is the full
   *  API id, e.g. "claude-opus-4-8"). */
  function writeTranscript(turns: Array<{ model?: string; inp: number; out: number }>) {
    const dir = path.join(process.env.CC_CLAUDE_PROJECTS!, "-x-repo");
    fs.mkdirSync(dir, { recursive: true });
    const lines = turns.map((t) =>
      JSON.stringify({
        type: "assistant",
        message: {
          ...(t.model ? { model: t.model } : {}),
          usage: {
            input_tokens: t.inp,
            output_tokens: t.out,
            cache_read_input_tokens: 10,
            cache_creation_input_tokens: 5,
          },
        },
      }),
    );
    lines.push(JSON.stringify({ type: "user", message: { content: "hi" } }));
    fs.writeFileSync(path.join(dir, `${SID}.jsonl`), lines.join("\n"));
  }

  beforeEach(() => {
    process.env.CC_CLAUDE_PROJECTS = path.join(tmpDir, "projects");
    fs.mkdirSync(process.env.CC_CLAUDE_PROJECTS, { recursive: true });
  });

  it("splits a mixed-model session by the model that served each turn", async () => {
    writeTranscript([
      { model: "claude-opus-4-8", inp: 1000, out: 100 },
      { model: "claude-haiku-4-5", inp: 300, out: 30 },
      { model: "claude-opus-4-8", inp: 2000, out: 200 },
    ]);
    const { sessionTokensByModel } = await import("../src/daemon/transcript.js");
    const byModel = sessionTokensByModel(SID, "fallback");

    expect([...byModel.keys()].sort()).toEqual(["claude-haiku-4-5", "claude-opus-4-8"]);
    expect(byModel.get("claude-opus-4-8")!.input).toBe(3000);
    expect(byModel.get("claude-opus-4-8")!.cache_read).toBe(20);
    expect(byModel.get("claude-haiku-4-5")!.output).toBe(30);
  });

  it("attributes turns with no recorded model to the agent's configured one", async () => {
    writeTranscript([{ inp: 500, out: 50 }]);
    const { sessionTokensByModel } = await import("../src/daemon/transcript.js");
    expect(sessionTokensByModel(SID, "claude-sonnet-5").get("claude-sonnet-5")!.input).toBe(500);
  });

  it("returns nothing for a session with no transcript", async () => {
    const { sessionTokensByModel } = await import("../src/daemon/transcript.js");
    expect(sessionTokensByModel("no-such-session", "opus").size).toBe(0);
  });
});

describe("quota settings", () => {
  it("round-trips and merges partial patches", async () => {
    const { getQuotaSettings, setQuotaSettings } = await import("../src/db/settings.js");
    expect(getQuotaSettings()).toEqual({ monthly_quota_usd: null, cycle_reset_day: 1 });

    setQuotaSettings({ monthly_quota_usd: 250, cycle_reset_day: 15 });
    expect(getQuotaSettings()).toEqual({ monthly_quota_usd: 250, cycle_reset_day: 15 });

    // A patch touching one field leaves the other alone.
    setQuotaSettings({ monthly_quota_usd: 400 });
    expect(getQuotaSettings()).toEqual({ monthly_quota_usd: 400, cycle_reset_day: 15 });

    // Clearing the quota drops the budget line but keeps the cycle.
    setQuotaSettings({ monthly_quota_usd: null });
    expect(getQuotaSettings()).toEqual({ monthly_quota_usd: null, cycle_reset_day: 15 });
  });
});

describe("live usage poller", () => {
  const OK_PAYLOAD = {
    limits: [
      { kind: "session", percent: 57, resets_at: "2026-07-28T02:40:00Z" },
      { kind: "weekly_all", percent: 31, resets_at: "2026-07-28T23:59:59Z" },
    ],
    spend: { used: { amount_minor: 0, exponent: 2 }, limit: null, enabled: false },
  };

  it("caches a successful fetch", async () => {
    const mod = await import("../src/daemon/usagelive.js");
    mod._resetLiveUsageState();
    mod._setCredentialReader(() => ({ token: "t", expires_at: Date.now() + 3_600_000 }));
    mod._setUsageFetch(async () => OK_PAYLOAD);

    const state = await mod.refreshLiveUsage();
    expect(state.error).toBeNull();
    expect(state.usage?.headline?.percent).toBe(57);
    // Persisted, so a restart still renders a number immediately.
    expect(mod.getLiveUsage().usage?.headline?.percent).toBe(57);
    mod._setUsageFetch(null);
    mod._setCredentialReader(null);
  });

  it("keeps the last good reading when a later fetch fails", async () => {
    const mod = await import("../src/daemon/usagelive.js");
    mod._resetLiveUsageState();
    mod._setCredentialReader(() => ({ token: "t", expires_at: Date.now() + 3_600_000 }));
    mod._setUsageFetch(async () => OK_PAYLOAD);
    await mod.refreshLiveUsage();

    mod._setUsageFetch(async () => {
      throw new Error("HTTP 503");
    });
    const state = await mod.refreshLiveUsage();
    expect(state.error).toBe("HTTP 503");
    expect(state.usage?.headline?.percent).toBe(57);
    mod._setUsageFetch(null);
    mod._setCredentialReader(null);
  });

  it("reports missing credentials without throwing", async () => {
    const mod = await import("../src/daemon/usagelive.js");
    mod._resetLiveUsageState();
    mod._setCredentialReader(() => undefined);
    const state = await mod.refreshLiveUsage();
    expect(state.usage).toBeNull();
    expect(state.error).toMatch(/credentials/i);
    mod._setCredentialReader(null);
  });

  it("skips the request entirely on an expired token rather than forcing a refresh", async () => {
    const mod = await import("../src/daemon/usagelive.js");
    mod._resetLiveUsageState();
    let called = false;
    mod._setCredentialReader(() => ({ token: "t", expires_at: Date.now() - 1000 }));
    mod._setUsageFetch(async () => {
      called = true;
      return OK_PAYLOAD;
    });
    const state = await mod.refreshLiveUsage();
    expect(called).toBe(false);
    expect(state.error).toMatch(/expired/i);
    mod._setUsageFetch(null);
    mod._setCredentialReader(null);
  });

  it("treats an unreadable payload as unavailable rather than as zero usage", async () => {
    const mod = await import("../src/daemon/usagelive.js");
    mod._resetLiveUsageState();
    mod._setCredentialReader(() => ({ token: "t", expires_at: Date.now() + 3_600_000 }));
    mod._setUsageFetch(async () => ({ something_new: true }));
    const state = await mod.refreshLiveUsage();
    expect(state.usage).toBeNull();
    expect(state.error).toMatch(/recognizable/i);
    mod._setUsageFetch(null);
    mod._setCredentialReader(null);
  });

  it("stays inert when disabled by env", async () => {
    process.env.CC_LIVE_USAGE = "0";
    const mod = await import("../src/daemon/usagelive.js");
    mod._resetLiveUsageState();
    let called = false;
    mod._setCredentialReader(() => {
      called = true;
      return { token: "t", expires_at: Date.now() + 3_600_000 };
    });
    const state = await mod.refreshLiveUsage();
    expect(called).toBe(false);
    expect(state.error).toMatch(/disabled/i);
    mod._setCredentialReader(null);
  });
});

describe("org cost report poller", () => {
  const page = (day: string, amounts: string[]) => ({
    data: [{ starting_at: `${day}T00:00:00Z`, results: amounts.map((amount) => ({ amount, currency: "USD" })) }],
    has_more: false,
  });

  it("reads amounts as minor units, not dollars", async () => {
    const { summarizeCostReport } = await import("../src/daemon/costsync.js");
    // "12345" cents = $123.45.
    const { total_usd, days } = summarizeCostReport([page("2026-07-20", ["12345"])]);
    expect(total_usd).toBeCloseTo(123.45, 6);
    expect(days["2026-07-20"]).toBeCloseTo(123.45, 6);
  });

  it("sums grouped results per day across pages", async () => {
    const { summarizeCostReport } = await import("../src/daemon/costsync.js");
    const { total_usd, days } = summarizeCostReport([
      page("2026-07-20", ["1000", "500"]),
      page("2026-07-21", ["250"]),
    ]);
    expect(days["2026-07-20"]).toBeCloseTo(15, 6);
    expect(days["2026-07-21"]).toBeCloseTo(2.5, 6);
    expect(total_usd).toBeCloseTo(17.5, 6);
  });

  it("ignores malformed rows instead of producing NaN", async () => {
    const { summarizeCostReport } = await import("../src/daemon/costsync.js");
    const { total_usd } = summarizeCostReport([
      { data: [{ starting_at: "2026-07-20T00:00:00Z", results: [{ amount: "oops" }, { amount: 5 }, { amount: "100" }] }] },
      null,
      { data: "not-an-array" },
    ]);
    expect(total_usd).toBeCloseTo(1, 6);
  });

  it("stays inert with no admin key", async () => {
    const mod = await import("../src/daemon/costsync.js");
    let called = false;
    mod._setCostFetch(async () => {
      called = true;
      return page("2026-07-20", ["100"]);
    });
    const cache = await mod.costSyncPass();
    expect(called).toBe(false);
    expect(cache.total_usd).toBeNull();
    mod._setCostFetch(null);
  });

  it("caches a successful pass and records a failure without losing it", async () => {
    process.env.CC_ANTHROPIC_ADMIN_KEY = "sk-ant-admin01-test";
    const mod = await import("../src/daemon/costsync.js");
    mod._setCostFetch(async () => page("2026-07-20", ["12345"]));
    const ok = await mod.costSyncPass(new Date("2026-07-27T12:00:00Z"));
    expect(ok.error).toBeNull();
    expect(ok.total_usd).toBeCloseTo(123.45, 6);

    mod._setCostFetch(async () => {
      throw new Error("HTTP 401");
    });
    const failed = await mod.costSyncPass(new Date("2026-07-27T13:00:00Z"));
    expect(failed.error).toBe("HTTP 401");
    expect(failed.total_usd).toBeCloseTo(123.45, 6);
    mod._setCostFetch(null);
  });
});
