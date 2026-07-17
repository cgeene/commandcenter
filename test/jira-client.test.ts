import { describe, expect, it } from "vitest";
import {
  buildCommentAdf,
  buildDescriptionAdf,
  computeBackoffMs,
  JiraClient,
  type JiraRawResponse,
  type JiraRunner,
  matchTransition,
  parseRetryAfter,
  redactAuth,
  type JiraTransition,
} from "../src/daemon/jira.js";

/** Build a runner from a scripted list of responses; records every request. */
function scriptRunner(
  responses: JiraRawResponse[],
): { runner: JiraRunner; calls: { method: string; path: string; body?: unknown }[] } {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  let i = 0;
  const runner: JiraRunner = async (req) => {
    calls.push(req);
    const res = responses[Math.min(i, responses.length - 1)];
    i++;
    return res;
  };
  return { runner, calls };
}

const ok = (status: number, body: unknown = {}): JiraRawResponse => ({
  status,
  headers: {},
  body: typeof body === "string" ? body : JSON.stringify(body),
});

const noSleep = async () => {};

describe("redactAuth", () => {
  it("scrubs Basic credentials and authorization header values", () => {
    expect(redactAuth("Authorization: Basic YWJjOnNlY3JldA==")).not.toContain("YWJjOnNlY3JldA==");
    expect(redactAuth("failed with Basic Zm9vOmJhcg==")).toContain("[REDACTED_SECRET]");
    expect(redactAuth('{"headers":{"Authorization":"Basic dG9rOjEyMw=="}}')).not.toContain("dG9rOjEyMw==");
  });
});

describe("createIssue", () => {
  it("sends Basic-auth-free typed body and returns the new key", async () => {
    const { runner, calls } = scriptRunner([ok(201, { key: "EN-42" })]);
    const client = new JiraClient({ runner, sleep: noSleep });
    const res = await client.createIssue({
      project: "EN",
      issueType: "Task",
      summary: "hello",
      description: buildDescriptionAdf("do the thing", "https://gh/pr/1", 7),
      labels: ["commandcenter"],
    });
    expect(res.key).toBe("EN-42");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].path).toBe("/rest/api/3/issue");
    const body = calls[0].body as { fields: Record<string, unknown> };
    expect(body.fields.project).toEqual({ key: "EN" });
    expect(body.fields.issuetype).toEqual({ name: "Task" });
    // The runner (not the client) owns auth — no header ever appears in the body.
    expect(JSON.stringify(body)).not.toMatch(/authorization/i);
  });

  it("truncates the summary to JIRA's 255-char limit", async () => {
    const { runner, calls } = scriptRunner([ok(201, { key: "EN-1" })]);
    const client = new JiraClient({ runner, sleep: noSleep });
    await client.createIssue({
      project: "EN",
      issueType: "Task",
      summary: "x".repeat(400),
      description: {},
      labels: [],
    });
    const body = calls[0].body as { fields: { summary: string } };
    expect(body.fields.summary.length).toBe(255);
  });

  it("sets assignee only when an accountId is provided", async () => {
    const { runner, calls } = scriptRunner([ok(201, { key: "EN-1" }), ok(201, { key: "EN-2" })]);
    const client = new JiraClient({ runner, sleep: noSleep });
    await client.createIssue({ project: "EN", issueType: "Task", summary: "a", description: {}, labels: [] });
    expect((calls[0].body as { fields: Record<string, unknown> }).fields.assignee).toBeUndefined();
    await client.createIssue({ project: "EN", issueType: "Task", summary: "a", description: {}, labels: [], assigneeAccountId: "acc-1" });
    expect((calls[1].body as { fields: { assignee: unknown } }).fields.assignee).toEqual({ accountId: "acc-1" });
  });

  it("throws a redacted error on non-2xx without leaking auth", async () => {
    const { runner } = scriptRunner([ok(400, "bad issuetype; Authorization: Basic Zm9vOmJhcg==")]);
    const client = new JiraClient({ runner, sleep: noSleep });
    await expect(
      client.createIssue({ project: "EN", issueType: "Nope", summary: "a", description: {}, labels: [] }),
    ).rejects.toThrow(/HTTP 400/);
    await client
      .createIssue({ project: "EN", issueType: "Nope", summary: "a", description: {}, labels: [] })
      .catch((e: Error) => expect(e.message).not.toContain("Zm9vOmJhcg=="));
  });
});

describe("getIssue", () => {
  it("parses status name (lowercased) + category + assignee", async () => {
    const { runner, calls } = scriptRunner([
      ok(200, {
        fields: {
          status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
          assignee: { accountId: "acc-9" },
        },
      }),
    ]);
    const client = new JiraClient({ runner, sleep: noSleep });
    const view = await client.getIssue("EN-5");
    expect(view).toEqual({ state: "in progress", category: "indeterminate", assigneeAccountId: "acc-9" });
    expect(calls[0].path).toBe("/rest/api/3/issue/EN-5?fields=status,assignee");
  });

  it("tolerates a null assignee", async () => {
    const { runner } = scriptRunner([
      ok(200, { fields: { status: { name: "Done", statusCategory: { key: "done" } }, assignee: null } }),
    ]);
    const client = new JiraClient({ runner, sleep: noSleep });
    expect((await client.getIssue("EN-6")).assigneeAccountId).toBeNull();
  });
});

