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
  it("defaults to on for touch devices and off for everything else", () => {
    expect(composeBarEnabled(fakeStore(), true)).toBe(true);
    expect(composeBarEnabled(fakeStore(), false)).toBe(false);
  });

  it("lets a stored choice override the device default in both directions", () => {
    expect(composeBarEnabled(fakeStore({ [COMPOSE_BAR_KEY]: "0" }), true)).toBe(false);
    expect(composeBarEnabled(fakeStore({ [COMPOSE_BAR_KEY]: "1" }), false)).toBe(true);
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
  it("treats a coarse pointer as touch", () => {
    expect(isTouchLike(true, 0)).toBe(true);
  });

  it("trusts a reported fine pointer over the touch-point count", () => {
    // A touchscreen laptop driven by a mouse: it has touch points, but its
    // primary pointer is fine, so it's a desktop and gets no compose bar.
    expect(isTouchLike(false, 10)).toBe(false);
  });

  it("falls back to touch points only when the pointer query is unavailable", () => {
    expect(isTouchLike(null, 5)).toBe(true);
    expect(isTouchLike(null, 0)).toBe(false);
  });

  it("is false for a plain mouse-driven desktop", () => {
    expect(isTouchLike(false, 0)).toBe(false);
  });
});

describe("sanitizeComposeText", () => {
  it("folds CRLF and bare CR to newlines", () => {
    expect(sanitizeComposeText("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("flattens tabs to spaces so they don't trigger completion in the TUI", () => {
    expect(sanitizeComposeText("a\tb")).toBe("a b");
  });

  it("drops control characters that would be read as escape sequences", () => {
    expect(sanitizeComposeText("a\x1b[Ab\x00c\x7f")).toBe("a[Abc");
  });

  it("trims trailing blank lines, which the send's own CR replaces", () => {
    expect(sanitizeComposeText("hello\n\n\n")).toBe("hello");
  });

  it("leaves ordinary punctuation and unicode alone", () => {
    // What double-space-for-a-period and dictation actually produce.
    expect(sanitizeComposeText("Ship it. Then tell me — ok? ✅")).toBe(
      "Ship it. Then tell me — ok? ✅",
    );
  });
});

describe("composePayload", () => {
  it("sends the text plus a carriage return when submitting", () => {
    expect(composePayload("deploy it", true)).toBe("deploy it\r");
  });

  it("omits the carriage return when submit is off", () => {
    // Filling a worker's composer without answering the prompt.
    expect(composePayload("deploy it", false)).toBe("deploy it");
  });

  it("joins multiple lines with meta-return so none of them submit early", () => {
    expect(composePayload("one\ntwo", true)).toBe(`one${SHIFT_ENTER_NEWLINE}two\r`);
    expect(SHIFT_ENTER_NEWLINE).not.toBe("\r");
  });

  it("returns null for an empty buffer", () => {
    expect(composePayload("", true)).toBeNull();
    expect(composePayload("\n\n", true)).toBeNull();
  });

  it("still sends a whitespace-only buffer — the key bar has no space key", () => {
    expect(composePayload("  ", true)).toBe("  \r");
  });

  it("emits exactly one trailing CR even when the buffer ends in newlines", () => {
    const payload = composePayload("done\n\n", true);
    expect(payload).toBe("done\r");
    expect(payload!.match(/\r/g)).toHaveLength(1);
  });
});
