import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMPACT_TASK_FIELDS,
  PUBLICATION_FIELDS,
  RESULT_SUMMARY_LIMIT,
  TASK_ROW_FIELDS,
  TRUNCATION_MARKER,
  compactTask,
  echoedFields,
  projectTask,
  shapeTask,
  shapeTaskList,
  shapeTaskPayload,
  taskRow,
  truncateSummary,
} from "../src/mcp/compact.js";

// The MCP entrypoint is a script: it builds a server, registers tools, and
// connects a stdio transport at import time. Mocking the SDK lets us capture
// the real tool handlers and drive them against a stubbed daemon.
const { registered } = vi.hoisted(() => ({
  registered: new Map<
    string,
    { config: { description?: string; inputSchema?: Record<string, unknown> }; handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }
  >(),
}));

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    registerTool(
      name: string,
      config: { description?: string; inputSchema?: Record<string, unknown> },
      handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }>,
    ) {
      registered.set(name, { config, handler });
    }
    async connect() {}
  },
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {},
}));

interface FakeTask extends Record<string, unknown> {
  id: number;
}

/** A task row with every column the daemon actually returns today. */
function fullTask(over: Partial<FakeTask> = {}): FakeTask {
  return {
    id: 42,
    title: "Terse MCP responses",
    prompt: "P".repeat(3000),
    repo: "/repos/commandcenter",
    workspace_kind: "repo",
    dispatch_mode: "orchestrated",
    parent_task_id: null,
    status: "review",
    priority: 2,
    worker_provider: "claude",
    model: "claude-opus-5",
    reasoning_effort: null,
    blocked_by: null,
    agent_id: 7,
    worktree: "/worktrees/commandcenter-task-42",
    branch: "agent/task-42",
    session_id: "sess-abc",
    session_provider: "claude",
    verify_cmd: "npm test",
    result_summary: "S".repeat(1200),
    review_verdict: "approve",
    review_notes: "N".repeat(2500),
    review_cycles: 1,
    review_mode: "full",
    review_head_sha: "deadbeef",
    review_result_hash: "cafebabe",
    pr_url: "https://github.com/o/r/pull/9",
    pr_feedback_at: null,
    pr_state: "open",
    pr_checks: "pass",
    pr_is_draft: 1,
    human_approved_at: null,
    pr_synced_at: "2026-07-27T10:00:00.000Z",
    pr_sync_fails: 0,
    jira_key: "EN-1234",
    jira_state: "in progress",
    jira_status_category: "indeterminate",
    jira_synced_at: null,
    jira_sync_fails: 0,
    jira_project: "EN",
    open_pr: 1,
    auto_review: 1,
    publication_mode: "human",
    publication_state: "published",
    review_snapshot_base: "1111111",
    review_snapshot_tree: "2222222",
    tokens_used: 120_000,
    cron_id: null,
    created_at: "2026-07-27T09:00:00.000Z",
    updated_at: "2026-07-27T11:00:00.000Z",
    ...over,
  };
}

const OMITTED_BY_DEFAULT = [
  "prompt",
  "review_notes",
  "review_result_hash",
  "review_head_sha",
  "jira_key",
  "jira_state",
  "jira_status_category",
  "jira_synced_at",
  "jira_sync_fails",
  "jira_project",
  "worktree",
  "session_id",
  "publication_mode",
  "publication_state",
  "review_snapshot_base",
  "review_snapshot_tree",
];