describe("transition resolution + retry/backoff", () => {
  const TRANSITIONS: JiraTransition[] = [
    { id: "41", name: "Development started", to: { name: "In Progress", category: "indeterminate" } },
    { id: "251", name: "Done", to: { name: "Done", category: "done" } },
  ];

  it("matchTransition resolves by TARGET STATUS name, not transition name (never hardcoded ids)", () => {
    expect(matchTransition(TRANSITIONS, "In Progress")?.id).toBe("41");
    expect(matchTransition(TRANSITIONS, "in progress")?.id).toBe("41"); // case-insensitive
    expect(matchTransition(TRANSITIONS, "Done")?.id).toBe("251");
    expect(matchTransition(TRANSITIONS, "Merged")).toBeUndefined(); // not reachable
  });

  it("getTransitions maps the raw JIRA shape", async () => {
    const { runner } = scriptRunner([
      ok(200, {
        transitions: [
          { id: "41", name: "Development started", to: { name: "In Progress", statusCategory: { key: "indeterminate" } } },
        ],
      }),
    ]);
    const client = new JiraClient({ runner, sleep: noSleep });
    const ts = await client.getTransitions("EN-1");
    expect(ts[0]).toEqual({ id: "41", name: "Development started", to: { name: "In Progress", category: "indeterminate" } });
  });

  it("retries on 429 honoring Retry-After, then succeeds", async () => {
    const responses: JiraRawResponse[] = [
      { status: 429, headers: { "retry-after": "2" }, body: "" },
      { status: 429, headers: {}, body: "" },
      ok(204),
    ];
    const sleeps: number[] = [];
    const { runner, calls } = scriptRunner(responses);
    const client = new JiraClient({
      runner,
      sleep: async (ms) => void sleeps.push(ms),
      jitter: () => 0,
      maxRetries: 4,
    });
    await client.transitionIssue("EN-1", "251");
    expect(calls.length).toBe(3); // two failures + one success
    expect(sleeps[0]).toBe(2000); // honored Retry-After: 2s
    expect(sleeps[1]).toBe(1000); // backoff base*2^1 with zero jitter
  });

  it("retries on 5xx and gives up after maxRetries, surfacing a redacted error", async () => {
    const { runner, calls } = scriptRunner([{ status: 503, headers: {}, body: "upstream down" }]);
    const client = new JiraClient({ runner, sleep: noSleep, jitter: () => 0, maxRetries: 2 });
    await expect(client.transitionIssue("EN-1", "1")).rejects.toThrow(/HTTP 503/);
    expect(calls.length).toBe(3); // initial + 2 retries
  });

  it("does NOT retry a non-429 4xx — it's a real failure", async () => {
    const { runner, calls } = scriptRunner([ok(403, "forbidden")]);
    const client = new JiraClient({ runner, sleep: noSleep });
    await expect(client.getTransitions("EN-1")).rejects.toThrow(/HTTP 403/);
    expect(calls.length).toBe(1); // no retry
  });
});

describe("backoff helpers", () => {
  it("parseRetryAfter reads numeric seconds, rejects HTTP-date", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter("Wed, 21 Oct 2025 07:28:00 GMT")).toBeNull();
  });

  it("computeBackoffMs prefers Retry-After, else capped exponential + jitter", () => {
    expect(computeBackoffMs(0, "5", () => 0)).toBe(5000);
    expect(computeBackoffMs(0, undefined, () => 0)).toBe(500);
    expect(computeBackoffMs(1, undefined, () => 0)).toBe(1000);
    expect(computeBackoffMs(2, undefined, () => 100)).toBe(2100);
    // capped
    expect(computeBackoffMs(20, undefined, () => 0)).toBe(30_000);
  });
});

describe("ADF builders", () => {
  it("description carries prompt, linked PR, and task id", () => {
    const adf = buildDescriptionAdf("build X", "https://gh/pr/9", 12) as {
      content: { content: { text?: string; marks?: unknown[] }[] }[];
    };
    const flat = JSON.stringify(adf);
    expect(flat).toContain("build X");
    expect(flat).toContain("https://gh/pr/9");
    expect(flat).toContain("commandcenter task #12");
    // PR paragraph carries a link mark.
    expect(flat).toContain('"link"');
  });

  it("description falls back to a placeholder when prompt is blank (JIRA rejects empty text nodes)", () => {
    const adf = buildDescriptionAdf("   ", "", 1);
    expect(JSON.stringify(adf)).toContain("(no description)");
  });

  it("comment is a single-paragraph ADF doc", () => {
    expect(buildCommentAdf("hi")).toEqual({
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
    });
  });
});
