import { describe, expect, it, vi } from "vitest";
import {
  handleTerminalKeyEvent,
  shiftEnterNewline,
  SHIFT_ENTER_NEWLINE,
  type CancelableKeyEvent,
} from "../src/lib/terminal-keys.js";

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

/** A fake KeyboardEvent that records preventDefault/stopPropagation calls,
 *  standing in for the DOM event xterm passes to the custom handler. */
function fakeEvent(over: Partial<CancelableKeyEvent>): CancelableKeyEvent & {
  defaultPrevented: boolean;
  propagationStopped: boolean;
} {
  const e = {
    type: "keydown",
    key: "Enter",
    shiftKey: false,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      e.defaultPrevented = true;
    },
    stopPropagation() {
      e.propagationStopped = true;
    },
    ...over,
  };
  return e;
}

describe("handleTerminalKeyEvent", () => {
  it("on Shift+Enter: sends exactly one ESC+CR, cancels the event, returns false", () => {
    const send = vi.fn();
    const e = fakeEvent({ type: "keydown", key: "Enter", shiftKey: true });

    const ret = handleTerminalKeyEvent(e, send);

    expect(ret).toBe(false); // xterm skips its own keydown handling
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("\x1b\r");
    // preventDefault is the crux: it cancels the follow-on keypress so xterm's
    // _keyPress can't ALSO emit "\r" and submit.
    expect(e.defaultPrevented).toBe(true);
    expect(e.propagationStopped).toBe(true);
  });

  it("on plain Enter: sends nothing, does NOT cancel, returns true so xterm submits", () => {
    const send = vi.fn();
    const e = fakeEvent({ type: "keydown", key: "Enter", shiftKey: false });

    const ret = handleTerminalKeyEvent(e, send);

    expect(ret).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false); // browser keypress fires -> xterm emits "\r"
  });

  it("on a non-Enter key: passes through untouched", () => {
    const send = vi.fn();
    const e = fakeEvent({ type: "keydown", key: "a", shiftKey: false });

    expect(handleTerminalKeyEvent(e, send)).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  // Simulate the browser keydown -> keypress chain the way xterm reacts to it,
  // to prove end-to-end that Shift+Enter yields exactly one ESC+CR and no "\r".
  // Model of xterm's relevant behavior:
  //   - keydown runs the custom handler; if it returns false, xterm does NOT
  //     emit for keydown.
  //   - a keypress fires ONLY if the keydown's default was not prevented, and
  //     xterm's _keyPress emits "\r" for Enter.
  function simulateEnterPress(shiftKey: boolean): string[] {
    const wire: string[] = [];
    const send = (d: string) => wire.push(d);

    const keydown = fakeEvent({ type: "keydown", key: "Enter", shiftKey });
    const handled = handleTerminalKeyEvent(keydown, send);

    // xterm's own keydown emission for Enter happens only when the custom
    // handler let it through (returned true) and default wasn't prevented.
    if (handled && !keydown.defaultPrevented) wire.push("\r");

    // The browser dispatches keypress only if keydown's default stands.
    if (!keydown.defaultPrevented) {
      // xterm's _keyPress emits "\r" for Enter (guarded elsewhere by
      // _keyDownHandled, which our custom-handler-returns-false path leaves
      // false — exactly the bug preventDefault closes).
      wire.push("\r");
    }
    return wire;
  }

  it("Shift+Enter yields exactly one ESC+CR on the wire and no trailing CR", () => {
    expect(simulateEnterPress(true)).toEqual(["\x1b\r"]);
  });

  it("plain Enter still reaches the pty as a submit (CR present)", () => {
    expect(simulateEnterPress(false)).toContain("\r");
  });
});
