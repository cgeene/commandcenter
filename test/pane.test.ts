import { describe, expect, it } from "vitest";
import { parsePane } from "../src/daemon/pane.js";
import {
  clearComposer,
  draftComposer,
  ghostComposer,
  noComposer,
  wideClearComposer,
  wideDraftComposer,
} from "./fixtures/pane.js";

const ESC = String.fromCharCode(27);

describe("parsePane", () => {
  /**
   * One table for the permission-menu grammar: every row asks the same question
   * — given this pane, is a menu pending and what are its options — of a
   * different real capture. What separates a live menu from prose that merely
   * quotes one is the surrounding CHROME (a confirmation/continue footer, or a
   * box border), never the option text, so the rows deliberately mix boxed and
   * unboxed captures from both providers with lookalikes that must stay null.
   * A false positive here is what lets a notification confirm a menu's
   * highlighted option — usually "1. Yes".
   */
  const MENU_CASES = [
    {
      why: "codex: an unboxed selection menu, recognized by its confirmation footer",
      provider: "codex" as const,
      pane: () =>
        [
          "Hooks need review",
          "3 hooks are new or changed.",
          "Hooks can run outside the sandbox after you trust them.",
          "",
          "› 1. Review hooks",
          "  2. Trust all and continue",
          "  3. Continue without trusting (hooks won't run)",
          "",
          "Press enter to confirm or esc to go back",
        ].join("\n"),
      permission: {
        question:
          "Hooks need review 3 hooks are new or changed. Hooks can run outside the sandbox after you trust them.",
        options: [
          { n: 1, label: "Review hooks" },
          { n: 2, label: "Trust all and continue" },
          { n: 3, label: "Continue without trusting (hooks won't run)" },
        ],
      },
    },
    {
      why: "codex: quoted options with NO live-menu chrome are not a menu",
      provider: "codex" as const,
      pane: () =>
        ["• The terminal previously showed:", "› 1. Yes", "  2. No", "", "›"].join("\n"),
      permission: null,
    },
    {
      why: "codex: the project-trust menu, recognized by its continue footer",
      provider: "codex" as const,
      pane: () =>
        [
          "Do you trust the contents of this directory? Working with untrusted contents",
          "comes with higher risk of prompt injection.",
          "",
          "› 1. Yes, continue",
          "  2. No, quit",
          "",
          "Press enter to continue",
        ].join("\n"),
      permission: {
        question:
          "Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt injection.",
        options: [
          { n: 1, label: "Yes, continue" },
          { n: 2, label: "No, quit" },
        ],
      },
    },
    {
      why: "claude: the unboxed folder-trust menu",
      provider: "claude" as const,
      pane: () =>
        [
          "Quick safety check: Is this a project you created or one you trust?",
          "",
          "Security guide",
          "",
          "❯ 1. Yes, I trust this folder",
          "  2. No, exit",
          "",
          "Enter to confirm · Esc to cancel",
        ].join("\n"),
      permission: {
        question: "Security guide",
        options: [
          { n: 1, label: "Yes, I trust this folder" },
          { n: 2, label: "No, exit" },
        ],
      },
    },
    {
      why: "claude: the unboxed command-approval menu",
      provider: "claude" as const,
      pane: () =>
        [
          "This command requires approval",
          "",
          "Do you want to proceed?",
          "❯ 1. Yes",
          "  2. Yes, and don't ask again for this command",
          "  3. No",
          "",
          "Esc to cancel · Tab to amend · ctrl+e to explain",
        ].join("\n"),
      permission: {
        question: "Do you want to proceed?",
        options: [
          { n: 1, label: "Yes" },
          { n: 2, label: "Yes, and don't ask again for this command" },
          { n: 3, label: "No" },
        ],
      },
    },
    {
      why: "boxed: option labels that wrap at pane width are rejoined",
      pane: () =>
        fixture(
          [
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
          ].join("\n"),
        ),
      permission: {
        question: "Do you want to proceed?",
        options: [
          { n: 1, label: "Yes" },
          { n: 2, label: "Yes, and don't ask again for rm commands in /tmp/scratch" },
          { n: 3, label: "No, and tell Claude what to do differently (esc)" },
        ],
      },
      quiet: true,
    },
    {
      why: "boxed: a question that itself wraps at pane width is rejoined",
      pane: () =>
        fixture(
          [
            "CORNER_TL DASHES CORNER_TR",
            "PIPE Do you want to proceed with this PIPE",
            "PIPE potentially destructive operation? PIPE",
            "PIPE CURSOR 1. Yes PIPE",
            "PIPE   2. No PIPE",
            "CORNER_BL DASHES CORNER_BR",
          ].join("\n"),
        ),
      permission: {
        question: "Do you want to proceed with this potentially destructive operation?",
        options: [
          { n: 1, label: "Yes" },
          { n: 2, label: "No" },
        ],
      },
    },
    {
      why: "a worker quoting a menu in prose, above an empty box, is not a menu",
      pane: () =>
        fixture(
          [
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
          ].join("\n"),
        ),
      permission: null,
    },
  ] as const;

  it("recognizes a pending menu by its chrome, in every capture shape, and rejects lookalikes", () => {
    for (const c of MENU_CASES) {
      const parsed = "provider" in c ? parsePane(c.pane(), c.provider) : parsePane(c.pane());
      expect(parsed.pending_permission, c.why).toEqual(c.permission);
      // A live menu owns the pane: nothing may also read as a plain question or
      // as text the human left unsubmitted.
      if ("quiet" in c) {
        expect(parsed.pending_question, c.why).toBeNull();
        expect(parsed.unsubmitted_input, c.why).toBeNull();
      }
    }
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
 * The fixtures below reproduce, byte for byte, what `tmux capture-pane -e`
 * returns for a Claude Code (v2.1.209) composer captured live from real
 * daemon workers on 2026-07-14. That version frames the composer between two
 * full-width `─` rules with a bare "❯" input line — no side box — and paints
 * its ghost-text prompt suggestions dim (SGR 2) while real typed input stays
 * default-styled. Escape/NBSP bytes are assembled from char codes at runtime
 * so the source file itself holds no raw control bytes.
 *
 * Captured samples the constants below mirror exactly:
 *   ghost: "\x1b[39m❯\xa0\x1b[2mping @caleb on PR #16 …\x1b[0m"
 *   real:  "\x1b[39m❯\xa0please double check with the security team first"
 *   empty: "\x1b[39m❯\xa0"
 *   rule:  "\x1b[38;5;244m────…" (U+2500)
 */
const NBSP = String.fromCharCode(0xa0);
const DIM = `${ESC}[2m`; // SGR 2 — ghost text
const RESET = `${ESC}[0m`;
const DEFFG = `${ESC}[39m`; // default foreground — real input
const RULE = `${ESC}[38;5;244m${"─".repeat(100)}`;

/** Build a rule-framed styled composer capture around one "❯" marker line. */
function composer(markerLine: string, continuation: string[] = []): string {
  return [
    "⏺ Anything else before I merge?",
    "",
    RULE,
    markerLine,
    ...continuation,
    RULE,
    "  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents",
  ].join("\n");
}

describe("parsePane — the composer: draft vs ghost text vs no composer", () => {
  const DRAFT = [
    "custom-hostnames will be team-platform.",
    "nylas-data-lake will also be team platform.",
    "unicorn-",
  ] as const;
  const JOINED =
    "custom-hostnames will be team-platform. " +
    "nylas-data-lake will also be team platform. unicorn-";

  // One table because every case is the same question asked of a different
  // capture: given this pane, did we find a composer and what is in it. The
  // stakes are the same throughout — "no draft found" and "no composer found"
  // used to be the same answer, and that is how a worker notification got typed
  // into and submitted with a human's half-written message.
  const COMPOSER_CASES = [
    {
      why: "a dim ghost-text suggestion is not a human draft",
      pane: () => composer(`${DEFFG}❯${NBSP}${DIM}ping @caleb on PR #16 for the neutral-root name${RESET}`),
      found: true,
      input: null,
    },
    {
      why: "default-styled typed text IS a draft (the anti-clobber case)",
      pane: () => composer(`${DEFFG}❯${NBSP}please double check with the security team first`),
      found: true,
      input: "please double check with the security team first",
    },
    {
      why: "a ghost continuation trailing real text keeps only the real part",
      pane: () => composer(`${DEFFG}❯${NBSP}wait for me${DIM} to confirm the rollout first${RESET}`),
      found: true,
      input: "wait for me",
    },
    {
      why: "an empty styled composer is found but holds nothing",
      pane: () => composer(`${DEFFG}❯${NBSP}`),
      found: true,
      input: null,
    },
    {
      why: "real typed text wrapping two physical lines is rejoined",
      pane: () =>
        composer(`${DEFFG}❯${NBSP}this is a very long line of typed but unsubmitted`, [
          `${DEFFG}  text that keeps going onto a second physical line`,
        ]),
      found: true,
      input:
        "this is a very long line of typed but unsubmitted " +
        "text that keeps going onto a second physical line",
    },
    // 51 columns: the label fills its own row and the borders wrap, so there is
    // no leading run of `─` to match on. Missing this width is what made the
    // input line unfindable.
    {
      why: "51 cols: a human draft",
      pane: () => draftComposer("actually hold on, let me rethink"),
      found: true,
      input: "actually hold on, let me rethink",
    },
    {
      why: "51 cols: every line of a multi-line draft, not just the marker row",
      // The exact draft that got clobbered: the notification landed after
      // "unicorn-" and submitted the merged text as the human's turn.
      pane: () => draftComposer(...DRAFT),
      found: true,
      input: JOINED,
    },
    {
      why: "51 cols: a draft whose trailing newline leaves a blank row",
      pane: () => draftComposer("first thought", "", "second thought"),
      found: true,
      input: "first thought second thought",
    },
    {
      why: "51 cols: an empty composer is found and empty",
      pane: () => clearComposer(),
      found: true,
      input: null,
    },
    {
      why: "51 cols: ghost text still reads as empty",
      pane: () => ghostComposer(),
      found: true,
      input: null,
    },
    {
      why: "131 cols: a multi-line draft",
      pane: () => wideDraftComposer(...DRAFT),
      found: true,
      input: JOINED,
    },
    {
      why: "131 cols: an empty composer is found and empty",
      pane: () => wideClearComposer(),
      found: true,
      input: null,
    },
    {
      why: "no input line on screen at all",
      pane: () => noComposer(),
      found: false,
      input: null,
    },
    {
      why: "a rule pair in the agent's own output is not a composer",
      pane: () =>
        [
          "─".repeat(60),
          "  Summary of the rollout plan",
          "  Ship behind a flag first.",
          "─".repeat(60),
        ].join("\n"),
      found: false,
      input: null,
    },
    {
      why: "a scrollback echo of an already-submitted message is not a live draft",
      // Detection anchors on the bottom rule and walks up; agent output between
      // that rule and an old "❯ …" row must stop the walk, or a message the
      // human already sent would read as a draft and wedge delivery shut.
      pane: () =>
        [
          "❯ an already submitted message",
          "",
          "⏺ Here is the answer",
          "  continued prose",
          "─".repeat(60),
        ].join("\n"),
      found: false,
      input: null,
    },
  ] as const;

  it("answers 'is there a composer, and what is in it' for every width and style", () => {
    for (const { why, pane, found, input } of COMPOSER_CASES) {
      const parsed = parsePane(pane());
      expect(parsed.composer_found, why).toBe(found);
      expect(parsed.unsubmitted_input, why).toBe(input);
    }
  });

  it("strips Claude ghost text and parses a Codex menu under the same parser", () => {
    // Kept separate: this is the only case that asserts the two provider paths
    // do not regress each other, rather than asking one question of one pane.
    const claude = parsePane(
      composer(`${DEFFG}❯${NBSP}${DIM}ping @caleb before merging${RESET}`),
      "claude",
    );
    expect(claude.unsubmitted_input).toBeNull();
    expect(claude.pending_permission).toBeNull();

    const codex = parsePane(
      [
        "Allow running this command?",
        "",
        "› 1. Yes",
        "  2. No",
        "",
        "Press enter to confirm or esc to go back",
      ].join("\n"),
      "codex",
    );
    expect(codex.pending_permission?.options).toEqual([
      { n: 1, label: "Yes" },
      { n: 2, label: "No" },
    ]);
  });
});

/**
 * Background-work counts come from Claude Code's bottom status bar. The bars
 * below were captured live from a daemon worker (Claude Code v2.1.220) on
 * 2026-07-27 while running background shells and Monitor watches, e.g.
 *   "  ⏵⏵ don't ask on · 1 shell, 1 monitor · esc to interrupt · ↓ to manage"
 *   "  ⏵⏵ don't ask on · 3 shells, 2 monitors · esc to interrupt · ↓ to manage"
 * The separator is U+00B7 and the counts occupy one whole segment.
 */
function statusBar(indicator: string | null): string {
  const segments = [
    "⏵⏵ don't ask on",
    ...(indicator ? [indicator] : []),
    "esc to interrupt",
    "← for agents",
    "↓ to manage",
  ];
  return `  ${segments.join(" · ")}`;
}

/** A rule-framed empty composer capped by `bar` as the last rendered row. */
function paneWithStatusBar(bar: string, transcript: string[] = []): string {
  return [
    ...transcript,
    RULE,
    `${DEFFG}❯${NBSP}`,
    RULE,
    bar,
  ].join("\n");
}

describe("parsePane — background shell / monitor status-bar indicator", () => {
  // One table: every row asks the same question of a different bottom row. What
  // separates a real bar from prose quoting one is POSITION (only the
  // bottom-most non-blank row is read) plus whole-segment structure, never
  // chrome wording — so the rows below deliberately include idle bars, bars with
  // extra segments, and prose that shares the bar's shape.
  const BAR_CASES = [
    { why: "a single shell and monitor", bar: () => statusBar("1 shell, 1 monitor"), activity: { shells: 1, monitors: 1 } },
    { why: "pluralised counts", bar: () => statusBar("3 shells, 2 monitors"), activity: { shells: 3, monitors: 2 } },
    { why: "shells only", bar: () => statusBar("2 shells"), activity: { shells: 2, monitors: 0 } },
    { why: "monitors only", bar: () => statusBar("1 monitor"), activity: { shells: 0, monitors: 1 } },
    { why: "a bar reporting no background work", bar: () => statusBar(null), activity: null },
    {
      why: "an IDLE bar (no 'esc to interrupt'), trailing '← for agents'",
      bar: () => "  ⏵⏵ don't ask on · 2 shells · ← for agents · ↓ to manage",
      activity: { shells: 2, monitors: 0 },
    },
    {
      why: "an IDLE bar whose trailing segment reads '← 1 agent'",
      bar: () => "  ⏵⏵ don't ask on · 1 monitor · ← 1 agent · ↓ to manage",
      activity: { shells: 0, monitors: 1 },
    },
    {
      why: "a bar carrying extra unrelated segments (a PR segment appears once a PR exists)",
      bar: () => "  ⏵⏵ don't ask on · PR #61 · 1 shell, 1 monitor · ← 1 agent · ↓ to manage",
      activity: { shells: 1, monitors: 1 },
    },
    {
      why: "a partly-matching segment (prose sharing the bar's line)",
      bar: () => "  ⏵⏵ don't ask on · about 2 shells maybe · ← for agents",
      activity: null,
    },
    {
      why: "a bare count line that is not an interpunct-separated bar",
      bar: () => "1 shell, 1 monitor",
      activity: null,
    },
  ] as const;

  it("reads the counts off any bar shape, and rejects anything that only looks like one", () => {
    for (const { why, bar, activity } of BAR_CASES) {
      expect(parsePane(paneWithStatusBar(bar())).background_activity, why).toEqual(activity);
    }
  });

  it("ignores the indicator quoted in transcript prose, however close to the bar", () => {
    // Agents DO quote this indicator in prose — the pane this parser was written
    // against contained the literal string "· N shell(s), N monitor". Position
    // alone rejects it. The second group sits directly beneath the composer rule
    // and is the regression guard for STATUS_BAR_LOOKBACK: widening it by even
    // one row turns these into false positives, and a false positive silences a
    // real wait for the whole park window while invisible to the watchdog.
    const above = parsePane(
      paneWithStatusBar(statusBar(null), [
        "⏺ Confirmed the status-bar signal: · 1 shell, 1 monitor · is what renders.",
        "  ⎿  the status-bar '· 2 shells, 3 monitors ·' indicators via parsePane",
        "",
      ]),
    );
    expect(above.background_activity).toBeNull();

    for (const prose of [
      "⏺ Confirmed: · 1 shell, 1 monitor · is what renders.",
      "·-separated segment: ⏵⏵ don't ask on · 3 shells, 2 monitors · esc to interrupt · ↓ to manage.",
    ]) {
      const pane = [RULE, `${DEFFG}❯${NBSP}`, RULE, prose, statusBar(null)].join("\n");
      expect(parsePane(pane).background_activity, prose).toBeNull();
    }
  });

  // KNOWN LIMITATION, pinned deliberately rather than left to be discovered, and
  // kept as its own case so it stays visible rather than buried in a table of
  // correct behaviours. The whole-segment rule does NOT reject prose — these
  // lines really do parse as counts — so if prose ever IS the bottom-most
  // non-blank row, it registers. In a live TUI that cannot happen while the
  // composer and bar are painted, and a worker whose TUI is unpainted is not
  // asking a question either. If this ever needs closing, the fix is a stronger
  // positional/structural anchor (e.g. the row must follow a composer rule or box
  // border) — NOT a chrome-anchor check like "must contain '↓ to manage'", which
  // the second line below defeats.
  it("KNOWN LIMITATION: prose as the bottom-most row is read as a status bar", () => {
    expect(
      parsePane("⏺ Confirmed: · 1 shell, 1 monitor · is what renders.")
        .background_activity,
    ).toEqual({ shells: 1, monitors: 1 });
    expect(
      parsePane(
        "·-separated segment: ⏵⏵ don't ask on · 3 shells, 2 monitors · esc to interrupt · ↓ to manage.",
      ).background_activity,
    ).toEqual({ shells: 3, monitors: 2 });
  });

  it("still reports a permission menu alongside running background work", () => {
    const parsed = parsePane(
      [
        fixture(
          [
            "CORNER_TL DASHES CORNER_TR",
            "PIPE Run the packer build? PIPE",
            "PIPE  PIPE",
            "PIPE CURSOR 1. Yes PIPE",
            "PIPE   2. No PIPE",
            "CORNER_BL DASHES CORNER_BR",
          ].join("\n"),
        ),
        statusBar("1 monitor"),
      ].join("\n"),
    );
    expect(parsed.pending_permission?.options).toEqual([
      { n: 1, label: "Yes" },
      { n: 2, label: "No" },
    ]);
    expect(parsed.background_activity).toEqual({ shells: 0, monitors: 1 });
  });

  it("does not claim the Claude-only indicator for a Codex pane", () => {
    expect(
      parsePane(paneWithStatusBar(statusBar("1 shell, 1 monitor")), "codex")
        .background_activity,
    ).toBeNull();
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
