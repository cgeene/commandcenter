import { execFile } from "node:child_process";
import { localeEnv } from "./locale.js";

/** Wall-clock cap on one verify command. The Stop-hook handler blocks for this
 *  long in the worst case, so hooks.ts's stall sweep is keyed off it. */
export const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

const VERIFY_MAX_BUFFER = 1024 * 1024;

/**
 * Every setting the daemon reads for itself is CC_-prefixed (see src/config.ts),
 * credentials included: CC_NTFY_TOKEN, CC_JIRA_TOKEN, CC_ANTHROPIC_ADMIN_KEY.
 * The filter denies the prefix instead of naming today's secrets, because a
 * named list goes stale the moment a new one is added — and the failure mode of
 * a stale list is a silently leaked credential.
 */
const DAEMON_ENV_PREFIX = "CC_";

/**
 * Environment for a verify child.
 *
 * A verify_cmd is arbitrary repo code (typically `npm test`) that the daemon
 * spawns from its own process, so an inherited environment hands the operator's
 * real credentials to a whole test suite — and to anything that suite calls.
 * Non-CC_ variables are kept: the command still needs PATH, HOME, the NODE_
 * family and the rest of its toolchain, and a repo's own test prerequisites
 * cannot be enumerated here.
 */
export function verifyEnv(
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (key.startsWith(DAEMON_ENV_PREFIX)) continue;
    filtered[key] = value;
  }
  // Verify output is captured verbatim into events; a C-locale child mangles
  // non-ASCII test output exactly the way it mangles tmux glyphs.
  return localeEnv(filtered);
}

/** Run a task's verify_cmd. Shared by the Stop-hook transition (hooks.ts) and
 *  the freshen pass (freshen.ts) so both spawn with the same filtered env. */
export function runVerifyCommand(
  cmd: string,
  cwd: string,
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      "sh",
      ["-c", cmd],
      {
        cwd,
        env: verifyEnv(),
        timeout: VERIFY_TIMEOUT_MS,
        maxBuffer: VERIFY_MAX_BUFFER,
      },
      (err, stdout, stderr) => {
        resolve({ ok: !err, output: `${stdout}\n${stderr}`.trim() });
      },
    );
  });
}
