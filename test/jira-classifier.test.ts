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
  it("extracts a well-formed JSON object", () => {
    expect(parseClassifierOutput('{"project":"EN","issue_type":"Bug"}')).toEqual({
      project: "EN",
      issue_type: "Bug",
    });
  });

  it("extracts JSON embedded in surrounding prose", () => {
    const raw = 'Here is my choice:\n{"project": "UN", "issue_type": "Story"}\nThanks!';
    expect(parseClassifierOutput(raw)).toEqual({ project: "UN", issue_type: "Story" });
  });

  it("returns null on invalid JSON", () => {
    expect(parseClassifierOutput("not json at all")).toBeNull();
    expect(parseClassifierOutput('{"project": "EN", }')).toBeNull();
  });

  it("returns null when required fields are missing or non-string", () => {
    expect(parseClassifierOutput('{"project":"EN"}')).toBeNull();
    expect(parseClassifierOutput('{"project":1,"issue_type":"Task"}')).toBeNull();
    expect(parseClassifierOutput('{"project":"","issue_type":"Task"}')).toBeNull();
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

  it("uses a validated classifier proposal when it is inside the allow-list", async () => {
    _setClassifierRunner(async () => '{"project":"UN","issue_type":"Bug"}');
    const { resolveCreateTarget } = await import("../src/daemon/jirasync.js");
    const task = await makeTask();
    const repoCfg = { enabled: true, project: "EN", projects: ["EN", "UN"], issue_types: ["Task", "Bug"] };
    const res = await resolveCreateTarget(task, repoCfg, { enabled: true, repos: {}, classifier_model: "sonnet" });
    expect(res).toEqual({ project: "UN", issueType: "Bug" });
  });

  it("falls back to repo default + Task when the classifier picks out-of-list values", async () => {
    _setClassifierRunner(async () => '{"project":"ZZZ","issue_type":"Epic"}');
    const { resolveCreateTarget } = await import("../src/daemon/jirasync.js");
    const task = await makeTask();
    const repoCfg = { enabled: true, project: "EN", projects: ["EN", "UN"], issue_types: ["Task", "Bug"] };
    const res = await resolveCreateTarget(task, repoCfg, { enabled: true, repos: {}, classifier_model: "sonnet" });
    expect(res).toEqual({ project: "EN", issueType: "Task" });
  });

  it("falls back to defaults when the classifier times out", async () => {
    _setClassifierRunner(async () => {
      throw new Error("timeout");
    });
    const { resolveCreateTarget } = await import("../src/daemon/jirasync.js");
    const task = await makeTask();
    const repoCfg = { enabled: true, project: "EN", projects: ["EN", "UN"], issue_types: ["Task", "Bug"] };
    const res = await resolveCreateTarget(task, repoCfg, { enabled: true, repos: {}, classifier_model: "sonnet" });
    expect(res).toEqual({ project: "EN", issueType: "Task" });
  });

  it("a per-task jira_project override wins over the classifier proposal", async () => {
    _setClassifierRunner(async () => '{"project":"UN","issue_type":"Bug"}');
    const { resolveCreateTarget } = await import("../src/daemon/jirasync.js");
    const task = await makeTask({ jira_project: "TW" });
    const repoCfg = { enabled: true, project: "EN", projects: ["EN", "UN"], issue_types: ["Task", "Bug"] };
    const res = await resolveCreateTarget(task, repoCfg, { enabled: true, repos: {}, classifier_model: "sonnet" });
    // Project forced to the override; issue type still comes from the classifier.
    expect(res).toEqual({ project: "TW", issueType: "Bug" });
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
