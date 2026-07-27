/**
 * Parse a tmux pane tail into the structured shape the dashboard needs to
 * show a waiting_input agent's prompt without opening its terminal.
 *
 * Claude Code and Codex render tool-permission prompts and the input line
 * inside fixed-width boxes bordered with a pipe character on both sides of
 * every content row and rounded-corner caps top/bottom. That border is the
 * load-bearing signal here: it's what lets a genuine permission menu be told
 * apart from a worker's assistant text merely *quoting* one in prose (plain
 * text has no border, so it can't match).
 *
 * Current Codex renders its menus without a box. For that provider we require
 * both its `› N.` cursor row and its nearby "Press enter to confirm" footer;
 * the pair is the equivalent load-bearing signal and avoids treating quoted
 * option text as a live prompt.
 */

import type { AgentProvider } from "../providers.js";

// Built via RegExp() from \u-escapes (rather than a literal regex) so the
// source file never contains a raw ESC/BEL byte.
const ANSI_RE = new RegExp(
  "[\\u001B\\u009B][[\\]()#;?]*(?:(?:[a-zA-Z0-9]*(?:;[a-zA-Z0-9]*)*)?\\u0007" +
    "|(?:\\d{1,4}(?:;\\d{0,4})*)?[0-9A-PR-TZcf-ntqry=><~])",
  "g",
);

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

// SGR (Select Graphic Rendition) sequences — the subset of ANSI that carries
// text styling. Built via RegExp() from \u-escapes so the source never holds a
// raw ESC byte (see the module note above). SGR 2 = faint/dim, which is how
// Claude Code renders ghost-text prompt suggestions; SGR 0 / 22 clear it.
const SGR_RE = new RegExp("[\\u001B\\u009B]\\[([0-9;]*)m", "g");

/**
 * Return a line's visible text with any run styled dim (SGR 2) removed, then
 * strip whatever ANSI is left. Ghost-text suggestions Claude Code paints into
 * an idle composer are dim; real typed input is default-styled. On a plain
 * (escape-free) line this is just stripAnsi — dim state never turns on — so
 * callers that pass unstyled text keep the old "all text is real" behavior.
 */
function visibleNonGhost(line: string): string {
  let dim = false;
  let out = "";
  let last = 0;
  SGR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SGR_RE.exec(line)) !== null) {
    if (!dim) out += line.slice(last, m.index);
    for (const part of m[1].split(";")) {
      const code = part === "" ? 0 : Number(part);
      if (code === 2) dim = true;
      else if (code === 0 || code === 22) dim = false;
    }
    last = m.index + m[0].length;
  }
  if (!dim) out += line.slice(last);
  return stripAnsi(out);
}

export interface PaneOption {
  n: number;
  label: string;
}

export interface PendingPermission {
  question: string;
  options: PaneOption[];
}

export interface ParsedPane {
  pending_permission: PendingPermission | null;
  pending_question: string | null;
  unsubmitted_input: string | null;
  /**
   * Whether the input line itself was positively located in this capture.
   *
   * `unsubmitted_input === null` alone is ambiguous: it means either "the
   * composer is empty" or "the composer could not be found at all". Callers
   * that are about to TYPE into the pane must not conflate those — see
   * notifqueue.promptClarity, which treats a composer it cannot see as unsafe.
   */
  composer_found: boolean;
  raw: string;
}

// Cap the payload regardless of how much pane history capturePane hands us.
const MAX_RAW_CHARS = 8000;

const TOP_BORDER_RE = /^\s*╭.*╮\s*$/;
const BOTTOM_BORDER_RE = /^\s*╰.*╯\s*$/;
// A menu option row, e.g. "❯ 1. Yes" (cursor) or "  2. No" (unselected).
const OPTION_RE = /^(?:❯\s*)?(\d{1,2})[.)]\s+(.*)$/;
// The cursor specifically sitting on an option — the anchor for menu detection.
const MENU_CURSOR_RE = /^❯\s*\d{1,2}[.)]\s+\S/;
// The input-line prompt marker, with whatever's been typed (if anything).
const INPUT_LINE_RE = /^❯\s?(.*)$/;
const CHROME_RE = /^(esc to interrupt|\? for shortcuts|ctrl-c to exit)/i;
const CODEX_CURSOR_RE = /^[›❯]\s*(\d{1,2})[.)]\s+(.*)$/;
const CODEX_OPTION_RE = /^(?:[›❯]\s*)?(\d{1,2})[.)]\s+(.*)$/;
const PLAIN_CONFIRM_RE =
  /(?:press )?enter to (?:confirm|continue)\b|esc to cancel.*(?:tab to amend|ctrl\+e to explain)/i;
