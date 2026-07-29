import { describe, expect, it } from "vitest";
import { detectTransientApiError } from "../src/daemon/stall.js";

const PROMPT_BOX = [
  "╭──────────────────────────────────────────────────────────╮",
  "│ >                                                          │",
  "╰──────────────────────────────────────────────────────────╯",
  "  ? for shortcuts",
].join("\n");

describe("detectTransientApiError", () => {
  /** A pane whose last content line is `lines`, capped by a clear prompt box. */
  const pane = (...lines: string[]) => [...lines, "", PROMPT_BOX].join("\n");

  // One table, driving two independent things: POSITION (only an error the
  // agent stopped on counts — that is ANCHOR_RE plus the kept-working check) and
  // the SIGNATURE keywords. The positive rows below are NOT interchangeable:
  // each one is the only coverage of a distinct SIGNATURE_RE alternative, so
  // dropping one lets that alternative be deleted with the suite still green.
  // A false positive silently nudges a worker that is fine; a false negative
  // leaves a stalled worker unattended with no auto-nudge.
  it("matches only a transient error the agent actually stopped on", () => {
    for (const { why, input, match } of [
      {
        why: "a 529 overloaded error at the end of the pane",
        input: pane(
          "⏺ Update(src/foo.ts)",
          "  ⎿  Updated 3 lines",
          "",
          '⏺ API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
        ),
        match: /Overloaded|overloaded_error/,
      },
      {
        // the `Internal server error` alternative
        why: "a 500 internal server error",
        input: pane(
          "⏺ Bash(npm test)",
          "  ⎿  running...",
          "",
          '⏺ API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
        ),
        match: /Internal server error/,
      },
      {
        // the `rate.?limit` alternative — losing this means a rate-limited
        // worker stalls unattended instead of being auto-nudged
        why: "a 429 rate limit error",
        input: pane(
          "⏺ Reading config",
          "",
          '⏺ API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limit exceeded"}}',
        ),
        match: /rate.?limit/i,
      },
      {
        why: "a connection dropped mid-response",
        input: pane(
          "⏺ Read(src/daemon/review.ts)",
          "  ⎿  Read 200 lines",
          "",
          "⏺ API Error: Connection closed mid-response",
        ),
        match: /Connection closed/,
      },
      {
        why: "a wrapped continuation line folded into the match",
        input: pane(
          '⏺ API Error: 529 {"type":"error","error":{"type":"overloaded_',
          'error","message":"Overloaded"}}',
        ),
        match: /Overloaded/,
      },
      {
        why: "NOT an API error the worker merely quotes in prose",
        input: pane(
          "⏺ I hit a transient error earlier — the log showed",
          '  "API Error: 529 Overloaded" — but a retry succeeded and tests pass.',
          "",
          "⏺ Bash(npm test)",
          "  ⎿  All tests passed",
        ),
        match: null,
      },
      {
        why: "NOT an error the agent kept working past",
        input: pane(
          '⏺ API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
          "",
          "⏺ Retrying the failed step now.",
          "",
          "⏺ Bash(npm test)",
          "  ⎿  All tests passed",
        ),
        match: null,
      },
      {
        why: "NOT a line with other words between the bullet and `API Error:`",
        input: pane(
          "⏺ Just to note, the API Error: Server error happened once during setup",
          "  but is now resolved and the task is complete.",
        ),
        match: null,
      },
      {
        why: "NOT a non-transient API error (400 bad request)",
        input: pane(
          '⏺ API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"bad request"}}',
        ),
        match: null,
      },
      {
        why: "a terminal Codex transport failure, including its wrapped detail",
        input:
          "working output\n\n■ stream disconnected before completion:\nconnection closed",
        match: /stream disconnected.*connection closed/i,
      },
      {
        why: "NOT quoted Codex error prose",
        input: "The test fixture contains: ■ stream disconnected before completion",
        match: null,
      },
    ] as const) {
      const got = detectTransientApiError(input);
      if (match === null) {
        expect(got, why).toBeNull();
        continue;
      }
      // Assert detection separately from the matched text: a dropped
      // SIGNATURE_RE alternative returns null, and `toMatch` on null reports an
      // unhelpful type error instead of "this signature is no longer detected".
      expect(got, `${why}: expected a detected error, got none`).not.toBeNull();
      expect(got, why).toMatch(match);
    }
  });
});
