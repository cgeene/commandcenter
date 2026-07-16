import { describe, expect, it } from "vitest";
import { _tmuxEnvironmentArgsForTest } from "../src/daemon/tmux.js";

describe("tmux pane environment", () => {
  it("passes approved values as pane-scoped tmux environment options", () => {
    expect(
      _tmuxEnvironmentArgsForTest({ TOKEN_B: "two", TOKEN_A: "one" }),
    ).toEqual(["-e", "TOKEN_A=one", "-e", "TOKEN_B=two"]);
  });

  it("rejects invalid names and oversized values", () => {
    expect(() =>
      _tmuxEnvironmentArgsForTest({ "BAD-NAME": "value" }),
    ).toThrow(/invalid pane-scoped environment variable name/);
    expect(() =>
      _tmuxEnvironmentArgsForTest({ TOKEN: "x".repeat(64 * 1024 + 1) }),
    ).toThrow(/invalid pane-scoped environment value/);
  });
});
