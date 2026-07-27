/**
 * Pane captures shaped like the real Claude Code TUI, for tests that exercise
 * the composer and the anti-clobber delivery gate.
 *
 * Assembled from an actual `tmux capture-pane -e` of a live orchestrator pane
 * (Claude Code 2.1.x, 2026-07-27), including the detail that broke draft
 * detection in the wild: the TUI paints a session label INTO the composer's top
 * border, so that row is not a line of pure `─`. Fixtures that spell the
 * composer out approximately (a bare `>` in a box, an empty string) cannot
 * catch that class of regression, which is why these mirror a capture verbatim.
 *
 * ESC bytes are assembled from char codes so no source file holds a raw control
 * character.
 */

const ESC = String.fromCharCode(27);

/** The composer's top border with the label the TUI embeds in it. */
const TITLED_TOP =
  `${ESC}[38;5;37m${"─".repeat(78)}${ESC}[38;5;16m${ESC}[48;5;37m` +
  ` Manage Claude orchestrator task queue and workers ${ESC}[38;5;37m${ESC}[49m──`;
const BOTTOM = `${ESC}[38;5;37m${"─".repeat(127)}`;
const STATUS =
  `${ESC}[39m  ${ESC}[38;5;147m⏵⏵ accept edits on` +
  `${ESC}[38;5;246m (shift+tab to cycle) · ← for agents${ESC}[39m`;

function frame(rows: string[]): string {
  return [
    `${ESC}[38;5;231m⏺${ESC}[39m Anything else before I merge?`,
    "",
    `${ESC}[38;5;246m✻${ESC}[39m ${ESC}[38;5;246mWorked for 2m 28s${ESC}[39m`,
    "",
    TITLED_TOP,
    ...rows,
    BOTTOM,
    STATUS,
    "",
  ].join("\n");
}

/** Nothing typed: the input line is on screen and empty. */
export function clearComposer(): string {
  return frame([`${ESC}[38;5;239m${ESC}[48;5;237m❯ `]);
}

/** Empty, but showing a dim ghost-text suggestion — still nothing typed. */
export function ghostComposer(text = "how are the workers doing?"): string {
  return frame([`${ESC}[39m❯ ${ESC}[2m${text}${ESC}[0m`]);
}

/**
 * A human draft in the composer. The first line sits on the marker row and any
 * further lines are continuation rows, exactly as a multi-line draft renders.
 */
export function draftComposer(...lines: string[]): string {
  const [first, ...rest] = lines;
  return frame([
    `${ESC}[38;5;239m${ESC}[48;5;237m❯ ${ESC}[38;5;231m${first} ${ESC}[39m`,
    ...rest.map((line) => `  ${ESC}[38;5;231m${line} ${ESC}[39m`),
  ]);
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
