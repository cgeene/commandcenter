import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  countExternalSuites,
  isTestRunnerCommand,
  parseCommandTable,
  snapshotCommands,
  type CommandRow,
} from "../src/daemon/suiteload.js";

/**
 * The verify semaphore only sees the runs the daemon starts. This module counts
 * the ones it does not — a worker or reviewer running the suite in its own pane
 * — so a contended failure stays attributable.
 *
 * The command shapes asserted below were taken from a real `ps` during an
 * `npm test` on this platform, not invented.
 */

/** A pid that cannot be an ancestor of anything here, standing in for a daemon
 *  unrelated to the process running these tests. */
const FOREIGN_PID = 2 ** 30;

function row(
  pid: number,
  ppid: number,
  pgid: number,
  command: string,
): CommandRow {
  return { pid, ppid, pgid, command };
}

describe("parseCommandTable", () => {
  it("reads padded ps output and keeps argv spacing", () => {
    const rows = parseCommandTable(
      [
        "  98424 98422 98422 npm test  ",
        "  98446 98424 98422 node (vitest)  ",
        "  98600 98446 98422 node (vitest 1)     ",
      ].join("\n"),
    );
    expect(rows).toEqual([
      row(98424, 98422, 98422, "npm test"),
      row(98446, 98424, 98422, "node (vitest)"),
      row(98600, 98446, 98422, "node (vitest 1)"),
    ]);
  });

  it("skips blank and malformed lines rather than inventing rows", () => {
    expect(parseCommandTable("\n\n  PID PPID PGID COMMAND\nnonsense\n")).toEqual(
      [],
    );
  });

  it("keeps a command containing many spaces intact", () => {
    const [only] = parseCommandTable("  1 2 3 sh -c 'a  b   c'");
    expect(only.command).toBe("sh -c 'a  b   c'");
  });
});

describe("isTestRunnerCommand", () => {
  it("recognises the shapes a real suite presents", () => {
    for (const cmd of [
      "npm test",
      "npm run test",
      "yarn test",
      "pnpm run test",
      "node (vitest)",
      "node (vitest 7)",
      "npx vitest run",
      "/repo/node_modules/.bin/vitest run",
      "jest --ci",
    ]) {
      expect(isTestRunnerCommand(cmd), cmd).toBe(true);
    }
  });

  it("does not count a command that merely mentions a runner", () => {
    for (const cmd of [
      "grep -rn vitest src/",
      "rg --files-with-matches 'npm test'",
      "vim test/vitest.config.ts",
      "tail -f npm-test.log",
      // The wrapper an agent's shell command arrives inside. It need not match:
      // the npm and vitest processes it forks share its process group.
      "/bin/zsh -c source /home/u/.claude/snapshot.sh && eval 'npm test > out.log'",
      "",
      "   ",
    ]) {
      expect(isTestRunnerCommand(cmd), cmd).toBe(false);
    }
  });

  it("does not mistake another npm script for the suite", () => {
    expect(isTestRunnerCommand("npm run build")).toBe(false);
    expect(isTestRunnerCommand("npm run test:watch")).toBe(true);
  });
});

describe("countExternalSuites", () => {
  /** One agent pane running `npm test`: a wrapper, npm, vitest, two workers —
   *  five processes, one process group, one suite. */
  function paneSuite(base: number): CommandRow[] {
    return [
      row(base, 500, base, "/bin/zsh -c eval 'npm test'"),
      row(base + 1, base, base, "npm test"),
      row(base + 2, base + 1, base, "node (vitest)"),
      row(base + 3, base + 2, base, "node (vitest 1)"),
      row(base + 4, base + 2, base, "node (vitest 2)"),
    ];
  }

  it("collapses one suite's whole process group into a single count", () => {
    expect(countExternalSuites(paneSuite(1000), FOREIGN_PID)).toBe(1);
  });

  it("counts concurrent suites separately", () => {
    const procs = [...paneSuite(1000), ...paneSuite(2000), ...paneSuite(3000)];
    expect(countExternalSuites(procs, FOREIGN_PID)).toBe(3);
  });

  it("sees nothing when no suite is running", () => {
    const procs = [
      row(10, 1, 10, "/usr/sbin/syspolicyd"),
      row(11, 1, 11, "node /repo/dist/daemon/index.js"),
    ];
    expect(countExternalSuites(procs, 11)).toBe(0);
  });

  it("excludes the verify run the daemon itself spawned", () => {
    const daemon = row(700, 1, 700, "node /repo/dist/daemon/index.js");
    const procs = [
      daemon,
      row(701, 700, 700, "sh -c npm test"),
      row(702, 701, 700, "npm test"),
      row(703, 702, 700, "node (vitest)"),
      ...paneSuite(1000),
    ];
    // The agent's pane suite is the only thing the semaphore cannot see.
    expect(countExternalSuites(procs, daemon.pid)).toBe(1);
  });

  it("excludes the suite the caller is itself running inside", () => {
    // The daemon's code under `vitest`: the caller IS a worker fork, and its
    // siblings are its own context rather than competitors.
    const procs = [
      row(900, 1, 900, "npm test"),
      row(901, 900, 900, "node (vitest)"),
      row(902, 901, 900, "node (vitest 1)"),
      row(903, 901, 900, "node (vitest 2)"),
    ];
    expect(countExternalSuites(procs, 902)).toBe(0);
    // ...but a different agent's suite still counts.
    expect(countExternalSuites([...procs, ...paneSuite(2000)], 902)).toBe(1);
  });

  it("reports nothing when ps gave nothing back", () => {
    expect(countExternalSuites([], 700)).toBe(0);
  });
});

describe("observing real processes", () => {
  let child: ChildProcess | undefined;

  afterEach(() => {
    child?.kill("SIGKILL");
    child = undefined;
  });

  async function waitForRow(pid: number): Promise<CommandRow> {
    // Polled precondition, not a timing assertion: node has to boot and set its
    // process title before `ps` can show it. The bound makes a broken
    // expectation fail rather than hang.
    for (let attempt = 0; attempt < 200; attempt++) {
      const found = snapshotCommands().find((p) => p.pid === pid);
      if (found && isTestRunnerCommand(found.command)) return found;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`pid ${pid} never appeared in ps as a test runner`);
  }

  it("finds a real vitest-titled process in ps and attributes it correctly", async () => {
    // A real process wearing the process title vitest gives its workers. Its
    // own process group (detached) is what a separate agent's suite would have.
    //
    // The timer is a bound, not a delay. A runner killed outright never reaches
    // the `afterEach` above, and this process is indistinguishable from a real
    // foreign suite by design — stranded, it would make every later
    // countExternalSuites() report contention that is not there.
    child = spawn(
      process.execPath,
      ["-e", 'process.title = "node (vitest 99)"; setTimeout(() => {}, 600000)'],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    const pid = child.pid!;

    const found = await waitForRow(pid);
    expect(found.pgid).toBe(pid);

    // A daemon that has nothing to do with this process counts it...
    expect(countExternalSuites([found], FOREIGN_PID)).toBe(1);
    // ...and the process that spawned it does not: it is its own verify child.
    expect(countExternalSuites([found], process.pid)).toBe(0);
  });
});