const CODEX_INPUT_RE = /^[›❯](?:\s(.*))?$/;

interface Unwrapped {
  bordered: boolean;
  content: string;
}

/** Strip a box's side borders; only true when both sides are present. */
function unwrap(line: string): Unwrapped {
  const m = /^\s*│(.*)│\s*$/.exec(line);
  if (m) return { bordered: true, content: m[1].trim() };
  return { bordered: false, content: line.trim() };
}

function parsePermission(lines: string[]): PendingPermission | null {
  const unwrapped = lines.map(unwrap);
  const optStart = unwrapped.findIndex(
    (u) => u.bordered && MENU_CURSOR_RE.test(u.content),
  );
  if (optStart === -1) return null;

  // Question: all contiguous non-blank bordered lines directly above the
  // option block, in original order — it can wrap across pane width too.
  const questionLines: string[] = [];
  for (let i = optStart - 1; i >= 0; i--) {
    const u = unwrapped[i];
    if (!u.bordered || u.content === "") break;
    questionLines.unshift(u.content);
  }
  const question = questionLines.join(" ");

  const options: PaneOption[] = [];
  for (let i = optStart; i < unwrapped.length; i++) {
    const u = unwrapped[i];
    if (!u.bordered || u.content === "") break;
    const m = OPTION_RE.exec(u.content);
    if (m) {
      options.push({ n: Number(m[1]), label: m[2].trim() });
    } else if (options.length > 0) {
      // A wrapped continuation of the previous option's label.
      options[options.length - 1].label += ` ${u.content}`;
    } else {
      break;
    }
  }

  return options.length > 0 ? { question, options } : null;
}

function parsePlainPermission(lines: string[]): PendingPermission | null {
  const trimmed = lines.map((line) => line.trim());
  const optStart = trimmed.findIndex((line) => CODEX_CURSOR_RE.test(line));
  if (optStart === -1) return null;

  // A cursor-shaped line can appear in quoted prose. Codex's real selection
  // screen also carries this footer, so require it close to the options.
  if (!trimmed.slice(optStart + 1, optStart + 16).some((line) => PLAIN_CONFIRM_RE.test(line))) {
    return null;
  }

  const options: PaneOption[] = [];
  for (let i = optStart; i < trimmed.length; i++) {
    const line = trimmed[i];
    if (!line || PLAIN_CONFIRM_RE.test(line)) break;
    const match = CODEX_OPTION_RE.exec(line);
    if (match) {
      options.push({ n: Number(match[1]), label: match[2].trim() });
    } else if (options.length > 0) {
      options[options.length - 1].label += ` ${line}`;
    } else {
      break;
    }
  }
  if (options.length === 0) return null;

  // Codex normally separates the explanatory question from the options by a
  // blank line. Walk to the closest non-empty block rather than requiring it
  // to be directly adjacent.
  let i = optStart - 1;
  while (i >= 0 && trimmed[i] === "") i--;
  const questionLines: string[] = [];
  for (; i >= 0 && trimmed[i] !== "" && questionLines.length < 8; i--) {
    questionLines.unshift(trimmed[i].replace(/^[•■⚠]\s*/, ""));
  }
  return { question: questionLines.join(" "), options };
}

// Strip the "❯" marker and the whitespace after it. In the live TUI
// that separator is a non-breaking space (U+00A0); JS `\s` matches it.
const MARKER_RE = /^❯\s*(.*)$/;

/**
 * Current Claude Code frames the input line between two horizontal rules of
 * U+2500 rather than in a rounded box, and paints a session label into the top
 * one. How that renders depends entirely on the pane's width, and the same live
 * orchestrator pane produces both of these:
 *
 *   131 cols:  "──────────…────── Manage Claude orchestrator … ──"
 *    51 cols:  " Manage Claude orchestrator task queue and workers"
 *              "──"
 *
 * At narrow widths the label consumes the whole row — ZERO rule glyphs on it —
 * and the rules that follow wrap onto their own row. The bottom rule wraps the
 * same way (a full-width row, then a short tail). So no per-row predicate can
 * recognize the TOP border at every width, and requiring one is what left a
 * real draft invisible on the actual pane the incident happened on.
 *
 * Detection therefore anchors on the BOTTOM border, whose rows are pure rule
 * glyphs at any width, and walks up from it — see parseRuleComposer.
 */

/** A row that is nothing but rule glyphs. Count is deliberately not part of the
 *  test: a wrapped border's tail is only a couple of glyphs wide. */
function isRuleRow(trimmed: string): boolean {
  return trimmed.length > 0 && /^─+$/.test(trimmed);
}

/** A rule row with the label embedded in it — the wide-pane form of the top
 *  border. Used only as a stop when scanning upward. */
