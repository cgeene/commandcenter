import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-transcript-"));
  process.env.CC_CLAUDE_PROJECTS = tmpDir;
  process.env.CC_CODEX_HOME = path.join(tmpDir, "codex");
});

afterEach(() => {
  delete process.env.CC_CLAUDE_PROJECTS;
  delete process.env.CC_CODEX_HOME;
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

  it("defensively parses Codex messages and tool calls while skipping unknown rows", async () => {
    const sid = "cccc3333-0000-0000-0000-000000000000";
    const sessions = path.join(process.env.CC_CODEX_HOME!, "sessions", "2026", "07", "12");
    fs.mkdirSync(sessions, { recursive: true });
    const file = path.join(sessions, `rollout-${sid}.jsonl`);
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: "session_meta", payload: { id: sid } }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "fix the retry" }],
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "I found the race." }],
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call",
            namespace: "functions",
            name: "exec_command",
            arguments: '{"cmd":"npm test","api_key":"must-not-leak"}',
          },
        }),
        JSON.stringify({ type: "future_record", payload: { format: "unknown" } }),
        "not json",
      ].join("\n"),
    );

    const { readProviderTranscript } = await import("../src/daemon/transcript.js");
    expect(readProviderTranscript("codex", sid, file)).toEqual([
      { role: "user", text: "fix the retry" },
      { role: "assistant", text: "I found the race." },
      {
        role: "tool",
        text: 'functions.exec_command({"cmd":"npm test","api_key":"[REDACTED]"})',
      },
    ]);
  });

  it("reads the latest cumulative Codex token count", async () => {
    const sid = "dddd4444-0000-0000-0000-000000000000";
    const sessions = path.join(process.env.CC_CODEX_HOME!, "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    const file = path.join(sessions, `rollout-${sid}.jsonl`);
    const tokenRow = (input: number, output: number, reasoning: number) =>
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: input,
              cached_input_tokens: 100,
              output_tokens: output,
              reasoning_output_tokens: reasoning,
              total_tokens: input + output + reasoning,
            },
          },
        },
      });
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: "session_meta", payload: { session_id: sid } }),
        tokenRow(500, 50, 10),
        tokenRow(900, 80, 20),
      ].join("\n"),
    );

    const { providerSessionTokens } = await import("../src/daemon/transcript.js");
    expect(providerSessionTokens("codex", sid, file)).toEqual({
      input: 900,
      output: 100,
      cache_read: 100,
      cache_creation: 0,
      total: 1000,
    });
  });

  it("rejects a hook-supplied Codex transcript outside the isolated sessions tree", async () => {
    const sid = "eeee5555-0000-0000-0000-000000000000";
    const outside = path.join(tmpDir, `outside-${sid}.jsonl`);
    fs.writeFileSync(
      outside,
      JSON.stringify({ type: "session_meta", payload: { id: sid } }),
    );
    fs.mkdirSync(path.join(process.env.CC_CODEX_HOME!, "sessions"), { recursive: true });
    const { findCodexTranscript } = await import("../src/daemon/transcript.js");
    expect(findCodexTranscript(sid, outside)).toBeUndefined();
  });
});
