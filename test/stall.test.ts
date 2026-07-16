import { describe, expect, it } from "vitest";
import { detectTransientApiError } from "../src/daemon/stall.js";

const PROMPT_BOX = [
  "╭──────────────────────────────────────────────────────────╮",
  "│ >                                                          │",
  "╰──────────────────────────────────────────────────────────╯",
  "  ? for shortcuts",
].join("\n");

describe("detectTransientApiError", () => {
  it("matches a 529 overloaded error sitting at the end of the pane", () => {
    const pane = [
      "⏺ Update(src/foo.ts)",
      "  ⎿  Updated 3 lines",
      "",
      '⏺ API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      "",
      PROMPT_BOX,
    ].join("\n");
    expect(detectTransientApiError(pane)).toMatch(/Overloaded|overloaded_error/);
  });

  it("matches a 500 internal server error", () => {
    const pane = [
      "⏺ Bash(npm test)",
      "  ⎿  running...",
      "",
      '⏺ API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
      "",
      PROMPT_BOX,
    ].join("\n");
    expect(detectTransientApiError(pane)).toMatch(/Internal server error/);
  });

  it("matches a 429 rate limit error", () => {
    const pane = [
      "⏺ Reading config",
      "",
      '⏺ API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limit exceeded"}}',
      "",
      PROMPT_BOX,
    ].join("\n");
    expect(detectTransientApiError(pane)).toMatch(/rate.?limit/i);
  });

  it("folds a wrapped continuation line into the match", () => {
    const pane = [
      '⏺ API Error: 529 {"type":"error","error":{"type":"overloaded_',
      'error","message":"Overloaded"}}',
      "",
      PROMPT_BOX,
    ].join("\n");
    expect(detectTransientApiError(pane)).toMatch(/Overloaded/);
  });

  it("does NOT match when the worker merely quotes an API error in prose", () => {
    const pane = [
      "⏺ I hit a transient error earlier — the log showed",
      '  "API Error: 529 Overloaded" — but a retry succeeded and tests pass.',
      "",
      "⏺ Bash(npm test)",
      "  ⎿  All tests passed",
      "",
      PROMPT_BOX,
    ].join("\n");
    expect(detectTransientApiError(pane)).toBeNull();
  });

  it("does NOT match when the agent kept working after the error line", () => {
    const pane = [
      '⏺ API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      "",
      "⏺ Retrying the failed step now.",
      "",
      "⏺ Bash(npm test)",
      "  ⎿  All tests passed",
      "",
      PROMPT_BOX,
    ].join("\n");
    expect(detectTransientApiError(pane)).toBeNull();
  });

  it("does NOT match a line where other words sit between the bullet and API Error:", () => {
    const pane = [
      "⏺ Just to note, the API Error: Server error happened once during setup",
      "  but is now resolved and the task is complete.",
      "",
      PROMPT_BOX,
    ].join("\n");
    expect(detectTransientApiError(pane)).toBeNull();
  });

  it("does NOT match ordinary completion output with no error at all", () => {
    const pane = [
      "⏺ Ran the test suite — all green.",
      "  ⎿  42 passed, 0 failed",
      "",
      PROMPT_BOX,
    ].join("\n");
    expect(detectTransientApiError(pane)).toBeNull();
  });

  it("does NOT match a non-transient API error (e.g. 400 bad request)", () => {
    const pane = [
      '⏺ API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"bad request"}}',
      "",
      PROMPT_BOX,
    ].join("\n");
    expect(detectTransientApiError(pane)).toBeNull();
  });

  it("returns null on an empty pane", () => {
    expect(detectTransientApiError("")).toBeNull();
  });

  it("detects a terminal Codex transport failure including wrapped detail", () => {
    expect(
      detectTransientApiError(
        "working output\n\n■ stream disconnected before completion:\nconnection closed",
      ),
    ).toMatch(/stream disconnected.*connection closed/i);
  });

  it("does not treat quoted Codex error prose as a terminal transport failure", () => {
    expect(
      detectTransientApiError(
        "The test fixture contains: ■ stream disconnected before completion",
      ),
    ).toBeNull();
  });
});
