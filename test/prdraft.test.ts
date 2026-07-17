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

/** A tiny in-memory PR whose title survives across gh view/edit/ready calls, so
 *  we can compose enforcePrTitle and markPrReady and observe the final title. */
function ghTitleStore(initial: string) {
  const state = { title: initial, edits: 0 };
  const runner = async (args: string[]): Promise<string> => {
    if (args[1] === "view") return `${state.title}\n`;
    if (args[1] === "edit") {
      state.title = args[4];
      state.edits++;
    }
    return ""; // covers `gh pr ready` and `gh pr edit` (no stdout)
  };
  return { state, runner };
}

const URL = "https://github.com/x/y/pull/1";

describe("enforcePrTitle", () => {
  it("prepends [KEY-N] to a clean title", async () => {
    const { enforcePrTitle, _setGhRunner } = await import("../src/daemon/prdraft.js");
    const { state, runner } = ghTitleStore("feat: ship it");
    _setGhRunner(runner);
    await enforcePrTitle(URL, "EN-7");
    expect(state.title).toBe("[EN-7] feat: ship it");
    expect(state.edits).toBe(1);
  });

  it("is a no-op when the title already carries the right key (running twice)", async () => {
    const { enforcePrTitle, _setGhRunner } = await import("../src/daemon/prdraft.js");
    const { state, runner } = ghTitleStore("feat: ship it");
    _setGhRunner(runner);
    await enforcePrTitle(URL, "EN-7");
    await enforcePrTitle(URL, "EN-7"); // second run
    expect(state.title).toBe("[EN-7] feat: ship it");
    expect(state.edits).toBe(1); // only the first run edited
  });

  it("heals a stale/wrong key (strip-then-prepend)", async () => {
    const { enforcePrTitle, _setGhRunner } = await import("../src/daemon/prdraft.js");
    const { state, runner } = ghTitleStore("[EN-999] feat: ship it");
    _setGhRunner(runner);
    await enforcePrTitle(URL, "EN-7");
    expect(state.title).toBe("[EN-7] feat: ship it");
  });

  it("preserves an [UNREVIEWED] marker (that prefix is markPrReady's, not ours)", async () => {
    const { enforcePrTitle, _setGhRunner } = await import("../src/daemon/prdraft.js");
    const { state, runner } = ghTitleStore("[UNREVIEWED] feat: ship it");
    _setGhRunner(runner);
    await enforcePrTitle(URL, "EN-7");
    expect(state.title).toBe("[EN-7] [UNREVIEWED] feat: ship it");
  });

  it("propagates a gh failure so the caller records it against the sync streak", async () => {
    const { enforcePrTitle, _setGhRunner } = await import("../src/daemon/prdraft.js");
    _setGhRunner(async () => {
      throw new Error("gh down");
    });
    await expect(enforcePrTitle(URL, "EN-7")).rejects.toThrow(/gh down/);
  });
});

describe("enforcePrTitle + markPrReady compose (disjoint prefixes, both orders)", () => {
  it("retitle then markReady → [KEY-N] <base>", async () => {
    const { enforcePrTitle, markPrReady, _setGhRunner } = await import(
      "../src/daemon/prdraft.js"
    );
    const { state, runner } = ghTitleStore("[UNREVIEWED] feat: ship it");
    _setGhRunner(runner);
    await enforcePrTitle(URL, "EN-7"); // → [EN-7] [UNREVIEWED] feat: ship it
    expect(state.title).toBe("[EN-7] [UNREVIEWED] feat: ship it");
    await markPrReady(URL); // strips [UNREVIEWED], keeps [EN-7]
    expect(state.title).toBe("[EN-7] feat: ship it");
  });

  it("markReady then retitle → [KEY-N] <base> (same final title)", async () => {
    const { enforcePrTitle, markPrReady, _setGhRunner } = await import(
      "../src/daemon/prdraft.js"
    );
    const { state, runner } = ghTitleStore("[UNREVIEWED] feat: ship it");
    _setGhRunner(runner);
    await markPrReady(URL); // → feat: ship it
    expect(state.title).toBe("feat: ship it");
    await enforcePrTitle(URL, "EN-7"); // → [EN-7] feat: ship it
    expect(state.title).toBe("[EN-7] feat: ship it");
  });
});
