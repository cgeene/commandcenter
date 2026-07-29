import { describe, expect, it } from "vitest";
import { softenLineBreaks } from "../src/lib/markdown.js";

describe("softenLineBreaks", () => {
  // A pure string transform: one row per rule. Single newlines become hard
  // breaks so chat-style text renders as written; blank-line paragraph splits
  // and fenced code blocks must survive untouched.
  it("hard-breaks single newlines and leaves paragraphs and code fences alone", () => {
    for (const { why, input, out } of [
      { why: "a single newline", input: "line one\nline two", out: "line one  \nline two" },
      { why: "blank-line-separated paragraphs", input: "para one\n\npara two", out: "para one\n\npara two" },
      { why: "a mix of single and double newlines", input: "a\nb\n\nc\nd", out: "a  \nb\n\nc  \nd" },
      { why: "a backtick-fenced code block", input: "before\n```\nfoo\nbar\n```\nafter", out: "before  \n```\nfoo\nbar\n```\nafter" },
      { why: "a tilde-fenced code block", input: "before\n~~~\nfoo\nbar\n~~~\nafter", out: "before  \n~~~\nfoo\nbar\n~~~\nafter" },
      { why: "a string with no newlines", input: "no newlines here", out: "no newlines here" },
      // Harmless: no line follows to break to.
      { why: "a trailing newline", input: "line one\n", out: "line one  \n" },
      { why: "an already-valid markdown list", input: "1. foo\n2. bar", out: "1. foo  \n2. bar" },
    ]) {
      expect(softenLineBreaks(input), why).toBe(out);
    }
  });
});
