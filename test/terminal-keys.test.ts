import { describe, expect, it, vi } from "vitest";
import {
  handleTerminalKeyEvent,
  shiftEnterNewline,
  SHIFT_ENTER_NEWLINE,
  type CancelableKeyEvent,
} from "../src/lib/terminal-keys.js";

describe("shiftEnterNewline", () => {
  // Only a Shift+Enter KEYDOWN injects. xterm's handler fires for keyup too, and
  // injecting on both would send the newline twice; plain Enter must fall through
  // so xterm still submits.
  it("injects only on a Shift+Enter keydown", () => {
    for (const { why, event, out } of [
      { why: "Shift+Enter keydown", event: { type: "keydown", key: "Enter", shiftKey: true }, out: SHIFT_ENTER_NEWLINE },
      { why: "plain Enter keydown (left to xterm)", event: { type: "keydown", key: "Enter", shiftKey: false }, out: null },
      { why: "the keyup half of a Shift+Enter press", event: { type: "keyup", key: "Enter", shiftKey: true }, out: null },
      { why: "Shift+A", event: { type: "keydown", key: "A", shiftKey: true }, out: null },
      { why: "Shift+Tab", event: { type: "keydown", key: "Tab", shiftKey: true }, out: null },
    ] as const) {
      expect(shiftEnterNewline(event), why).toBe(out);
    }
  });

  it("uses ESC+CR (meta-return), not a bare CR that would submit", () => {
    expect(SHIFT_ENTER_NEWLINE).toBe("\x1b\r");
    expect(SHIFT_ENTER_NEWLINE).not.toBe("\r");
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
  // One table: the handler's whole dispatch decision for a keydown. Only
  // Shift+Enter may inject and cancel; every other key must pass through
  // untouched so xterm keeps its normal submit behaviour. `prevented` is the
  // crux of the Shift+Enter row — it cancels the follow-on keypress so xterm's
  // _keyPress cannot ALSO emit "\r" and submit.
  const DISPATCH_CASES = [
    {
      why: "Shift+Enter injects exactly one ESC+CR, cancels the event, and returns false",
      key: "Enter",
      shiftKey: true,
      returns: false, // xterm skips its own keydown handling
      sent: "\x1b\r",
      prevented: true,
      propagationStopped: true,
    },
    {
      why: "plain Enter sends nothing and is left to xterm to submit",
      key: "Enter",
      shiftKey: false,
      returns: true,
      sent: null,
      prevented: false, // browser keypress fires -> xterm emits "\r"
      propagationStopped: false,
    },
    {
      why: "a non-Enter key passes through untouched",
      key: "a",
      shiftKey: false,
      returns: true,
      sent: null,
      prevented: false,
      propagationStopped: false,
    },
  ] as const;

  it("injects only for Shift+Enter and leaves every other keydown to xterm", () => {
    for (const c of DISPATCH_CASES) {
      const send = vi.fn();
      const e = fakeEvent({ type: "keydown", key: c.key, shiftKey: c.shiftKey });

      expect(handleTerminalKeyEvent(e, send), c.why).toBe(c.returns);
      if (c.sent === null) {
        expect(send, c.why).not.toHaveBeenCalled();
      } else {
        expect(send, c.why).toHaveBeenCalledTimes(1);
        expect(send, c.why).toHaveBeenCalledWith(c.sent);
      }
      expect(e.defaultPrevented, c.why).toBe(c.prevented);
      expect(e.propagationStopped, c.why).toBe(c.propagationStopped);
    }
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