describe("task projections", () => {
  it("compactTask keeps exactly the compact field set", () => {
    expect(Object.keys(compactTask(fullTask()) as object)).toEqual([...COMPACT_TASK_FIELDS]);
  });

  it("compactTask drops the prompt, review notes, and jira columns", () => {
    const out = compactTask(fullTask()) as Record<string, unknown>;
    for (const key of OMITTED_BY_DEFAULT) expect(out).not.toHaveProperty(key);
  });

  it("compactTask truncates result_summary and marks it", () => {
    const out = compactTask(fullTask()) as Record<string, unknown>;
    const summary = out.result_summary as string;
    expect(summary).toHaveLength(RESULT_SUMMARY_LIMIT + TRUNCATION_MARKER.length);
    expect(summary.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(summary.startsWith("S".repeat(RESULT_SUMMARY_LIMIT))).toBe(true);
  });

  it("leaves a short result_summary and a null one alone", () => {
    expect(truncateSummary("done")).toBe("done");
    expect(truncateSummary("x".repeat(RESULT_SUMMARY_LIMIT))).toHaveLength(RESULT_SUMMARY_LIMIT);
    expect(truncateSummary(null)).toBeNull();
    expect((compactTask(fullTask({ result_summary: null })) as Record<string, unknown>).result_summary).toBeNull();
  });

  it("compactTask appends explicitly requested extra fields", () => {
    const out = compactTask(fullTask(), PUBLICATION_FIELDS) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual([...COMPACT_TASK_FIELDS, ...PUBLICATION_FIELDS]);
    expect(out.publication_state).toBe("published");
    expect(out).not.toHaveProperty("review_snapshot_tree");
  });

  it("keeps the fields triage must preserve when it re-dispatches a task", () => {
    const out = compactTask(fullTask()) as Record<string, unknown>;
    // effort and review depth are set at creation/triage; losing them to
    // compaction means silently re-creating a task with different settings
    expect(out).toHaveProperty("worker_provider");
    expect(out).toHaveProperty("reasoning_effort");
    expect(out).toHaveProperty("review_mode");
  });

  it("echoedFields keeps changed fields but drops the bulk", () => {
    expect(echoedFields(["verify_cmd", "review_mode"])).toEqual([
      "verify_cmd",
      "review_mode",
    ]);
    expect(echoedFields(["prompt", "review_notes"])).toEqual([]);
    expect(echoedFields(["prompt", "status"])).toEqual(["status"]);
  });

  it("is an allow-list: a column added later stays out until listed", () => {
    const out = compactTask(fullTask({ some_future_column: "x" })) as Record<string, unknown>;
    expect(out).not.toHaveProperty("some_future_column");
  });

  it("taskRow keeps only the list-row fields", () => {
    expect(Object.keys(taskRow(fullTask()) as object)).toEqual([...TASK_ROW_FIELDS]);
  });

  it("projectTask returns the requested fields plus id, dropping unknown names", () => {
    const out = projectTask(fullTask(), ["review_notes", "nonsense", "repo"]) as Record<
      string,
      unknown
    >;
    expect(Object.keys(out)).toEqual(["id", "review_notes", "repo"]);
    expect(out.review_notes).toHaveLength(2500);
  });

  it("projectTask does not duplicate an explicitly requested id", () => {
    expect(Object.keys(projectTask(fullTask(), ["id", "status"]) as object)).toEqual([
      "id",
      "status",
    ]);
  });

  it("shapeTask honors fields over verbose", () => {
    const out = shapeTask(fullTask(), { verbose: true, fields: ["status"] }) as Record<
      string,
      unknown
    >;
    expect(Object.keys(out)).toEqual(["id", "status"]);
  });

  it("shapeTask verbose returns the untouched record", () => {
    const task = fullTask();
    expect(shapeTask(task, { verbose: true })).toBe(task);
  });

  it("shapeTaskList maps rows by default and full records when verbose", () => {
    const tasks = [fullTask(), fullTask({ id: 43 })];
    expect(Object.keys((shapeTaskList(tasks) as object[])[0])).toEqual([...TASK_ROW_FIELDS]);
    expect(shapeTaskList(tasks, { verbose: true })).toBe(tasks);
    expect(Object.keys((shapeTaskList(tasks, { fields: ["repo"] }) as object[])[1])).toEqual([
      "id",
      "repo",
    ]);
  });

  it("shapeTaskPayload compacts the task and rows the dependents, leaving siblings alone", () => {
    const out = shapeTaskPayload({
      task: fullTask(),
      agent: { id: 7, kind: "worker", state: "working" },
      killed_agents: [7],
      open_dependents: [fullTask({ id: 43 })],
    }) as Record<string, unknown>;
    expect(Object.keys(out.task as object)).toEqual([...COMPACT_TASK_FIELDS]);
    expect(Object.keys((out.open_dependents as object[])[0])).toEqual([...TASK_ROW_FIELDS]);
    expect(out.agent).toEqual({ id: 7, kind: "worker", state: "working" });
    expect(out.killed_agents).toEqual([7]);
  });

  it("passes non-task values through unchanged", () => {
    expect(compactTask(null)).toBeNull();
    expect(taskRow("nope")).toBe("nope");
    expect(shapeTaskList({ error: "boom" })).toEqual({ error: "boom" });
    expect(shapeTaskPayload(null)).toBeNull();
  });
});

// ---- the tools themselves ----

interface FetchCall {
  method: string;
  path: string;
  body: unknown;
}

let fetchCalls: FetchCall[] = [];
let respond: (path: string, method: string) => unknown;

function stubFetch() {
  vi.stubGlobal("fetch", async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    const path = url.replace("http://127.0.0.1:4711", "");
    fetchCalls.push({
      method,
      path,
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    const payload = respond(path, method);
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => payload,
    };
  });
}

/** (Re-)import the MCP entrypoint under a given role and capture its tools. */
async function loadTools(role: string, taskId?: string) {
  registered.clear();
  vi.resetModules();
  vi.stubEnv("CC_ROLE", role);
  vi.stubEnv("CC_TASK_ID", taskId ?? "");
  vi.stubEnv("CC_AGENT_ID", "7");
  await import("../src/mcp/index.js");
  return registered;
}

async function callTool(name: string, args: unknown = {}) {
  const tool = registered.get(name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  const res = await tool.handler(args);
  return JSON.parse(res.content[0].text);
}

beforeEach(() => {
  fetchCalls = [];
  respond = () => fullTask();
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("main-role tools", () => {
  beforeEach(async () => {
    await loadTools("main");
  });

  it("get_task is compact by default", async () => {
    expect(Object.keys(await callTool("get_task", { id: 42 }))).toEqual([
      ...COMPACT_TASK_FIELDS,
    ]);
  });

  it("get_task verbose returns the full record including the prompt", async () => {
    const out = await callTool("get_task", { id: 42, verbose: true });
    expect(out.prompt).toHaveLength(3000);
    expect(out.result_summary).toHaveLength(1200);
    expect(out.review_notes).toHaveLength(2500);
  });

  it("get_task fields projects exactly", async () => {
    expect(Object.keys(await callTool("get_task", { id: 42, fields: ["prompt"] }))).toEqual([
      "id",
      "prompt",
    ]);
    // the escape hatch for anything left out of the compact core
    expect(await callTool("get_task", { id: 42, fields: ["publication_mode"] })).toEqual({
      id: 42,
      publication_mode: "human",
    });
  });

  it("list_tasks returns minimal rows by default and full records when verbose", async () => {
    respond = () => [fullTask(), fullTask({ id: 43 })];
    const rows = await callTool("list_tasks", { ready: true });
    expect(rows.map((r: { id: number }) => r.id)).toEqual([42, 43]);
    expect(Object.keys(rows[0])).toEqual([...TASK_ROW_FIELDS]);

    const verbose = await callTool("list_tasks", { verbose: true });
    expect(verbose[0].prompt).toHaveLength(3000);

    const projected = await callTool("list_tasks", { fields: ["status"] });
    expect(Object.keys(projected[0])).toEqual(["id", "status"]);
  });

  it("list_tasks still builds the same query string", async () => {
    await callTool("list_tasks", { status: "queued", dispatch_mode: "orchestrated" });
    expect(fetchCalls.at(-1)?.path).toBe("/api/tasks?status=queued&dispatch_mode=orchestrated");
  });

  it("update_task never echoes the bulk it was just handed", async () => {
    const out = await callTool("update_task", { id: 42, prompt: "a new prompt" });
    expect(Object.keys(out)).toEqual([...COMPACT_TASK_FIELDS]);
    expect(out).not.toHaveProperty("prompt");
    expect(fetchCalls.at(-1)).toMatchObject({
      method: "PATCH",
      path: "/api/tasks/42",
      body: { prompt: "a new prompt" },
    });
  });

  it("update_task appends a changed field that sits outside the compact core", async () => {
    const out = await callTool("update_task", { id: 42, verify_cmd: "npm run check" });
    expect(Object.keys(out)).toEqual([...COMPACT_TASK_FIELDS, "verify_cmd"]);
    expect(out.verify_cmd).toBe("npm test"); // echoed from the daemon's response
  });

  it("update_task appends only the non-bulky changed fields", async () => {
    const out = await callTool("update_task", {
      id: 42,
      prompt: "a new prompt",
      verify_cmd: "npm run check",
      priority: 1,
    });
    // priority is already in the core, so it is not appended twice
    expect(Object.keys(out)).toEqual([...COMPACT_TASK_FIELDS, "verify_cmd"]);
  });

  it("add_task echoes only the compact record", async () => {
    const out = await callTool("add_task", {
      title: "t",
      prompt: "p".repeat(500),
      repo: "/repos/commandcenter",
    });
    expect(Object.keys(out)).toEqual([...COMPACT_TASK_FIELDS]);
  });

  it("claim_task echoes only the compact record", async () => {
    expect(Object.keys(await callTool("claim_task", { id: 42 }))).toEqual([
      ...COMPACT_TASK_FIELDS,
    ]);
  });

  it("cancel_task compacts the task and rows its open dependents", async () => {
    respond = () => ({
      task: fullTask({ status: "cancelled" }),
      killed_agents: [7, 8],
      open_dependents: [fullTask({ id: 43 })],
    });
    const out = await callTool("cancel_task", { task_id: 42 });
    expect(Object.keys(out.task)).toEqual([...COMPACT_TASK_FIELDS]);
    expect(Object.keys(out.open_dependents[0])).toEqual([...TASK_ROW_FIELDS]);
    expect(out.killed_agents).toEqual([7, 8]);
  });

  it("spawn_worker compacts the task and returns the agent unchanged", async () => {
    const agent = { id: 9, kind: "worker", state: "spawning", window: "cc:task-42" };
    respond = () => ({ agent, task: fullTask() });
    const out = await callTool("spawn_worker", { task_id: 42 });
    expect(out.agent).toEqual(agent);
    expect(Object.keys(out.task)).toEqual([...COMPACT_TASK_FIELDS]);
  });

  it("spawn_reviewer compacts the task and returns the agent unchanged", async () => {
    const agent = { id: 10, kind: "reviewer", state: "spawning" };
    respond = () => ({ agent, task: fullTask() });
    const out = await callTool("spawn_reviewer", { task_id: 42 });
    expect(out.agent).toEqual(agent);
    expect(Object.keys(out.task)).toEqual([...COMPACT_TASK_FIELDS]);
  });

  it("cancel_task forwards discard_unpublished", async () => {
    respond = () => ({ task: fullTask(), killed_agents: [], open_dependents: [] });
    await callTool("cancel_task", { task_id: 42, rm_worktree: true, discard_unpublished: true });
    expect(fetchCalls.at(-1)?.body).toEqual({ rm_worktree: true, discard_unpublished: true });
  });

  it("confirm_human_publication echoes the compact record plus the publication state", async () => {
    const out = await callTool("confirm_human_publication", { task_id: 42 });
    expect(Object.keys(out)).toEqual([...COMPACT_TASK_FIELDS, ...PUBLICATION_FIELDS]);
    expect(out).not.toHaveProperty("review_snapshot_tree");
  });

  it("advertises verbose and fields on the read tools", () => {
    for (const name of ["get_task", "list_tasks"]) {
      const schema = registered.get(name)!.config.inputSchema!;
      expect(Object.keys(schema)).toEqual(expect.arrayContaining(["verbose", "fields"]));
    }
    expect(registered.get("get_task")!.config.description).toContain("verbose: true");
  });
});

describe("worker-role tools", () => {
  beforeEach(async () => {
    await loadTools("worker", "42");
  });

  it("get_my_task still returns the full record — the worker needs its prompt", async () => {
    const out = await callTool("get_my_task");
    expect(out.prompt).toHaveLength(3000);
  });

  it("update_my_task echoes only the compact record", async () => {
    const out = await callTool("update_my_task", { result_summary: "x".repeat(2000) });
    expect(Object.keys(out)).toEqual([...COMPACT_TASK_FIELDS]);
    expect(out.result_summary.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it("report_blocked echoes only the compact record", async () => {
    expect(Object.keys(await callTool("report_blocked", { reason: "no creds" }))).toEqual([
      ...COMPACT_TASK_FIELDS,
    ]);
    expect(fetchCalls.at(-1)?.body).toMatchObject({
      status: "blocked",
      result_summary: "BLOCKED: no creds",
    });
  });

  it("add_task defaults its repo from the worker's own task without echoing it", async () => {
    const out = await callTool("add_task", { title: "follow-up", prompt: "do the thing" });
    expect(fetchCalls[0]).toMatchObject({ method: "GET", path: "/api/tasks/42" });
    expect(fetchCalls.at(-1)?.body).toMatchObject({ repo: "/repos/commandcenter" });
    expect(Object.keys(out)).toEqual([...COMPACT_TASK_FIELDS]);
  });
});

describe("reviewer-role tools", () => {
  beforeEach(async () => {
    await loadTools("reviewer", "42");
  });

  it("submit_review echoes only the compact record", async () => {
    expect(
      Object.keys(await callTool("submit_review", { verdict: "approve", notes: "looks good" })),
    ).toEqual([...COMPACT_TASK_FIELDS]);
  });
});
