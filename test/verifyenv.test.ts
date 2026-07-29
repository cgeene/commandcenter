import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runVerifyCommand, verifyEnv } from "../src/daemon/verifyenv.js";

/** Sentinels, not the ambient environment: the daemon's real credentials come
 *  and go from its plist, so an assertion that reads process.env for them can
 *  pass merely because the operator unset one. */
const SECRETS = {
  CC_NTFY_URL: "https://ntfy.example/SENTINEL-ntfy-topic",
  CC_NTFY_TOKEN: "SENTINEL-ntfy-token",
  CC_JIRA_TOKEN: "SENTINEL-jira-token",
  CC_ANTHROPIC_ADMIN_KEY: "SENTINEL-admin-key",
  CC_LIVE_USAGE: "1",
};

const KEPT = { VERIFY_TEST_KEEP: "SENTINEL-kept-value" };

const saved = new Map<string, string | undefined>();

function injectIntoProcessEnv(vars: Record<string, string>): void {
  for (const [key, value] of Object.entries(vars)) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    process.env[key] = value;
  }
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

describe("verifyEnv", () => {
  it("strips the daemon's credentials and keeps everything else", () => {
    const env = verifyEnv({ ...SECRETS, ...KEPT, PATH: "/usr/bin", HOME: "/home/x" });

    for (const key of Object.keys(SECRETS)) expect(env[key]).toBeUndefined();
    expect(Object.values(env)).not.toContain(SECRETS.CC_JIRA_TOKEN);
    expect(env.VERIFY_TEST_KEEP).toBe(KEPT.VERIFY_TEST_KEEP);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/x");
  });

  it("strips every environment variable config.ts reads, including ones added later", () => {
    const configSrc = fs.readFileSync(
      fileURLToPath(new URL("../src/config.ts", import.meta.url)),
      "utf8",
    );
    const names = [...configSrc.matchAll(/process\.env\.([A-Za-z0-9_]+)/g)].map(
      (m) => m[1],
    );
    expect(names.length).toBeGreaterThan(10); // the scan actually found readers

    const base = Object.fromEntries(names.map((n) => [n, `SENTINEL-${n}`]));
    const env = verifyEnv(base);
    expect(Object.keys(env).filter((k) => names.includes(k))).toEqual([]);
  });

  it("still resolves the child's locale to UTF-8", () => {
    const env = verifyEnv({ PATH: "/usr/bin" });
    expect(env.LC_CTYPE ?? env.LANG).toMatch(/utf-?8/i);
  });
});

describe("runVerifyCommand", () => {
  const cwd = os.tmpdir(); // nothing is written; the commands only read env

  it("runs the command with an environment the credentials never reach", async () => {
    injectIntoProcessEnv({ ...SECRETS, ...KEPT });

    const { ok, output } = await runVerifyCommand("env", cwd);
    expect(ok).toBe(true);

    // The child really did inherit an environment — without this the absence
    // of the secrets below would prove nothing.
    expect(output).toContain(`VERIFY_TEST_KEEP=${KEPT.VERIFY_TEST_KEEP}`);
    expect(output.split("\n").filter((l) => l.startsWith("CC_"))).toEqual([]);
    for (const value of Object.values(SECRETS)) {
      if (value === "1") continue; // too short to grep for meaningfully
      expect(output).not.toContain(value);
    }
  });

  it("gives the child a UTF-8 locale", async () => {
    const { output } = await runVerifyCommand(
      'printf "%s\\n" "${LC_ALL:-${LC_CTYPE:-$LANG}}"',
      cwd,
    );
    expect(output.trim()).toMatch(/utf-?8/i);
  });

  it("reports a failing command", async () => {
    const { ok, output } = await runVerifyCommand("echo boom >&2; false", cwd);
    expect(ok).toBe(false);
    expect(output).toContain("boom");
  });
});
