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
