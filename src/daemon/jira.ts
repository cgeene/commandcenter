import { randomInt } from "node:crypto";
import { jiraBaseUrl, jiraEmail, jiraToken } from "../config.js";

/**
 * Thin JIRA Cloud REST v3 client. Deterministic daemon code owns ALL JIRA sync
 * (agents never call the JIRA API), so this is the single place HTTP happens.
 *
 * Two invariants baked in here:
 *  - Auth is Basic `email:api_token` from env ONLY (config.ts). The token never
 *    reaches the DB, events, or logs.
 *  - Redaction: any error thrown from here is scrubbed of the Authorization
 *    header / Basic credential so a surfaced sync error can't leak the token.
 *
 * Testability follows prdraft.ts's `_setGhRunner` seam: the low-level request
 * runner is injectable, so client tests never touch the network.
 */

/** A JIRA status as the daemon caches it: the human-facing name plus the
 *  workflow-independent category (new | indeterminate | done). */
export interface JiraStatus {
  name: string;
  category: string;
}

/** Result of GET /issue/{key}?fields=status,assignee. */
export interface JiraIssueView {
  state: string; // status name, lowercased (mirrors pr_state style)
  category: string; // status category key: new | indeterminate | done
  assigneeAccountId: string | null;
}

/** A transition offered from the issue's CURRENT status. `to` is where it
 *  lands — matched by target status name at runtime (IDs are workflow-specific
 *  and must never be hardcoded). */
export interface JiraTransition {
  id: string;
  name: string;
  to: { name: string; category: string };
}

/** Fields for POST /issue. project/issuetype resolved by KEY/NAME (never id). */
export interface CreateIssueInput {
  project: string; // project key, e.g. "EN"
  issueType: string; // type name, e.g. "Task"
  summary: string;
  description: unknown; // ADF doc
  labels: string[];
  assigneeAccountId?: string;
}

export interface JiraRawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Low-level request seam. The default implementation (below) attaches Basic
 *  auth and calls fetch; tests swap in a fake. A runner NEVER throws on a
 *  non-2xx status — it returns the response and lets the typed methods decide. */
export type JiraRunner = (req: {
  method: string;
  path: string;
  body?: unknown;
}) => Promise<JiraRawResponse>;

export type Sleeper = (ms: number) => Promise<void>;

const API = "/rest/api/3";

/** JIRA summary hard limit. */
const SUMMARY_MAX = 255;

/** Retryable-status backoff: base doubles per attempt, capped. */
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 30_000;
const DEFAULT_MAX_RETRIES = 4;

/** Strip any Basic credential / Authorization header value out of a string so a
 *  surfaced error can never carry the token. Defensive: the default runner
 *  keeps auth in headers and never echoes them, but a wrapped fetch/DNS error
 *  might, and callers stringify these into events. */
export function redactAuth(s: string): string {
  return s
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED_SECRET]")
    .replace(/(authorization"?\s*[:=]\s*"?)[^\s",}]+/gi, "$1[REDACTED_SECRET]");
}

function truncateSummary(s: string): string {
  return s.length > SUMMARY_MAX ? s.slice(0, SUMMARY_MAX) : s;
}

/** Retry only on 429 (rate limit) and 5xx (transient server). Any other 4xx is
 *  a real, non-retryable failure (bad request, perms, unknown transition). */
function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/** How long to wait before the next attempt. Honors an explicit `Retry-After`
 *  (seconds) from JIRA; otherwise capped exponential backoff with jitter drawn
 *  from the OS CSPRNG (crypto.randomInt — never Math.random, per crypto rules).
 *  Pure except for the jitter source, which is injectable for deterministic
 *  tests. */
export function computeBackoffMs(
  attempt: number,
  retryAfterHeader: string | undefined,
  jitter: () => number = () => randomInt(0, 250),
): number {
  const retryAfter = parseRetryAfter(retryAfterHeader);
  if (retryAfter !== null) return retryAfter;
  const base = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);
  return base + jitter();
}

/** Parse a numeric `Retry-After` seconds value into ms. Non-numeric (HTTP-date)
 *  or absent → null (fall back to backoff). */
export function parseRetryAfter(header: string | undefined): number | null {
  if (!header) return null;
  const secs = Number(header.trim());
  return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : null;
}

/** Find the transition that lands on `targetStatus` (matched by the destination
 *  status name, case-insensitive) — the runtime resolution that replaces
 *  hardcoded transition IDs. undefined when the target isn't reachable from the
 *  issue's current status. */
export function matchTransition(
  transitions: JiraTransition[],
  targetStatus: string,
): JiraTransition | undefined {
  const want = targetStatus.trim().toLowerCase();
  return transitions.find((t) => t.to.name.trim().toLowerCase() === want);
}

const realSleep: Sleeper = (ms) => new Promise((r) => setTimeout(r, ms));

/** Default runner: Basic auth from env, JSON, no throw on non-2xx. Assumes the
 *  caller has already confirmed a token exists (startJiraSync fail-closes when
 *  it doesn't). */
