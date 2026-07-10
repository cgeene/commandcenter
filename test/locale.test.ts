import { describe, expect, it } from "vitest";
import { localeEnv } from "../src/daemon/locale.js";

describe("localeEnv", () => {
  it("forces a UTF-8 locale when the environment has none (the launchd case)", () => {
    const env = localeEnv({ PATH: "/usr/bin", HOME: "/home/x" });
    expect(env.PATH).toBe("/usr/bin"); // other vars preserved
    expect(env.LANG).toMatch(/utf-?8/i);
    expect(env.LC_CTYPE).toMatch(/utf-?8/i);
  });

  it("sets LC_CTYPE even when LANG names a non-UTF-8 locale", () => {
    const env = localeEnv({ LANG: "C" });
    expect(env.LC_CTYPE).toMatch(/utf-?8/i);
    expect(env.LANG).toMatch(/utf-?8/i);
  });

  it("drops a non-UTF-8 LC_ALL so LC_CTYPE can take effect", () => {
    const env = localeEnv({ LC_ALL: "C", LANG: "C" });
    expect(env.LC_ALL).toBeUndefined();
    expect(env.LC_CTYPE).toMatch(/utf-?8/i);
  });

  it("leaves an already-UTF-8 environment untouched (via LANG)", () => {
    const env = localeEnv({ LANG: "de_DE.UTF-8" });
    expect(env.LANG).toBe("de_DE.UTF-8");
    expect(env.LC_CTYPE).toBeUndefined();
    expect(env.LC_ALL).toBeUndefined();
  });

  it("respects a UTF-8 LC_ALL and does not override it", () => {
    const env = localeEnv({ LC_ALL: "en_GB.UTF-8", LANG: "C" });
    expect(env.LC_ALL).toBe("en_GB.UTF-8");
    expect(env.LANG).toBe("C"); // untouched: LC_ALL already wins for ctype
  });

  it("respects a UTF-8 LC_CTYPE even if LANG is non-UTF-8", () => {
    const env = localeEnv({ LC_CTYPE: "en_US.UTF-8", LANG: "C" });
    expect(env.LC_CTYPE).toBe("en_US.UTF-8");
    expect(env.LANG).toBe("C");
  });

  it("does not mutate the passed-in base environment", () => {
    const base = { LANG: "C" };
    localeEnv(base);
    expect(base).toEqual({ LANG: "C" });
  });
});
