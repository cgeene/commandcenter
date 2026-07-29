/**
 * Is THIS process the daemon?
 *
 * Everything under src/ is a plain library: the test suite, one-off `node -e`
 * probes, dist-driving verification scripts, the MCP server and the CLI all
 * import the same modules the daemon does. Any of them can therefore reach code
 * that talks to the outside world (ntfy pushes, JIRA writes) with fixture data.
 * Modules that dispatch externally ask this first and no-op when the answer is
 * no; only `daemon/index.ts` answers yes, by calling `markDaemonProcess()` at
 * boot.
 *
 * Deliberately NOT an environment variable and NOT NODE_ENV: child processes
 * inherit the environment, and the daemon runs the platform's own commands as
 * children (`runVerify` execs a task's verify_cmd — typically `npm test` — with
 * the daemon's env), so an env marker would hand daemon authority straight to
 * every test run. A module-scoped flag cannot cross a process boundary.
 */
let daemon = false;

/** Claim daemon authority for this process. Call once, first thing at boot,
 *  before anything can dispatch. Nothing else may call this. */
export function markDaemonProcess(): void {
  daemon = true;
}

export function isDaemonProcess(): boolean {
  return daemon;
}
