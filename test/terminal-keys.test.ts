import { describe, expect, it } from "vitest";
import { shiftEnterNewline, SHIFT_ENTER_NEWLINE } from "../src/lib/terminal-keys.js";

describe("shiftEnterNewline", () => {
  it("returns the newline sequence for a Shift+Enter keydown", () => {
    expect(shiftEnterNewline({ type: "keydown", key: "Enter", shiftKey: true })).toBe(
      SHIFT_ENTER_NEWLINE,
    );
  });

  it("uses ESC+CR (meta-return), not a bare CR that would submit", () => {
    expect(SHIFT_ENTER_NEWLINE).toBe("\x1b\r");
    expect(SHIFT_ENTER_NEWLINE).not.toBe("\r");
  });

  it("leaves plain Enter to xterm so it still submits", () => {
    expect(shiftEnterNewline({ type: "keydown", key: "Enter", shiftKey: false })).toBeNull();
  });

  it("ignores the keyup half of a Shift+Enter press (only keydown injects)", () => {
    // xterm's handler fires for both keydown and keyup; injecting on both would
    // send the newline twice.
    expect(shiftEnterNewline({ type: "keyup", key: "Enter", shiftKey: true })).toBeNull();
  });

  it("ignores other Shift-modified keys", () => {
    expect(shiftEnterNewline({ type: "keydown", key: "A", shiftKey: true })).toBeNull();
    expect(shiftEnterNewline({ type: "keydown", key: "Tab", shiftKey: true })).toBeNull();
  });
});
