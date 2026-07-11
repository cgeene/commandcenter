/**
 * Pure, dependency-free key handling for the web terminal, so the interception
 * logic can be unit-tested in node even though xterm/DOM only exist in the web
 * bundle. Kept free of any DB/node/web imports.
 */

/**
 * Sequence to inject for Shift+Enter so a worker's Claude Code prompt gets a
 * NEWLINE instead of submitting. ESC then CR is "meta-return" in Ink (the TUI
 * framework Claude Code uses), bound to "insert newline" regardless of cursor
 * position. Verified against a real `claude` session inside tmux (task #53):
 * backslash+CR also inserts a newline but is position-sensitive (only continues
 * at end of line, otherwise leaves a literal `\`), and CSI-u `\x1b[13;2u`
 * depends on kitty-protocol negotiation surviving tmux — meta-return is the
 * robust pick. Plain Enter is deliberately NOT matched here, so it still emits
 * `\r` and submits.
 */
export const SHIFT_ENTER_NEWLINE = "\x1b\r";

/** The subset of a KeyboardEvent the terminal needs to classify a keypress. */
export interface KeyEventLike {
  type: string;
  key: string;
  shiftKey: boolean;
}

/**
 * Decide what a key event means for the terminal. Returns the sequence to
 * inject for a Shift+Enter keydown (a newline), or null to let xterm handle the
 * key normally — including plain Enter, which must keep submitting.
 */
export function shiftEnterNewline(e: KeyEventLike): string | null {
  if (e.type === "keydown" && e.key === "Enter" && e.shiftKey) {
    return SHIFT_ENTER_NEWLINE;
  }
  return null;
}

/** A KeyboardEvent as far as the terminal's key handler cares: classification
 *  fields plus the two cancellation methods. A real DOM KeyboardEvent satisfies
 *  this structurally. */
export interface CancelableKeyEvent extends KeyEventLike {
  preventDefault(): void;
  stopPropagation(): void;
}

/**
 * The body of xterm's `attachCustomKeyEventHandler`. Returns the boolean xterm
 * expects: `true` to let xterm process the key normally, `false` to suppress
 * xterm's own handling.
 *
 * For Shift+Enter we send the newline sequence via `send` and return false — but
 * returning false is NOT enough on its own. In xterm.js a custom handler that
 * returns false makes xterm skip its keydown handling WITHOUT calling
 * preventDefault, so the browser still fires the follow-on `keypress`, and
 * xterm's internal `_keyPress` then emits "\r" — Claude Code would insert our
 * newline AND immediately submit. So we call `preventDefault()` (which cancels
 * that keypress) and `stopPropagation()` before returning false. Result:
 * exactly one ESC+CR reaches the pty, no trailing "\r".
 *
 * Every other key (including plain Enter) returns true untouched, so xterm still
 * emits "\r" and submits.
 */
export function handleTerminalKeyEvent(
  e: CancelableKeyEvent,
  send: (data: string) => void,
): boolean {
  const seq = shiftEnterNewline(e);
  if (seq === null) return true;
  e.preventDefault();
  e.stopPropagation();
  send(seq);
  return false;
}
