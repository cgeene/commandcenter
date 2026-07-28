/**
 * Pure helpers for the web terminal's mobile "compose bar".
 *
 * xterm.js forwards every keystroke to the pty the instant it happens, through
 * a hidden textarea with autocorrect/autocapitalize/spellcheck switched off —
 * it has to be, since a character already written to the pty can't be retracted
 * when autocorrect rewrites the word behind it. The cost is that on a phone the
 * terminal loses every native keyboard feature: autocorrect, double-space for a
 * period, predictive text, dictation.
 *
 * The compose bar sidesteps that: the operator types into an ordinary text
 * field with all of those features left ON, and the finished text is shipped to
 * the pty as ONE write. These helpers turn that buffer into the bytes to send.
 *
 * Kept free of any DB/node/web imports so both the node test suite and the
 * (separately built) web bundle can import it.
 */

import { SHIFT_ENTER_NEWLINE } from "./terminal-keys.js";

/** localStorage key for the per-browser "show the compose bar" preference. */
export const COMPOSE_BAR_KEY = "cc:term-compose";

/**
 * Whether the terminal drawer shows the compose bar, per the stored preference.
 * Unset (never toggled) defaults to `touchDefault` — the bar appears on phones
 * and tablets, where the native keyboard is the point, and desktops are left
 * exactly as they were. An explicit "0"/"1" always wins, so either kind of
 * device can opt the other way.
 */
export function composeBarEnabled(
  store: Pick<Storage, "getItem">,
  touchDefault: boolean,
): boolean {
  const stored = store.getItem(COMPOSE_BAR_KEY);
  return stored === null ? touchDefault : stored === "1";
}

/** Persist the on/off preference read by {@link composeBarEnabled}. */
export function setComposeBarEnabled(store: Pick<Storage, "setItem">, on: boolean): void {
  store.setItem(COMPOSE_BAR_KEY, on ? "1" : "0");
}

/**
 * Whether this looks like a touch device, i.e. one whose keyboard is virtual.
 *
 * A coarse PRIMARY pointer is the signal, and when the browser answers that
 * question its answer is final — a touchscreen laptop driven by a mouse reports
 * a fine pointer and must be treated as a desktop, even though it has touch
 * points. `maxTouchPoints` is consulted only when the media query is
 * unavailable, which is what `coarsePointer: null` means. Both are passed in
 * rather than read here so this stays testable outside a browser.
 */
export function isTouchLike(coarsePointer: boolean | null, maxTouchPoints: number): boolean {
  return coarsePointer === null ? maxTouchPoints > 0 : coarsePointer;
}

/**
 * Normalize a compose buffer into text safe to hand a TUI: line endings folded
 * to "\n", tabs flattened to a space (a literal tab would trigger completion in
 * the target app rather than appearing as text), every other C0 control and DEL
 * dropped, and trailing blank lines removed — the send itself supplies the
 * final carriage return.
 */
export function sanitizeComposeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\n+$/, "");
}

/**
 * The exact bytes to write to the pty for a composed message, or null when the
 * buffer is empty — a bare Enter is the key bar's job, not the compose bar's.
 * Whitespace IS sendable: the key bar has no space key, so the compose bar is
 * the only way to type one, and swallowing it would lose text the operator
 * explicitly sent.
 *
 * Embedded newlines become ESC+CR (meta-return), the same sequence Shift+Enter
 * injects, so a multi-line message lands as multiple lines in a Claude Code
 * composer instead of submitting once per line. `submit` appends the trailing
 * CR: true for "send it", false for filling a prompt without answering it.
 */
export function composePayload(text: string, submit: boolean): string | null {
  const cleaned = sanitizeComposeText(text);
  if (cleaned === "") return null;
  return cleaned.split("\n").join(SHIFT_ENTER_NEWLINE) + (submit ? "\r" : "");
}
