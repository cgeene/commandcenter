import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-transcript-"));
  process.env.CC_CLAUDE_PROJECTS = tmpDir;
});

afterEach(() => {
  delete process.env.CC_CLAUDE_PROJECTS;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("transcript reader", () => {
  it("finds and simplifies a session transcript", async () => {
    const projDir = path.join(tmpDir, "-Users-x-repo");
    fs.mkdirSync(projDir);
    const sid = "abc12345-0000-0000-0000-000000000000";
    const lines = [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "fix the bug" },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Looking at the code." },
            { type: "tool_use", name: "Read", input: { file_path: "/a.ts" } },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", content: "file contents..." }],
        },
      }),
      "not json at all",
      JSON.stringify({ type: "summary", summary: "meta row" }),
    ];
    fs.writeFileSync(path.join(projDir, `${sid}.jsonl`), lines.join("\n"));

    const { readTranscript } = await import("../src/daemon/transcript.js");
    const entries = readTranscript(sid)!;
    expect(entries).toEqual([
      { role: "user", text: "fix the bug" },
      { role: "assistant", text: "Looking at the code." },
      { role: "tool", text: 'Read({"file_path":"/a.ts"})' },
    ]);
  });

  it("returns undefined for unknown sessions", async () => {
    const { readTranscript } = await import("../src/daemon/transcript.js");
    expect(readTranscript("ffffffff-1111")).toBeUndefined();
  });
});
