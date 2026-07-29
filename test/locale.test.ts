import { describe, expect, it } from "vitest";
import { localeEnv } from "../src/daemon/locale.js";

const UTF8 = /utf-?8/i;

describe("localeEnv", () => {
  // The rule: the child must end up with a UTF-8 ctype, without overriding a
  // UTF-8 locale the operator already set. LC_ALL outranks LC_CTYPE outranks
  // LANG, so a non-UTF-8 LC_ALL has to be dropped rather than left to win.
  it("guarantees a UTF-8 ctype without overriding one already set", () => {
    for (const { why, base, expect: want } of [
      {
        // the launchd case: no locale at all in the environment
        why: "an environment with no locale",
        base: { PATH: "/usr/bin", HOME: "/home/x" },
        expect: { PATH: "/usr/bin", LANG: UTF8, LC_CTYPE: UTF8 },
      },
      { why: "LANG naming a non-UTF-8 locale", base: { LANG: "C" }, expect: { LANG: UTF8, LC_CTYPE: UTF8 } },
      {
        why: "a non-UTF-8 LC_ALL, which must be dropped so LC_CTYPE can take effect",
        base: { LC_ALL: "C", LANG: "C" },
        expect: { LC_ALL: undefined, LC_CTYPE: UTF8 },
      },
      {
        why: "an already-UTF-8 LANG (left completely alone)",
        base: { LANG: "de_DE.UTF-8" },
        expect: { LANG: "de_DE.UTF-8", LC_CTYPE: undefined, LC_ALL: undefined },
      },
      {
        // LC_ALL already wins for ctype, so LANG needs no correction
        why: "a UTF-8 LC_ALL",
        base: { LC_ALL: "en_GB.UTF-8", LANG: "C" },
        expect: { LC_ALL: "en_GB.UTF-8", LANG: "C" },
      },
      {
        why: "a UTF-8 LC_CTYPE even with a non-UTF-8 LANG",
        base: { LC_CTYPE: "en_US.UTF-8", LANG: "C" },
        expect: { LC_CTYPE: "en_US.UTF-8", LANG: "C" },
      },
    ] as const) {
      const env = localeEnv({ ...base }) as Record<string, string | undefined>;
      for (const [key, want2] of Object.entries(want)) {
        if (want2 instanceof RegExp) expect(env[key], `${why}: ${key}`).toMatch(want2);
        else expect(env[key], `${why}: ${key}`).toBe(want2);
      }
    }
  });

  it("does not mutate the passed-in base environment", () => {
    const base = { LANG: "C" };
    localeEnv(base);
    expect(base).toEqual({ LANG: "C" });
  });
});
