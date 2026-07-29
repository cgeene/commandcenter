import { describe, expect, it } from "vitest";
import { openPanel, panelKey, type Panel } from "../src/lib/panel.js";

describe("panelKey", () => {
  // Identity is (kind, target): two panels collide only if both match, which is
  // what makes the toggle below fire on a repeat click and not on a sibling.
  it("keys a panel by its kind and target, and null for a closed one", () => {
    expect(panelKey(null)).toBeNull();
    expect(panelKey({ kind: "task", id: 7 })).toBe("task:7");
    expect(panelKey({ kind: "terminal", agentId: 3 })).toBe("terminal:3");
    expect(panelKey({ kind: "transcript", sessionId: "abc" })).toBe("transcript:abc");
    // same kind, different target
    expect(panelKey({ kind: "task", id: 7 })).not.toBe(panelKey({ kind: "task", id: 8 }));
    // different kind, same numeric target
    expect(panelKey({ kind: "task", id: 5 })).not.toBe(panelKey({ kind: "terminal", agentId: 5 }));
  });
});

describe("openPanel", () => {
  // One panel at a time: a click on a different panel replaces, a click on the
  // one already open closes it.
  it("replaces any other panel and toggles the one already open", () => {
    for (const { why, current, clicked, out } of [
      { why: "nothing open yet", current: null, clicked: { kind: "task", id: 1 }, out: { kind: "task", id: 1 } },
      { why: "a different kind is open", current: { kind: "task", id: 1 }, clicked: { kind: "terminal", agentId: 9 }, out: { kind: "terminal", agentId: 9 } },
      { why: "the same kind on a different target", current: { kind: "terminal", agentId: 2 }, clicked: { kind: "terminal", agentId: 4 }, out: { kind: "terminal", agentId: 4 } },
      { why: "a repeat click on the open task panel", current: { kind: "task", id: 3 }, clicked: { kind: "task", id: 3 }, out: null },
      { why: "a repeat click on the open terminal", current: { kind: "terminal", agentId: 6 }, clicked: { kind: "terminal", agentId: 6 }, out: null },
      { why: "the same kind but a different id does NOT toggle", current: { kind: "task", id: 3 }, clicked: { kind: "task", id: 4 }, out: { kind: "task", id: 4 } },
    ] as const) {
      expect(openPanel(current as Panel | null, clicked as Panel), why).toEqual(out);
    }
  });
});