function isLabelledRuleRow(trimmed: string): boolean {
  const rules = trimmed.match(/─/g)?.length ?? 0;
  if (rules < 2) return false;
  const label = trimmed.replace(/^─+/, "").replace(/─+$/, "");
  return !label.includes("─");
}

/** Rows the agent's own output starts with. A row beginning with one of these
 *  is transcript text, never part of the composer — it is the stop that keeps
 *  the upward scan from reaching a scrollback echo of an already-submitted
 *  "❯ …" message and reporting it as a live draft. */
const OUTPUT_BULLET_RE = /^[⏺✻⎿]/;

/** How far above the bottom border to look. Generous enough for a long draft
 *  (or a ~600-char injected message) wrapped at a narrow pane width, bounded so
 *  a composer-less pane can't drag the scan through the whole transcript. */
const MAX_COMPOSER_SCAN_ROWS = 40;

/**
 * What the input line holds. `null` (rather than a `text: null` read) means the
 * composer could not be located at all — a distinction callers about to type
 * into the pane depend on (see ParsedPane.composer_found).
 */
interface ComposerRead {
  /** Typed-but-unsent text, or null when the composer is empty. */
  text: string | null;
}

/** Read the input line: the current rule-framed composer, else the older
 *  box-bordered layout. Ghost-text suggestions (rendered dim) are excluded;
 *  only default-styled text a human actually typed counts. `styled` retains
 *  ANSI (for the dim check); `plain` is the same lines with ANSI stripped (for
 *  structural detection). */
function readComposer(styled: string[], plain: string[]): ComposerRead | null {
  return parseRuleComposer(styled, plain) ?? parseBoxComposer(plain);
}

/**
 * Current layout: a "❯ …" input line above a horizontal rule, its text wrapping
 * across as many physical rows as it needs.
 *
 * Anchored on the bottom border rather than on a pair of borders, because the
 * top border is unrecognizable at narrow widths (see the note above): find the
 * last pure-rule row plus the contiguous rule rows above it (one wrapped
 * border), then walk upward to the input marker. Everything collected on the way
 * is the draft's own wrapped rows. Nothing above the marker has to be
 * identified at all, which is what makes this width-independent.
 */
function parseRuleComposer(styled: string[], plain: string[]): ComposerRead | null {
  const trimmed = plain.map((line) => line.trim());

  let border = -1;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    if (isRuleRow(trimmed[i])) {
      border = i;
      break;
    }
  }
  if (border < 1) return null;
  // A border wider than the pane wraps, so its tail is a rule row of its own.
  while (border > 0 && isRuleRow(trimmed[border - 1])) border--;

  const rows: number[] = [];
  let marker = -1;
  for (
    let i = border - 1;
    i >= 0 && border - i <= MAX_COMPOSER_SCAN_ROWS;
    i--
  ) {
    const t = trimmed[i];
    // A blank row inside the composer is a newline the human typed and has not
    // filled in yet — skip it, but don't let it end the draft.
    if (t === "") continue;
    // Reaching the top border, another rule, or agent output means there is no
    // input line here: this rule was something else (a rule the agent printed).
    if (isRuleRow(t) || isLabelledRuleRow(t) || OUTPUT_BULLET_RE.test(t)) break;
    rows.unshift(i);
    if (t.startsWith("❯")) {
      marker = i;
      break;
    }
  }
  if (marker === -1) return null;
  // A menu cursor ("❯ 1. Yes") is not the free-text input line.
  if (/^\d{1,2}[.)]\s/.test(trimmed[marker].replace(/^❯\s*/, ""))) return null;

  const parts: string[] = [];
  for (const i of rows) {
    const visible = visibleNonGhost(styled[i] ?? plain[i]).trim();
    const text =
      i === marker ? (MARKER_RE.exec(visible)?.[1] ?? "").trim() : visible;
    if (text) parts.push(text);
  }
  return { text: parts.length > 0 ? parts.join(" ") : null };
}

/** Older layout: "❯ …" inside a rounded box, bordered by `│` on both sides. */
function parseBoxComposer(lines: string[]): ComposerRead | null {
  const unwrapped = lines.map(unwrap);
  let start = -1;
  let firstText = "";
  for (let i = unwrapped.length - 1; i >= 0; i--) {
    const u = unwrapped[i];
    if (!u.bordered) continue;
    const m = INPUT_LINE_RE.exec(u.content);
    if (!m) continue;
    // A menu cursor ("❯ 1. Yes") is not the free-text input line.
    if (/^\d{1,2}[.)]\s/.test(m[1])) continue;
    start = i;
    firstText = m[1];
    break;
  }
  if (start === -1) return null;

  const parts = firstText.length > 0 ? [firstText] : [];
  for (let i = start + 1; i < unwrapped.length; i++) {
    const u = unwrapped[i];
    // A wrapped continuation is bordered, non-blank, and not itself a new
    // prompt/menu row.
    if (!u.bordered || u.content === "" || u.content.startsWith("❯")) break;
    parts.push(u.content);
  }
  return { text: parts.length > 0 ? parts.join(" ") : null };
}

