import { describe, expect, it } from "vitest";
import { parsePane } from "../src/daemon/pane.js";

const ESC = String.fromCharCode(27);

describe("parsePane", () => {
  it("parses an unboxed Codex selection menu only with its confirmation footer", () => {
    const raw = [
      "Hooks need review",
      "3 hooks are new or changed.",
      "Hooks can run outside the sandbox after you trust them.",
      "",
      "› 1. Review hooks",
      "  2. Trust all and continue",
      "  3. Continue without trusting (hooks won't run)",
      "",
      "Press enter to confirm or esc to go back",
    ].join("\n");

    expect(parsePane(raw, "codex").pending_permission).toEqual({
      question:
        "Hooks need review 3 hooks are new or changed. Hooks can run outside the sandbox after you trust them.",
      options: [
        { n: 1, label: "Review hooks" },
        { n: 2, label: "Trust all and continue" },
        { n: 3, label: "Continue without trusting (hooks won't run)" },
      ],
    });
  });

  it("does not parse quoted Codex options without live-menu chrome", () => {
    const raw = [
      "• The terminal previously showed:",
      "› 1. Yes",
      "  2. No",
      "",
      "›",
    ].join("\n");

    expect(parsePane(raw, "codex").pending_permission).toBeNull();
  });

  it("parses the Codex project-trust menu's continue footer", () => {
    const raw = [
      "Do you trust the contents of this directory? Working with untrusted contents",
      "comes with higher risk of prompt injection.",
      "",
      "› 1. Yes, continue",
      "  2. No, quit",
      "",
      "Press enter to continue",
    ].join("\n");

    expect(parsePane(raw, "codex").pending_permission).toEqual({
      question:
        "Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt injection.",
      options: [
        { n: 1, label: "Yes, continue" },
        { n: 2, label: "No, quit" },
      ],
    });
  });

  it("parses the current unboxed Claude folder-trust menu", () => {
    const raw = [
      "Quick safety check: Is this a project you created or one you trust?",
      "",
      "Security guide",
      "",
      "❯ 1. Yes, I trust this folder",
      "  2. No, exit",
      "",
      "Enter to confirm · Esc to cancel",
    ].join("\n");

    expect(parsePane(raw, "claude").pending_permission).toEqual({
      question: "Security guide",
      options: [
        { n: 1, label: "Yes, I trust this folder" },
        { n: 2, label: "No, exit" },
      ],
    });
  });

  it("parses the current unboxed Claude command-approval menu", () => {
    const raw = [
      "This command requires approval",
      "",
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. Yes, and don't ask again for this command",
      "  3. No",
      "",
      "Esc to cancel · Tab to amend · ctrl+e to explain",
    ].join("\n");

    expect(parsePane(raw, "claude").pending_permission).toEqual({
      question: "Do you want to proceed?",
      options: [
        { n: 1, label: "Yes" },
        { n: 2, label: "Yes, and don't ask again for this command" },
        { n: 3, label: "No" },
      ],
    });
  });

  it("ignores Codex's dim input placeholder while the agent is working", () => {
    const raw = [
      "• I am checking the change now.",
      "",
      `• ${ESC}[2mWorking${ESC}[0m ${ESC}[2m(7s • esc to interrupt)${ESC}[0m`,
      "",
      `${ESC}[1m›${ESC}[0m ${ESC}[2mRun /review on my current changes${ESC}[0m`,
      "",
      "  gpt-5.6-sol default · /tmp/worktree",
    ].join("\n");

    const parsed = parsePane(raw, "codex");
    expect(parsed.pending_permission).toBeNull();
    expect(parsed.pending_question).toBeNull();
    expect(parsed.unsubmitted_input).toBeNull();
  });

  it("parses a permission menu whose options wrap at pane width", () => {
    const raw = [
      "Some earlier output scrolled off the top.",
      "",
      "CORNER_TL DASHES CORNER_TR",
      "PIPE Bash command PIPE",
      "PIPE PIPE",
      "PIPE   rm -rf /tmp/scratch PIPE",
      "PIPE PIPE",
      "PIPE Do you want to proceed? PIPE",
      "PIPE CURSOR 1. Yes PIPE",
      "PIPE   2. Yes, and don't ask again for rm commands in PIPE",
      "PIPE      /tmp/scratch PIPE",
      "PIPE   3. No, and tell Claude what to do differently PIPE",
      "PIPE      (esc) PIPE",
      "CORNER_BL DASHES CORNER_BR",
    ].join("\n");

    const parsed = parsePane(fixture(raw));

    expect(parsed.pending_permission).toEqual({
      question: "Do you want to proceed?",
      options: [
        { n: 1, label: "Yes" },
        {
          n: 2,
          label: "Yes, and don't ask again for rm commands in /tmp/scratch",
        },
        { n: 3, label: "No, and tell Claude what to do differently (esc)" },
      ],
    });
    expect(parsed.pending_question).toBeNull();
    expect(parsed.unsubmitted_input).toBeNull();
  });

  it("extracts a plain question with no menu, from an empty input box", () => {
    const raw = [
      "BULLET I've reviewed the migration script. Before I run it against",
      "  production, should I also back up the current table first?",
      "",
      "CORNER_TL DASHES CORNER_TR",
      "PIPE CURSOR PIPE",
      "CORNER_BL DASHES CORNER_BR",
      "  ? for shortcuts",
    ].join("\n");

    const parsed = parsePane(fixture(raw));

    expect(parsed.pending_permission).toBeNull();
    expect(parsed.pending_question).toBe(
      "I've reviewed the migration script. Before I run it against\n" +
        "production, should I also back up the current table first?",
    );
    expect(parsed.unsubmitted_input).toBeNull();
  });

  it("returns unsubmitted text sitting in the input line, verbatim", () => {
    const raw = [
      "BULLET Anything else before I merge?",
      "",
      "CORNER_TL DASHES CORNER_TR",
      "PIPE CURSOR please double check with the security team first PIPE",
      "CORNER_BL DASHES CORNER_BR",
    ].join("\n");

    const parsed = parsePane(fixture(raw));

    expect(parsed.pending_permission).toBeNull();
    expect(parsed.pending_question).toBe("Anything else before I merge?");
    expect(parsed.unsubmitted_input).toBe(
      "please double check with the security team first",
    );
  });

  it("returns unsubmitted text verbatim even when it wraps across pane width", () => {
    const raw = [
      "CORNER_TL DASHES CORNER_TR",
      "PIPE CURSOR this is a very long line of typed but unsubmitted PIPE",
      "PIPE   text that keeps going onto a second physical line PIPE",
      "CORNER_BL DASHES CORNER_BR",
    ].join("\n");

    const parsed = parsePane(fixture(raw));

    expect(parsed.unsubmitted_input).toBe(
      "this is a very long line of typed but unsubmitted " +
        "text that keeps going onto a second physical line",
    );
  });

  it("joins a permission question that itself wraps across pane width", () => {
    const raw = [
      "CORNER_TL DASHES CORNER_TR",
      "PIPE Do you want to proceed with this PIPE",
      "PIPE potentially destructive operation? PIPE",
      "PIPE CURSOR 1. Yes PIPE",
      "PIPE   2. No PIPE",
      "CORNER_BL DASHES CORNER_BR",
    ].join("\n");

    const parsed = parsePane(fixture(raw));

    expect(parsed.pending_permission?.question).toBe(
      "Do you want to proceed with this potentially destructive operation?",
    );
  });

  /**
   * The bug this guards against: a worker can have BOTH stale unsubmitted
   * text sitting in its input line AND assistant text above the box that
   * reads as a plain question (the backend only nulls unsubmitted_input /
   * pending_question against pending_permission, never against each other).
   * The frontend must never let an operator type a fresh reply on top of
   * unsubmitted_input — the two would concatenate and submit as one
   * garbled message. This test documents that the parser legitimately
   * returns both fields set at once, which is exactly the state the
   * frontend's reply box must special-case (see AgentPane in App.tsx).
   */
  it("can report pending_question and unsubmitted_input at the same time", () => {
    const raw = [
      "BULLET Should I also back up the table before running this?",
      "",
      "CORNER_TL DASHES CORNER_TR",
      "PIPE CURSOR wait don't run it yet PIPE",
      "CORNER_BL DASHES CORNER_BR",
    ].join("\n");

    const parsed = parsePane(fixture(raw));

    expect(parsed.pending_question).toBe(
      "Should I also back up the table before running this?",
    );
    expect(parsed.unsubmitted_input).toBe("wait don't run it yet");
  });

  it("returns all-null fields for an empty prompt", () => {
    const raw = [
      "CORNER_TL DASHES CORNER_TR",
      "PIPE CURSOR PIPE",
      "CORNER_BL DASHES CORNER_BR",
    ].join("\n");

    const parsed = parsePane(fixture(raw));

    expect(parsed.pending_permission).toBeNull();
    expect(parsed.pending_question).toBeNull();
    expect(parsed.unsubmitted_input).toBeNull();
    expect(parsed.raw).toContain("❯"); // the cursor marker survives, unparsed
  });

  it("does not treat a worker merely quoting a menu in prose as a pending permission", () => {
    const raw = [
      "BULLET I saw the following prompt appear earlier:",
      "",
      "    Do you want to proceed?",
      "    CURSOR 1. Yes",
      "      2. No",
      "",
      "  I'll wait for your guidance on how to respond.",
      "",
      "CORNER_TL DASHES CORNER_TR",
      "PIPE CURSOR PIPE",
      "CORNER_BL DASHES CORNER_BR",
    ].join("\n");

    const parsed = parsePane(fixture(raw));

    expect(parsed.pending_permission).toBeNull();
  });

  it("strips ANSI escape sequences before parsing", () => {
    const bold = `${ESC}[1m`;
    const reset = `${ESC}[0m`;
    const raw = [
      `${bold}Do you want to proceed?${reset}`,
      "CORNER_TL DASHES CORNER_TR",
      `PIPE ${bold}Bash command${reset} PIPE`,
      "PIPE PIPE",
      "PIPE Do you want to proceed? PIPE",
      "PIPE CURSOR 1. Yes PIPE",
      "PIPE   2. No PIPE",
      "CORNER_BL DASHES CORNER_BR",
    ].join("\n");

    const parsed = parsePane(fixture(raw));

    expect(parsed.raw).not.toContain(ESC);
    expect(parsed.pending_permission?.options).toEqual([
      { n: 1, label: "Yes" },
      { n: 2, label: "No" },
    ]);
  });

  it("caps the raw payload length instead of growing unbounded", () => {
    const raw = "x".repeat(20_000);
    const parsed = parsePane(raw);
    expect(parsed.raw.length).toBeLessThanOrEqual(8000);
  });
});

/**
 * Fixtures above spell out box-drawing chars as readable placeholder tokens
 * (CORNER_TL, PIPE, CURSOR, …) so they're easy to eyeball and diff — this
 * swaps them for the real Unicode glyphs Claude Code's TUI renders before
 * handing the fixture to the parser under test.
 */
function fixture(raw: string): string {
  return raw
    .replace(/CORNER_TL DASHES CORNER_TR/g, () => box("╭", "╮"))
    .replace(/CORNER_BL DASHES CORNER_BR/g, () => box("╰", "╯"))
    .replace(/^PIPE /gm, "│ ")
    .replace(/ PIPE$/gm, " │")
    .replace(/CURSOR/g, "❯")
    .replace(/^BULLET /gm, "⏺ ");
}

function box(left: string, right: string): string {
  return `${left}${"─".repeat(56)}${right}`;
}
