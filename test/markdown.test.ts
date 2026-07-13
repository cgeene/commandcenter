import { describe, expect, it } from "vitest";
import { softenLineBreaks } from "../src/lib/markdown.js";

describe("softenLineBreaks", () => {
  it("turns a single newline into a hard break", () => {
    expect(softenLineBreaks("line one\nline two")).toBe("line one  \nline two");
  });

  it("leaves blank-line-separated paragraphs alone", () => {
    const input = "para one\n\npara two";
    expect(softenLineBreaks(input)).toBe(input);
  });

  it("handles a mix of single and double newlines", () => {
    const input = "a\nb\n\nc\nd";
    expect(softenLineBreaks(input)).toBe("a  \nb\n\nc  \nd");
  });

  it("does not touch content inside fenced code blocks", () => {
    const input = "before\n```\nfoo\nbar\n```\nafter";
    expect(softenLineBreaks(input)).toBe("before  \n```\nfoo\nbar\n```\nafter");
  });

  it("does not touch content inside tilde-fenced code blocks", () => {
    const input = "before\n~~~\nfoo\nbar\n~~~\nafter";
    expect(softenLineBreaks(input)).toBe("before  \n~~~\nfoo\nbar\n~~~\nafter");
  });

  it("leaves a trailing newline-free string unchanged", () => {
    expect(softenLineBreaks("no newlines here")).toBe("no newlines here");
  });

  it("softens a trailing newline too (harmless — no line follows to break to)", () => {
    expect(softenLineBreaks("line one\n")).toBe("line one  \n");
  });

  it("is a no-op on an already-valid markdown list", () => {
    const input = "1. foo\n2. bar";
    expect(softenLineBreaks(input)).toBe("1. foo  \n2. bar");
  });
});
