import { describe, expect, it } from "vitest";
import { openPanel, panelKey, type Panel } from "../src/lib/panel.js";

describe("panelKey", () => {
  it("returns null for a closed panel", () => {
    expect(panelKey(null)).toBeNull();
  });

  it("keys each panel kind by its target identity", () => {
    expect(panelKey({ kind: "task", id: 7 })).toBe("task:7");
    expect(panelKey({ kind: "terminal", agentId: 3 })).toBe("terminal:3");
    expect(panelKey({ kind: "transcript", sessionId: "abc" })).toBe("transcript:abc");
  });

  it("distinguishes same kind with different targets", () => {
    expect(panelKey({ kind: "task", id: 7 })).not.toBe(panelKey({ kind: "task", id: 8 }));
  });

  it("distinguishes different kinds with the same numeric target", () => {
    expect(panelKey({ kind: "task", id: 5 })).not.toBe(panelKey({ kind: "terminal", agentId: 5 }));
  });
});

describe("openPanel", () => {
  it("opens a panel when nothing is open", () => {
    expect(openPanel(null, { kind: "task", id: 1 })).toEqual({ kind: "task", id: 1 });
  });

  it("replaces a different panel — one at a time, last click wins", () => {
    const current: Panel = { kind: "task", id: 1 };
    expect(openPanel(current, { kind: "terminal", agentId: 9 })).toEqual({
      kind: "terminal",
      agentId: 9,
    });
  });

  it("replaces a same-kind panel targeting a different id", () => {
    const current: Panel = { kind: "terminal", agentId: 2 };
    expect(openPanel(current, { kind: "terminal", agentId: 4 })).toEqual({
      kind: "terminal",
      agentId: 4,
    });
  });

  it("toggles closed when the already-open panel's control is clicked again", () => {
    const current: Panel = { kind: "task", id: 3 };
    expect(openPanel(current, { kind: "task", id: 3 })).toBeNull();
  });

  it("toggles the terminal closed on a repeat click of the same agent", () => {
    const current: Panel = { kind: "terminal", agentId: 6 };
    expect(openPanel(current, { kind: "terminal", agentId: 6 })).toBeNull();
  });

  it("does not toggle when kind matches but target differs", () => {
    const current: Panel = { kind: "task", id: 3 };
    expect(openPanel(current, { kind: "task", id: 4 })).not.toBeNull();
  });
});
