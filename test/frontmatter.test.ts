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

  it("leaves a doc with no frontmatter alone", () => {
    const doc = "# Just a heading\n\nno metadata here.";
    expect(hasFrontmatter(doc)).toBe(false);
    expect(stripFrontmatter(doc)).toBe(doc);
    expect(parseFrontmatter(doc).data).toEqual({});
  });

  it("does not treat a `---` horizontal rule in prose as frontmatter", () => {
    const doc = "Intro paragraph.\n\n---\n\nAfter the rule.";
    expect(hasFrontmatter(doc)).toBe(false);
    expect(stripFrontmatter(doc)).toBe(doc);
  });

  it("strips an empty frontmatter block", () => {
    const doc = "---\n---\nbody text";
    expect(hasFrontmatter(doc)).toBe(true);
    expect(stripFrontmatter(doc)).toBe("body text");
  });

  it("preserves a body that itself contains `---` separators", () => {
    const fm = emitFrontmatter([["title", "T"]]);
    const body = "line one\n\n---\n\nline two";
    expect(stripFrontmatter(fm + body)).toBe(body);
  });
});