function defaultRunner(base: string): JiraRunner {
  return async (req) => {
    const email = jiraEmail();
    const token = jiraToken();
    if (!email || !token) {
      throw new Error("JIRA not configured (missing CC_JIRA_EMAIL/CC_JIRA_TOKEN)");
    }
    const auth = Buffer.from(`${email}:${token}`).toString("base64");
    const res = await fetch(base + req.path, {
      method: req.method,
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
        ...(req.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    return { status: res.status, headers, body: await res.text() };
  };
}

export interface JiraClientOptions {
  runner?: JiraRunner;
  sleep?: Sleeper;
  maxRetries?: number;
  /** Injectable jitter for deterministic backoff tests. */
  jitter?: () => number;
}

export class JiraClient {
  private runner: JiraRunner;
  private sleep: Sleeper;
  private maxRetries: number;
  private jitter: () => number;

  constructor(opts: JiraClientOptions = {}) {
    this.runner = opts.runner ?? defaultRunner(jiraBaseUrl());
    this.sleep = opts.sleep ?? realSleep;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.jitter = opts.jitter ?? (() => randomInt(0, 250));
  }

  /** Perform a request with retry/backoff on 429/5xx. Returns the response
   *  (2xx or the final non-retryable / retry-exhausted one); typed methods
   *  interpret the status. Never leaks auth in a thrown error. */
  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<JiraRawResponse> {
    let last: JiraRawResponse | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let res: JiraRawResponse;
      try {
        res = await this.runner({ method, path, body });
      } catch (err) {
        throw new Error(
          redactAuth(err instanceof Error ? err.message : String(err)),
        );
      }
      last = res;
      if (!isRetryable(res.status) || attempt === this.maxRetries) return res;
      await this.sleep(
        computeBackoffMs(attempt, res.headers["retry-after"], this.jitter),
      );
    }
    // Unreachable (loop always returns), but satisfies the type checker.
    return last!;
  }

  /** Turn a non-2xx response into a redacted Error. Body is included (it carries
   *  JIRA's error message) but never the request headers. */
  private fail(op: string, res: JiraRawResponse): Error {
    const snippet = res.body ? `: ${res.body.slice(0, 500)}` : "";
    return new Error(redactAuth(`JIRA ${op} failed (HTTP ${res.status})${snippet}`));
  }

  /** POST /issue. Returns the new issue key. */
  async createIssue(input: CreateIssueInput): Promise<{ key: string }> {
    const fields: Record<string, unknown> = {
      project: { key: input.project },
      issuetype: { name: input.issueType },
      summary: truncateSummary(input.summary),
      description: input.description,
      labels: input.labels,
    };
    if (input.assigneeAccountId) {
      fields.assignee = { accountId: input.assigneeAccountId };
    }
    const res = await this.request("POST", `${API}/issue`, { fields });
    if (res.status !== 201 && res.status !== 200) throw this.fail("create issue", res);
    const key = (JSON.parse(res.body) as { key?: string }).key;
    if (!key) throw new Error("JIRA create issue returned no key");
    return { key };
  }

  /** GET /issue/{key}?fields=status,assignee. */
  async getIssue(key: string): Promise<JiraIssueView> {
    const res = await this.request(
      "GET",
      `${API}/issue/${encodeURIComponent(key)}?fields=status,assignee`,
    );
    if (res.status !== 200) throw this.fail(`get issue ${key}`, res);
    const parsed = JSON.parse(res.body) as {
      fields?: {
        status?: { name?: string; statusCategory?: { key?: string } };
        assignee?: { accountId?: string } | null;
      };
    };
    const status = parsed.fields?.status;
    return {
      state: (status?.name ?? "").toLowerCase(),
      category: status?.statusCategory?.key ?? "",
      assigneeAccountId: parsed.fields?.assignee?.accountId ?? null,
    };
  }

  /** GET /issue/{key}/transitions — the transitions offered from the current
   *  status. Used to resolve a target status name to a transition id at runtime. */
  async getTransitions(key: string): Promise<JiraTransition[]> {
    const res = await this.request(
      "GET",
      `${API}/issue/${encodeURIComponent(key)}/transitions`,
    );
    if (res.status !== 200) throw this.fail(`get transitions ${key}`, res);
    const parsed = JSON.parse(res.body) as {
      transitions?: {
        id?: string;
        name?: string;
        to?: { name?: string; statusCategory?: { key?: string } };
      }[];
    };
    return (parsed.transitions ?? []).map((t) => ({
      id: t.id ?? "",
      name: t.name ?? "",
      to: {
        name: t.to?.name ?? "",
        category: t.to?.statusCategory?.key ?? "",
      },
    }));
  }

  /** POST /issue/{key}/transitions. */
  async transitionIssue(key: string, transitionId: string): Promise<void> {
    const res = await this.request(
      "POST",
      `${API}/issue/${encodeURIComponent(key)}/transitions`,
      { transition: { id: transitionId } },
    );
    if (res.status !== 204 && res.status !== 200) {
      throw this.fail(`transition issue ${key}`, res);
    }
  }

  /** POST /issue/{key}/comment. `body` is an ADF doc. */
  async addComment(key: string, body: unknown): Promise<void> {
    const res = await this.request(
      "POST",
      `${API}/issue/${encodeURIComponent(key)}/comment`,
      { body },
    );
    if (res.status !== 201 && res.status !== 200) {
      throw this.fail(`comment issue ${key}`, res);
    }
  }
}

/** Minimal ADF (Atlassian Document Format) doc for a ticket description:
 *  the task prompt, a linked PR URL, and the commandcenter task id. */
export function buildDescriptionAdf(
  prompt: string,
  prUrl: string,
  taskId: number,
): unknown {
  const content: unknown[] = [
    {
      type: "paragraph",
      content: [{ type: "text", text: prompt.trim() || "(no description)" }],
    },
  ];
  if (prUrl) {
    content.push({
      type: "paragraph",
      content: [
        { type: "text", text: "PR: " },
        {
          type: "text",
          text: prUrl,
          marks: [{ type: "link", attrs: { href: prUrl } }],
        },
      ],
    });
  }
  content.push({
    type: "paragraph",
    content: [{ type: "text", text: `commandcenter task #${taskId}` }],
  });
  return { type: "doc", version: 1, content };
}

/** Minimal ADF doc for a plain-text comment. */
export function buildCommentAdf(text: string): unknown {
  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}
