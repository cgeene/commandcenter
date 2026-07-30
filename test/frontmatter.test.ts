import { describe, expect, it } from "vitest";
import {
  emitFrontmatter,
  hasFrontmatter,
  parseFrontmatter,
  stripFrontmatter,
} from "../src/lib/frontmatter.js";

describe("frontmatter emit/parse", () => {
  it("round-trips scalars and a string list", () => {
    const fm = emitFrontmatter([
      ["title", "Cost: Data Inventory"],
      ["project", "cogs"],
      ["tags", ["billing", "gcp", "gke-cost-allocation"]],
      ["summary", "billing export is live"],
      ["task_id", 34],
      ["version", 2],
    ]);
    const doc = fm + "# Body\n\nprose.";
    const { data, body } = parseFrontmatter(doc);
    expect(data.title).toBe("Cost: Data Inventory");
    expect(data.project).toBe("cogs");
    expect(data.tags).toEqual(["billing", "gcp", "gke-cost-allocation"]);
    expect(data.summary).toBe("billing export is live");
    expect(data.task_id).toBe("34");
    expect(data.version).toBe("2");
    expect(body).toBe("# Body\n\nprose.");
  });

  it("quotes values that would break plain YAML and unquotes them back", () => {
    const fm = emitFrontmatter([
      ["colon", "a: b"],
      ["hash", "trailing # comment"],
      ["numberish", "007"],
      ["boolish", "true"],
      ["quote", 'she said "hi"'],
      ["empty", ""],
    ]);
    expect(fm).toContain('colon: "a: b"');
    expect(fm).toContain('numberish: "007"');
    expect(fm).toContain('boolish: "true"');
    const { data } = parseFrontmatter(fm + "body");
    expect(data.colon).toBe("a: b");
    expect(data.hash).toBe("trailing # comment");
    expect(data.numberish).toBe("007");
    expect(data.boolish).toBe("true");
    expect(data.quote).toBe('she said "hi"');
    expect(data.empty).toBe("");
  });

  // One table because every row asks the same two questions of a different
  // document: does this count as frontmatter, and what survives stripping it.
  // Only the `---` runs move between rows — a block delimiter has to be told
  // apart from a horizontal rule in prose, at the top of the doc and inside it.
  const DETECTION_CASES = [
    {
      why: "a doc with no frontmatter is left alone, and parses to no data",
      doc: () => "# Just a heading\n\nno metadata here.",
      hasFm: false,
      stripped: "# Just a heading\n\nno metadata here.",
      data: {},
    },
    {
      why: "a `---` horizontal rule in prose is not frontmatter",
      doc: () => "Intro paragraph.\n\n---\n\nAfter the rule.",
      hasFm: false,
      stripped: "Intro paragraph.\n\n---\n\nAfter the rule.",
    },
    {
      why: "an empty frontmatter block is still a block, and strips away",
      doc: () => "---\n---\nbody text",
      hasFm: true,
      stripped: "body text",
    },
    {
      why: "stripping stops at the closing delimiter, keeping `---` in the body",
      doc: () => emitFrontmatter([["title", "T"]]) + "line one\n\n---\n\nline two",
      hasFm: true,
      stripped: "line one\n\n---\n\nline two",
    },
  ] as const;

  it("tells a frontmatter block apart from a `---` rule, and strips only the block", () => {
    for (const c of DETECTION_CASES) {
      const doc = c.doc();
      expect(hasFrontmatter(doc), c.why).toBe(c.hasFm);
      expect(stripFrontmatter(doc), c.why).toBe(c.stripped);
      if ("data" in c) expect(parseFrontmatter(doc).data, c.why).toEqual(c.data);
    }
  });
});
