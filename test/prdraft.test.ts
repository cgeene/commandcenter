import { afterEach, describe, expect, it } from "vitest";

afterEach(async () => {
  const { _setGhRunner } = await import("../src/daemon/prdraft.js");
  _setGhRunner(null);
});

describe("markPrReady", () => {
  it("runs `gh pr ready` and leaves a clean title untouched", async () => {
    const { markPrReady, _setGhRunner } = await import("../src/daemon/prdraft.js");
    const calls: string[][] = [];
    _setGhRunner(async (args) => {
      calls.push(args);
      return args[1] === "view" ? "feat: ship it" : "";
    });
    await markPrReady("https://github.com/x/y/pull/1");
    expect(calls[0]).toEqual(["pr", "ready", "https://github.com/x/y/pull/1"]);
    // clean title -> no edit call
    expect(calls.some((a) => a[1] === "edit")).toBe(false);
  });

  it("strips an [UNREVIEWED] prefix via `gh pr edit`", async () => {
    const { markPrReady, _setGhRunner } = await import("../src/daemon/prdraft.js");
    const calls: string[][] = [];
    _setGhRunner(async (args) => {
      calls.push(args);
      return args[1] === "view" ? "[UNREVIEWED] feat: ship it" : "";
    });
    await markPrReady("https://github.com/x/y/pull/1");
    const edit = calls.find((a) => a[1] === "edit");
    expect(edit).toEqual([
      "pr",
      "edit",
      "https://github.com/x/y/pull/1",
      "--title",
      "feat: ship it",
    ]);
  });

  it("propagates a gh failure so the caller can surface it", async () => {
    const { markPrReady, _setGhRunner } = await import("../src/daemon/prdraft.js");
    _setGhRunner(async () => {
      throw new Error("draft not supported");
    });
    await expect(markPrReady("https://github.com/x/y/pull/1")).rejects.toThrow(
      /draft not supported/,
    );
  });
});

describe("markPrDraft", () => {
  it("runs `gh pr ready --undo`", async () => {
    const { markPrDraft, _setGhRunner } = await import("../src/daemon/prdraft.js");
    const calls: string[][] = [];
    _setGhRunner(async (args) => {
      calls.push(args);
      return "";
    });
    await markPrDraft("https://github.com/x/y/pull/2");
    expect(calls[0]).toEqual(["pr", "ready", "--undo", "https://github.com/x/y/pull/2"]);
  });
});
