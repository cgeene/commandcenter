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

/** Text sitting after the input marker that hasn't been sent yet — may wrap
 *  across multiple physical lines within the input box at pane width. */
function parseUnsubmittedInput(lines: string[]): string | null {
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
  return parts.length > 0 ? parts.join(" ") : null;
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
  const clean = stripAnsi(rawTail).replace(/\r/g, "");
  const raw = clean.length > MAX_RAW_CHARS ? clean.slice(-MAX_RAW_CHARS) : clean;
  const lines = clean.split("\n");
  const ansiLines = rawTail.replace(/\r/g, "").split("\n");

  const pending_permission =
    provider === "codex"
      ? parsePlainPermission(lines)
      : parsePermission(lines) ?? parsePlainPermission(lines);
  const codexInput = provider === "codex" ? findCodexInput(lines, ansiLines) : null;
  const unsubmitted_input = pending_permission
    ? null
    : provider === "codex"
      ? codexInput?.text || null
      : parseUnsubmittedInput(lines);
  const pending_question = pending_permission
    ? null
    : provider === "codex" && codexInput
      ? parseCodexQuestion(lines, codexInput.index)
      : parseQuestion(lines);

  return { pending_permission, pending_question, unsubmitted_input, raw };
}