function findCodexInput(
  lines: string[],
  ansiLines: string[],
): { index: number; text: string } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = CODEX_INPUT_RE.exec(lines[i].trim());
    if (!match || /^\d{1,2}[.)]\s/.test(match[1] ?? "")) continue;
    const marker = ansiLines[i]?.search(/[›❯]/) ?? -1;
    const styledInput = marker >= 0 ? ansiLines[i].slice(marker + 1) : "";
    // Codex's rotating suggestions are dim (`SGR 2`) after the prompt marker;
    // they are placeholders, not text waiting to be submitted.
    const text = /\u001b\[2m/.test(styledInput) ? "" : (match[1] ?? "").trim();
    return { index: i, text };
  }
  return null;
}

function parseCodexQuestion(lines: string[], inputIndex: number): string | null {
  let i = inputIndex - 1;
  while (i >= 0 && lines[i].trim() === "") i--;
  const nearest = lines[i]?.trim().replace(/^[•■⚠◦]\s*/, "") ?? "";
  if (/^(?:Working|Worked for)\b/i.test(nearest)) return null;
  const collected: string[] = [];
  for (; i >= 0 && collected.length < 20; i--) {
    const text = lines[i].trim();
    if (!text || CHROME_RE.test(text) || PLAIN_CONFIRM_RE.test(text)) {
      if (collected.length > 0) break;
      continue;
    }
    // Status/footer chrome is below the input in normal panes, but ignore it
    // defensively if a narrow terminal has caused an unusual redraw.
    const normalized = text.replace(/^[•■⚠◦]\s*/, "");
    if (/^(?:gpt-|model:|directory:|tokens?\b|Working\b|Worked for\b)/i.test(normalized)) {
      continue;
    }
    collected.unshift(normalized);
  }
  const question = collected.join("\n").trim();
  return question || null;
}

/** The agent's last assistant text before the (empty or not) input box. */
function parseQuestion(lines: string[]): string | null {
  let boxTop = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (TOP_BORDER_RE.test(lines[i])) {
      boxTop = i;
      break;
    }
  }
  if (boxTop === -1) return null;

  const collected: string[] = [];
  for (let i = boxTop - 1; i >= 0 && collected.length < 20; i--) {
    const text = lines[i].trim();
    if (text === "" || CHROME_RE.test(text) || BOTTOM_BORDER_RE.test(text)) {
      if (collected.length > 0) break;
      continue;
    }
    collected.unshift(text.replace(/^⏺\s*/, ""));
  }
  const question = collected.join("\n").trim();
  return question.length > 0 ? question : null;
}

export function parsePane(
  rawTail: string,
  provider: AgentProvider = "claude",
): ParsedPane {
  // `rawTail` may or may not carry ANSI escapes: the pane parser is fed a
  // `capture-pane -e` (styled) capture so Claude ghost text can be told from
  // real input (see visibleNonGhost), but plain captures (and test fixtures)
  // still work — stripAnsi and the dim check both no-op on escape-free text.
  const clean = stripAnsi(rawTail).replace(/\r/g, "");
  const raw = clean.length > MAX_RAW_CHARS ? clean.slice(-MAX_RAW_CHARS) : clean;
  const lines = clean.split("\n");
  const ansiLines = rawTail.replace(/\r/g, "").split("\n");

  const pending_permission =
    provider === "codex"
      ? parsePlainPermission(lines)
      : parsePermission(lines) ?? parsePlainPermission(lines);
  const codexInput = provider === "codex" ? findCodexInput(lines, ansiLines) : null;
  // Claude: reject dim ghost-text suggestions (styled lines) so an idle
  // composer's autosuggestion is not mistaken for real typed input (#30).
  // Codex: its own input scan already distinguishes real input.
  const composer: ComposerRead | null =
    provider === "codex"
      ? codexInput
        ? { text: codexInput.text || null }
        : null
      : readComposer(ansiLines, lines);
  const unsubmitted_input = pending_permission ? null : composer?.text ?? null;
  const pending_question = pending_permission
    ? null
    : provider === "codex" && codexInput
      ? parseCodexQuestion(lines, codexInput.index)
      : parseQuestion(lines);

  return {
    pending_permission,
    pending_question,
    unsubmitted_input,
    composer_found: composer !== null,
    raw,
  };
}
