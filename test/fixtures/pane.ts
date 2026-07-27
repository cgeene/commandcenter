/**
 * Pane captures for tests that exercise the composer and the anti-clobber gate.
 *
 * Both forms below are transcribed byte-for-byte from `tmux capture-pane -p -e`
 * of the SAME live orchestrator pane (cc:@490, Claude Code 2.1.x, 2026-07-27) at
 * two different widths, because how the composer frame renders depends entirely
 * on pane width and the daemon has to read it at whatever width the pane happens
 * to be. Web-terminal viewers attach and detach, and tmux sizes the window to
 * its smallest client, so the width moves around during normal use.
 *
 * At 51 columns (`clearComposer`, `draftComposer`) the session label fills the
 * top border's row completely — zero rule glyphs on it — and the rules wrap onto
 * the next row; the bottom border wraps the same way:
 *
 *    " Manage Claude orchestrator task queue and workers"
 *    "──"
 *    "❯<NBSP>"
 *    "───────────────…───" (51)
 *    "──"
 *    "  ⏵⏵ accept edits on · ← for agents"
 *
 * At 131 columns (`wideClearComposer`, `wideDraftComposer`) the label sits
 * inside the top rule with a long run of glyphs before it, on one unwrapped row.
 * A parser that handles only the wide form reports "no composer" on the narrow
 * pane — which is not "no draft", and must never be read as one.
 *
 * ESC bytes are assembled from char codes so no source file holds a raw control
 * character. NBSP (U+00A0) is the marker separator the live TUI emits.
 */

const ESC = String.fromCharCode(27);
const NBSP = String.fromCharCode(0xa0);

// ── 51-column form, transcribed from rows 34-39 of the live capture ──────────
const NARROW_WIDTH = 51;
const NARROW_LABEL_ROW =
  `${ESC}[38;5;16m${ESC}[48;5;37m Manage Claude orchestrator task queue and workers`;
const NARROW_LABEL_TAIL = `${ESC}[38;5;37m${ESC}[49m──${ESC}[39m`;
const NARROW_BOTTOM = `${ESC}[38;5;37m${"─".repeat(NARROW_WIDTH)}`;
const NARROW_BOTTOM_TAIL = `──${ESC}[39m`;
const NARROW_STATUS =
  `  ${ESC}[38;5;147m⏵⏵ accept edits on${ESC}[38;5;246m · ← for agents${ESC}[39m`;

function narrowFrame(composerRows: string[]): string {
  return [
    `${ESC}[38;5;231m⏺${ESC}[39m Filed the clobber recurrence as #156.`,
    "",
    `${ESC}[38;5;246m✻${ESC}[39m ${ESC}[38;5;246mCrunched for 24s${ESC}[39m`,
    "",
    NARROW_LABEL_ROW,
    NARROW_LABEL_TAIL,
    ...composerRows,
    NARROW_BOTTOM,
    NARROW_BOTTOM_TAIL,
    NARROW_STATUS,
    "",
  ].join("\n");
}

/** Nothing typed: the input line is on screen and empty (51 cols). */
export function clearComposer(): string {
  return narrowFrame([`❯${NBSP}`]);
}

/** Empty, but showing a dim ghost-text suggestion — still nothing typed. The
 *  live capture this mirrors had exactly this shape. */
export function ghostComposer(text = "ok #66 review approved? can I merge it?"): string {
  return narrowFrame([`❯${NBSP}${ESC}[2m${text}${ESC}[0m`]);
}

/**
 * A human draft in the composer (51 cols). The first line sits on the marker row
 * and any further lines are continuation rows, exactly as a multi-line draft
 * renders. Typed text is default-styled, which is what tells it from ghost text.
 */
export function draftComposer(...lines: string[]): string {
  const [first, ...rest] = lines;
  return narrowFrame([
    `❯${NBSP}${first}`,
    ...rest.map((line) => `  ${line}`),
  ]);
}

