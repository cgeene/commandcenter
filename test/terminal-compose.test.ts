import { describe, expect, it } from "vitest";
import {
  COMPOSE_BAR_KEY,
  composeBarEnabled,
  composePayload,
  isTouchLike,
  sanitizeComposeText,
  setComposeBarEnabled,
} from "../src/lib/terminal-compose.js";
import { SHIFT_ENTER_NEWLINE } from "../src/lib/terminal-keys.js";

/** A localStorage stand-in for the preference helpers. */
function fakeStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    read: (k: string) => data.get(k) ?? null,
  };
}

describe("composeBarEnabled", () => {
  // Pure preference resolution: one row per (stored value, device default).
  it("prefers a stored choice and otherwise follows the device", () => {
    for (const { why, stored, touch, on } of [
      { why: "no stored choice on a touch device", stored: undefined, touch: true, on: true },
      { why: "no stored choice on a desktop", stored: undefined, touch: false, on: false },
      { why: "stored off overrides a touch device", stored: "0", touch: true, on: false },
      { why: "stored on overrides a desktop", stored: "1", touch: false, on: true },
    ]) {
      const store = fakeStore(stored === undefined ? {} : { [COMPOSE_BAR_KEY]: stored });
      expect(composeBarEnabled(store, touch), why).toBe(on);
    }
  });

  it("round-trips through setComposeBarEnabled", () => {
    const store = fakeStore();
    setComposeBarEnabled(store, true);
    expect(composeBarEnabled(store, false)).toBe(true);
    setComposeBarEnabled(store, false);
    expect(composeBarEnabled(store, true)).toBe(false);
  });
});

describe("isTouchLike", () => {
  // A touchscreen laptop driven by a mouse has touch points but a fine primary
  // pointer: it is a desktop and gets no compose bar. The touch-point count is
  // only consulted when the pointer query is unavailable.
  it("trusts the primary pointer, falling back to touch points only when unknown", () => {
    for (const { why, coarse, points, touch } of [
      { why: "a coarse pointer", coarse: true, points: 0, touch: true },
      { why: "a fine pointer despite touch points", coarse: false, points: 10, touch: false },
      { why: "no pointer query, with touch points", coarse: null, points: 5, touch: true },
      { why: "no pointer query, no touch points", coarse: null, points: 0, touch: false },
      { why: "a plain mouse-driven desktop", coarse: false, points: 0, touch: false },
    ] as const) {
      expect(isTouchLike(coarse, points), why).toBe(touch);
    }
  });
});

describe("sanitizeComposeText", () => {
  // Everything the TUI would misread if it reached the pane verbatim.
  it("strips what the terminal would misinterpret and leaves the rest alone", () => {
    for (const { why, input, out } of [
      { why: "CRLF and bare CR fold to newlines", input: "a\r\nb\rc", out: "a\nb\nc" },
      { why: "tabs flatten to spaces (they trigger TUI completion)", input: "a\tb", out: "a b" },
      { why: "control characters that would read as escape sequences", input: "a\x1b[Ab\x00c\x7f", out: "a[Abc" },
      { why: "trailing blank lines, which the send's own CR replaces", input: "hello\n\n\n", out: "hello" },
      // What double-space-for-a-period and dictation actually produce.
      {
        why: "ordinary punctuation and unicode are untouched",
        input: "Ship it. Then tell me — ok? ✅",
        out: "Ship it. Then tell me — ok? ✅",
      },
    ]) {
      expect(sanitizeComposeText(input), why).toBe(out);
    }
  });
});

describe("composePayload", () => {
  // The submit contract: a trailing CR iff submitting, and never more than one,
  // with interior newlines sent as meta-return so none of them submit early.
  it("builds the exact keystroke payload for each buffer", () => {
    for (const { why, buffer, submit, out, singleCr } of [
      { why: "text with submit on", buffer: "deploy it", submit: true, out: "deploy it\r", singleCr: false },
      // Filling a worker's composer without answering the prompt.
      { why: "text with submit off", buffer: "deploy it", submit: false, out: "deploy it", singleCr: false },
      {
        why: "multiple lines joined with meta-return",
        buffer: "one\ntwo",
        submit: true,
        out: `one${SHIFT_ENTER_NEWLINE}two\r`,
        singleCr: false,
      },
      { why: "an empty buffer", buffer: "", submit: true, out: null, singleCr: false },
      { why: "a newline-only buffer", buffer: "\n\n", submit: true, out: null, singleCr: false },
      // The key bar has no space key, so whitespace is a real message.
      { why: "a whitespace-only buffer", buffer: "  ", submit: true, out: "  \r", singleCr: false },
      { why: "a buffer ending in newlines gets exactly one CR", buffer: "done\n\n", submit: true, out: "done\r", singleCr: true },
    ]) {
      const payload = composePayload(buffer, submit);
      expect(payload, why).toBe(out);
      // Only meaningful where the buffer itself ended in newlines: the
      // meta-return used to join interior lines legitimately carries its own CR.
      if (singleCr) {
        expect(payload!.match(/\r/g), why).toHaveLength(1);
      }
    }
    expect(SHIFT_ENTER_NEWLINE).not.toBe("\r"); // else the join would submit
  });
});
