import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;
let projectsDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-tokens-"));
  projectsDir = path.join(tmpDir, "projects");
  fs.mkdirSync(projectsDir);
  process.env.CC_DATA_DIR = tmpDir;
  process.env.CC_CLAUDE_PROJECTS = projectsDir;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  delete process.env.CC_CLAUDE_PROJECTS;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const SID = "aaaa1111-0000-0000-0000-000000000000";

function writeTranscript(turns: { out: number; inp: number }[]) {
  const dir = path.join(projectsDir, "-x-repo");
  fs.mkdirSync(dir, { recursive: true });
  const lines = turns.map((t) =>
    JSON.stringify({
      type: "assistant",
      message: {
        usage: {
          input_tokens: t.inp,
          output_tokens: t.out,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 50,
        },
      },
    }),
  );
  lines.push(JSON.stringify({ type: "user", message: { content: "hi" } }));
  fs.writeFileSync(path.join(dir, `${SID}.jsonl`), lines.join("\n"));
}

describe("sessionTokens", () => {
  it("sums usage across assistant turns", async () => {
    writeTranscript([
      { inp: 1000, out: 200 },
      { inp: 2000, out: 300 },
    ]);
    const { sessionTokens } = await import("../src/daemon/transcript.js");
    const t = sessionTokens(SID)!;
    expect(t.input).toBe(3000);
    expect(t.output).toBe(500);
    expect(t.cache_read).toBe(200);
    expect(t.cache_creation).toBe(100);
    expect(t.total).toBe(3800);
  });

  it("Stop hook records tokens on the worker's task", async () => {
    writeTranscript([{ inp: 500, out: 100 }]);
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { createTask, updateTask, getTask } = await import("../src/db/tasks.js");
    const { createAgent } = await import("../src/db/agents.js");
    const task = createTask({ title: "t", prompt: "x", repo: "/r" });
    const worker = createAgent({ kind: "worker", state: "working", task_id: task.id });
    updateTask(task.id, { status: "in_progress", agent_id: worker.id });
    await handleHookEvent(worker.id, { hook_event_name: "Stop", session_id: SID });
    expect(getTask(task.id)?.tokens_used).toBe(750);
  });
});

describe("resume prompt", () => {
  it("re-anchors without repeating the task and carries outstanding feedback", async () => {
    const { _buildResumePromptForTest } = await import("../src/daemon/spawn.js");
    const { createTask, updateTask, getTask } = await import("../src/db/tasks.js");
    const task = createTask({ title: "fix retry", prompt: "the full original prompt", repo: "/r" });
    updateTask(task.id, { review_notes: "handle the empty-input case" });
    const p = _buildResumePromptForTest(getTask(task.id)!);
    expect(p).toContain("resumed");
    expect(p).toContain("empty-input case");
    expect(p).not.toContain("the full original prompt"); // resume keeps context; no repeat
  });
});