// ── 131-column form, transcribed from the same pane earlier the same day ─────
const WIDE_WIDTH = 127;
const WIDE_TITLED_TOP =
  `${ESC}[38;5;37m${"─".repeat(78)}${ESC}[38;5;16m${ESC}[48;5;37m` +
  ` Manage Claude orchestrator task queue and workers ${ESC}[38;5;37m${ESC}[49m──`;
const WIDE_BOTTOM = `${ESC}[38;5;37m${"─".repeat(WIDE_WIDTH)}`;
const WIDE_STATUS =
  `${ESC}[39m  ${ESC}[38;5;147m⏵⏵ accept edits on` +
  `${ESC}[38;5;246m (shift+tab to cycle) · ← for agents${ESC}[39m`;

function wideFrame(composerRows: string[]): string {
  return [
    `${ESC}[38;5;231m⏺${ESC}[39m Anything else before I merge?`,
    "",
    `${ESC}[38;5;246m✻${ESC}[39m ${ESC}[38;5;246mWorked for 2m 28s${ESC}[39m`,
    "",
    WIDE_TITLED_TOP,
    ...composerRows,
    WIDE_BOTTOM,
    WIDE_STATUS,
    "",
  ].join("\n");
}

/** Nothing typed, at 131 cols (label embedded in the top rule). */
export function wideClearComposer(): string {
  return wideFrame([`${ESC}[38;5;239m${ESC}[48;5;237m❯ `]);
}

/** A human draft at 131 cols. */
export function wideDraftComposer(...lines: string[]): string {
  const [first, ...rest] = lines;
  return wideFrame([
    `${ESC}[38;5;239m${ESC}[48;5;237m❯ ${ESC}[38;5;231m${first} ${ESC}[39m`,
    ...rest.map((line) => `  ${ESC}[38;5;231m${line} ${ESC}[39m`),
  ]);
}

/**
 * Wrap `text` into composer rows the way the TUI lays a long message out, so a
 * test can render what is actually on screen after send-keys types a ~600-char
 * notification in. `wrap: "hard"` breaks at exactly `width` characters —
 * mid-word, which the live pane demonstrably does — and `wrap: "word"` breaks at
 * spaces.
 */
export function wrappedComposer(
  text: string,
  opts: { width?: number; wrap?: "word" | "hard" } = {},
): string {
  const width = opts.width ?? NARROW_WIDTH;
  const rows: string[] = [];
  if (opts.wrap === "word") {
    let row = "";
    for (const word of text.split(" ")) {
      if (row === "") row = word;
      else if (row.length + 1 + word.length <= width) row += ` ${word}`;
      else {
        rows.push(row);
        row = word;
      }
    }
    if (row !== "") rows.push(row);
  } else {
    for (let i = 0; i < text.length; i += width) rows.push(text.slice(i, i + width));
  }
  return draftComposer(...rows);
}

/** A boxed permission menu, as it renders when one pops mid-turn. Pressing
 *  Enter here confirms the highlighted option. */
export function permissionMenu(): string {
  return [
    `${ESC}[38;5;231m⏺${ESC}[39m Running the migration`,
    "",
    `╭${"─".repeat(60)}╮`,
    `│ Run rm -rf ./build in /repo?${" ".repeat(32)}│`,
    `│${" ".repeat(60)}│`,
    `│ ❯ 1. Yes${" ".repeat(51)}│`,
    `│   2. Yes, and don't ask again${" ".repeat(31)}│`,
    `│   3. No, and tell Claude what to do differently (esc)${" ".repeat(7)}│`,
    `╰${"─".repeat(60)}╯`,
    "",
  ].join("\n");
}

/** Assistant output with no composer on screen at all (mid-turn, or a TUI whose
 *  chrome this parser no longer recognizes). */
export function noComposer(): string {
  return [
    `${ESC}[38;5;231m⏺${ESC}[39m Reading src/daemon/notifqueue.ts`,
    "",
    "  Ran 3 tools",
    "",
  ].join("\n");
}
