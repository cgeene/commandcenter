import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildClassifierPrompt,
  classifyTicket,
  parseClassifierOutput,
  _setClassifierRunner,
} from "../src/daemon/jiraclassify.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-jira-cls-")));
  process.env.CC_DATA_DIR = path.join(tmpDir, "data");
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  _setClassifierRunner(null);
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const input = {
  title: "Add rate limiting",
  prompt: "Add a token bucket to the API gateway",
  repo: "/repo",
  projects: ["EN", "UN"],
  issueTypes: ["Task", "Story", "Bug"],
  model: "sonnet",
};

describe("parseClassifierOutput", () => {
  // A pure parser: one row per input shape. It must never hand a half-formed
  // proposal downstream, so every rejection case is kept.
  it("extracts a complete proposal, or nothing", () => {
    for (const { why, raw, out } of [
      { why: "a well-formed JSON object", raw: '{"project":"EN","issue_type":"Bug"}', out: { project: "EN", issue_type: "Bug" } },
      {
        why: "JSON embedded in surrounding prose",
        raw: 'Here is my choice:\n{"project": "UN", "issue_type": "Story"}\nThanks!',
        out: { project: "UN", issue_type: "Story" },
      },
      { why: "not JSON at all", raw: "not json at all", out: null },
      { why: "malformed JSON", raw: '{"project": "EN", }', out: null },
      { why: "a missing required field", raw: '{"project":"EN"}', out: null },
      { why: "a non-string field", raw: '{"project":1,"issue_type":"Task"}', out: null },
      { why: "an empty-string field", raw: '{"project":"","issue_type":"Task"}', out: null },
    ] as const) {
      expect(parseClassifierOutput(raw), why).toEqual(out);
    }
  });
});

describe("classifyTicket", () => {
  it("returns the parsed proposal on a clean model response", async () => {
    _setClassifierRunner(async () => '{"project":"UN","issue_type":"Bug"}');
    expect(await classifyTicket(input)).toEqual({ project: "UN", issue_type: "Bug" });
  });

  it("returns null on a model timeout / crash (runner throws)", async () => {
    _setClassifierRunner(async () => {
      throw new Error("timed out");
    });
    expect(await classifyTicket(input)).toBeNull();
  });

  it("returns null on invalid JSON output", async () => {
    _setClassifierRunner(async () => "I think this should be a Task.");
    expect(await classifyTicket(input)).toBeNull();
  });

  it("the prompt carries the allow-lists so the model can only pick valid values", () => {
    const p = buildClassifierPrompt(input);
    expect(p).toContain('["EN","UN"]');
    expect(p).toContain('["Task","Story","Bug"]');
    expect(p).toContain("Add rate limiting");
  });
});

describe("resolveCreateTarget (LLM proposes, daemon disposes)", () => {
  async function makeTask(overrides: Record<string, unknown> = {}) {
    const { createTask, updateTask, getTask } = await import("../src/db/tasks.js");
    const t = createTask({ title: "t", prompt: "p", repo: "/repo" });
    if (Object.keys(overrides).length) updateTask(t.id, overrides as never);
    return getTask(t.id)!;
  }

  /**
   * One table for the disposal policy: the classifier only ever PROPOSES, and
   * these rows are every way the daemon can overrule it. All four run the same
   * resolveCreateTarget call against the same allow-lists; only what the model
   * returns (or throws) and the task's own override vary. `classifierCalled`
   * pins the one case that must not consult the model at all.
   */
  const ALLOW_LISTS = {
    enabled: true,
    project: "EN",
    projects: ["EN", "UN"],
    issue_types: ["Task", "Bug"],
  };
  const DISPOSAL_CASES = [
    {
      why: "a proposal inside the allow-list is used as-is",
      runner: async () => '{"project":"UN","issue_type":"Bug"}',
      expected: { project: "UN", issueType: "Bug" },
    },
    {
      why: "out-of-list values are overruled with repo default + Task",
      runner: async () => '{"project":"ZZZ","issue_type":"Epic"}',
      expected: { project: "EN", issueType: "Task" },
    },
    {
      why: "a classifier that times out falls back to repo default + Task",
      runner: async () => {
        throw new Error("timeout");
      },
      expected: { project: "EN", issueType: "Task" },
    },
    {
      why: "a per-task jira_project override wins, but the issue type still comes from the model",
      runner: async () => '{"project":"UN","issue_type":"Bug"}',
      overrides: { jira_project: "TW" },
      expected: { project: "TW", issueType: "Bug" },
    },
  ] as const;

  it("uses a proposal only where it is valid, and overrules it everywhere else", async () => {
    const { resolveCreateTarget } = await import("../src/daemon/jirasync.js");
    for (const c of DISPOSAL_CASES) {
      let called = false;
      _setClassifierRunner(async (...args) => {
        called = true;
        return c.runner(...(args as []));
      });
      const task = await makeTask("overrides" in c ? c.overrides : {});
      const res = await resolveCreateTarget(task, { ...ALLOW_LISTS }, {
        enabled: true,
        repos: {},
        classifier_model: "sonnet",
      });
      expect(res, c.why).toEqual(c.expected);
      // Every row above has a real choice to make, so the model must be asked.
      expect(called, c.why).toBe(true);
    }
  });

  it("skips the classifier entirely when both allow-lists are singletons", async () => {
    let called = false;
    _setClassifierRunner(async () => {
      called = true;
      return '{"project":"EN","issue_type":"Task"}';
    });
    const { resolveCreateTarget } = await import("../src/daemon/jirasync.js");
    const task = await makeTask();
    const repoCfg = { enabled: true, project: "EN" }; // no allow-lists → singletons
    const res = await resolveCreateTarget(task, repoCfg, { enabled: true, repos: {}, classifier_model: "sonnet" });
    expect(res).toEqual({ project: "EN", issueType: "Task" });
    expect(called).toBe(false);
  });
});
