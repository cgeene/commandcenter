import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  collectProcessTree,
  escalateSurvivors,
  flushPendingEscalations,
  normalizeTty,
  parseElapsed,
  parseProcessTable,
  selfAncestry,
  snapshotProcesses,
  sweepVanishedPaneGroup,
  terminatePaneTree,
  type ProcRow,
} from "../src/daemon/proctree.js";

// Real processes plus fixed settling delays: the 5s default is not survivable
// under full-suite parallel load.
vi.setConfig({ testTimeout: 30_000 });

function row(
  pid: number,
  ppid: number,
  pgid: number,
  tty = "",
  elapsedSec = 10,
): ProcRow {
  return { pid, ppid, pgid, tty, elapsedSec };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitForExit(pids: number[], timeoutMs = 10_000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const survivors = pids.filter(alive);
    if (survivors.length === 0) return [];
    await new Promise((r) => setTimeout(r, 100));
  }
  return pids.filter(alive);
}

describe("ps parsing", () => {
  it("reads the five-column ps table", () => {
    const rows = parseProcessTable(
      [
        "  501   1  501 ??       03:21",
        "  777 501  777 ttys012  1-02:03:04",
        "  bad line",
        "",
      ].join("\n"),
    );
    expect(rows).toEqual([
      { pid: 501, ppid: 1, pgid: 501, tty: "", elapsedSec: 3 * 60 + 21 },
      {
        pid: 777,
        ppid: 501,
        pgid: 777,
        tty: "ttys012",
        elapsedSec: 86400 + 2 * 3600 + 3 * 60 + 4,
      },
    ]);
  });

  it("treats unparseable elapsed time as infinitely old", () => {
    // The age guard only accepts young processes, so Infinity fails closed.
    expect(parseElapsed("garbage")).toBe(Infinity);
    expect(parseElapsed("12:34")).toBe(754);
  });

  it("normalizes tmux pane_tty and the 'no terminal' spellings", () => {
    expect(normalizeTty("/dev/ttys012")).toBe("ttys012");
    expect(normalizeTty("??")).toBe("");
    expect(normalizeTty("?")).toBe("");
    expect(normalizeTty("")).toBe("");
  });
});

describe("collectProcessTree", () => {
  //  100 pane shell
  //   └ 200 provider  ── 300 setsid'd child (own group 300)
  //                        └ 400 grandchild
  //  500 already reparented to pid 1 but still in the pane's group
  //  900 unrelated
  const procs = [
    row(100, 50, 100, "ttys9"),
    row(200, 100, 100, "ttys9"),
    row(300, 200, 300),
    row(400, 300, 300),
    row(500, 1, 100),
    row(900, 1, 900, "ttys7"),
  ];

  it("walks children transitively, including into a new process group", () => {
    const pids = collectProcessTree([procs[0]], procs, new Set()).map((p) => p.pid);
    expect(pids.sort()).toEqual([100, 200, 300, 400, 500]);
  });

  it("leaves unrelated processes alone", () => {
    const pids = collectProcessTree([procs[0]], procs, new Set()).map((p) => p.pid);
    expect(pids).not.toContain(900);
  });

  it("never returns a protected pid, and never expands its process group", () => {
    // 500 shares the pane's group but is pretend-protected here; protecting it
    // must also stop the walk using group 100 as a bridge.
    const daemon = [row(700, 1, 700), row(701, 700, 700)];
    const withDaemon = [...procs, ...daemon];
    const pids = collectProcessTree(
      [row(200, 100, 700)], // a seed that (impossibly) sits in the daemon's group
      withDaemon,
      new Set([700, 701]),
    ).map((p) => p.pid);
    expect(pids).not.toContain(700);
    expect(pids).not.toContain(701);
  });

  it("picks up strays that kept the pane's tty after being orphaned", () => {
    const orphan = row(600, 1, 600, "ttys9");
    const pids = collectProcessTree(
      [procs[0], orphan],
      [...procs, orphan],
      new Set(),
    ).map((p) => p.pid);
    expect(pids).toContain(600);
  });

  it("refuses to select pid 1", () => {
    expect(collectProcessTree([row(1, 0, 1)], [row(1, 0, 1)], new Set())).toEqual([]);
  });
});

describe("selfAncestry", () => {
  it("protects this process and everything it descends from", () => {
    const ancestry = selfAncestry(snapshotProcesses());
    expect(ancestry.has(process.pid)).toBe(true);
    expect(ancestry.has(process.ppid)).toBe(true);
    expect(ancestry.has(1)).toBe(false);
  });
});

// These drive real processes. The shape mirrors the production leak: a pane
// process spawns a detached child (its own session and process group, no tty),
// which in turn backgrounds a long-running job. Killing only the pane process
// leaves both behind.
describe("terminatePaneTree (real processes)", () => {
  /** Descendants of `root` in a fresh snapshot, `root` itself excluded. */
  const descendants = (root: number): number[] => {
    const children = new Map<number, number[]>();
    for (const p of snapshotProcesses()) {
      const list = children.get(p.ppid);
      if (list) list.push(p.pid);
      else children.set(p.ppid, [p.pid]);
    }
    const out = new Set<number>();
    const queue = [...(children.get(root) ?? [])];
    while (queue.length > 0) {
      const pid = queue.pop()!;
      if (out.has(pid)) continue;
      out.add(pid);
      queue.push(...(children.get(pid) ?? []));
    }
    return [...out];
  };

  it("kills the pane process and its detached descendants", async () => {
    const pane = spawn(
      process.execPath,
      [
        "-e",
        `require('node:child_process').spawn('/bin/sh',['-c','(while :; do sleep 1; done) & sleep 600'],{detached:true,stdio:'ignore'});setTimeout(()=>{},600000)`,
      ],
      { stdio: "ignore" },
    );
    pane.unref();
    const panePid = pane.pid!;
    await new Promise((r) => setTimeout(r, 1200));

    // The detached child is in its own session and process group with no tty,
    // so nothing but the parent link connects it to the pane.
    const strays = descendants(panePid);
    expect(strays.length).toBeGreaterThan(0);

    const killed = terminatePaneTree({ pid: panePid, tty: "" });
    expect(killed).toContain(panePid);
    expect(await waitForExit([panePid, ...strays])).toEqual([]);
  });

  it("SIGKILLs a descendant that ignores SIGTERM", async () => {
    const pane = spawn(
      process.execPath,
      [
        "-e",
        `require('node:child_process').spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});setTimeout(()=>{},600000)`,
      ],
      { stdio: "ignore" },
    );
    pane.unref();
    await new Promise((r) => setTimeout(r, 900));

    const procs = snapshotProcesses();
    const paneRow = procs.find((p) => p.pid === pane.pid)!;
    const tree = collectProcessTree([paneRow], procs, selfAncestry(procs));
    const stubborn = tree.filter((p) => p.pid !== pane.pid);
    expect(stubborn.length).toBeGreaterThan(0);

    terminatePaneTree({ pid: pane.pid!, tty: "" });
    await new Promise((r) => setTimeout(r, 400));
    // The SIGTERM-ignoring child is still up; the scheduled escalation is what
    // finishes it, run here directly rather than waiting out the grace period.
    escalateSurvivors(tree);

    expect(await waitForExit(tree.map((p) => p.pid))).toEqual([]);
  });

  it("does nothing when the pane pid is not a live process", () => {
    expect(terminatePaneTree({ pid: 2_147_483_646, tty: "" })).toEqual([]);
  });

  it("flushes a pending escalation instead of stranding it on shutdown", async () => {
    // If the daemon exits inside the grace window, a SIGTERM-ignoring child
    // would never get its SIGKILL — the exact leak this module prevents.
    const pane = spawn(
      process.execPath,
      [
        "-e",
        `require('node:child_process').spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});setTimeout(()=>{},600000)`,
      ],
      { stdio: "ignore" },
    );
    pane.unref();
    await new Promise((r) => setTimeout(r, 900));

    // A long grace so the timer cannot fire on its own during the test.
    process.env.CC_REAP_GRACE_MS = "600000";
    try {
      const killed = terminatePaneTree({ pid: pane.pid!, tty: "" });
      expect(killed.length).toBeGreaterThan(1);
      await new Promise((r) => setTimeout(r, 400));
      expect(killed.some(alive)).toBe(true); // the SIGTERM-ignoring child

      flushPendingEscalations();
      expect(await waitForExit(killed)).toEqual([]);
    } finally {
      delete process.env.CC_REAP_GRACE_MS;
      flushPendingEscalations();
    }
  });
});

describe("sweepVanishedPaneGroup (real processes)", () => {
  it("kills leftovers still in a dead pane's process group", async () => {
    // `setsid`-equivalent: a detached child leads its own group, and its own
    // children stay in it. That group id is what an agent's recorded pane_pid
    // stands in for once the pane shell itself is gone.
    const leader = spawn("/bin/sh", ["-c", "(while :; do sleep 1; done) & sleep 600"], {
      detached: true,
      stdio: "ignore",
    });
    leader.unref();
    await new Promise((r) => setTimeout(r, 700));
    const pgid = leader.pid!;

    // Simulate the vanished pane: the group leader dies, its children live on.
    process.kill(pgid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 300));
    const orphans = snapshotProcesses().filter((p) => p.pgid === pgid);
    expect(orphans.length).toBeGreaterThan(0);

    const killed = sweepVanishedPaneGroup(pgid, 3600);
    expect(killed.length).toBeGreaterThan(0);
    expect(await waitForExit(killed)).toEqual([]);
  });

  it("ignores a process group older than the agent that supposedly owns it", async () => {
    const leader = spawn("/bin/sh", ["-c", "(while :; do sleep 1; done) & sleep 600"], {
      detached: true,
      stdio: "ignore",
    });
    leader.unref();
    await new Promise((r) => setTimeout(r, 700));
    const pgid = leader.pid!;
    process.kill(pgid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 300));

    // paneAgeSec 0 (+60s slack) still admits these; a negative age never can,
    // which is the pid-reuse guard doing its job.
    expect(sweepVanishedPaneGroup(pgid, -3600)).toEqual([]);
    const spared = snapshotProcesses().filter((p) => p.pgid === pgid);
    expect(spared.length).toBeGreaterThan(0);

    for (const p of spared) {
      try {
        process.kill(p.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    expect(await waitForExit(spared.map((p) => p.pid))).toEqual([]);
  });

  it("declines to sweep a group whose leader is still alive", async () => {
    const leader = spawn("/bin/sh", ["-c", "sleep 600"], {
      detached: true,
      stdio: "ignore",
    });
    leader.unref();
    await new Promise((r) => setTimeout(r, 400));

    expect(sweepVanishedPaneGroup(leader.pid!, 3600)).toEqual([]);
    expect(alive(leader.pid!)).toBe(true);

    process.kill(leader.pid!, "SIGKILL");
  });

  it("rejects nonsense pids", () => {
    expect(sweepVanishedPaneGroup(1, 3600)).toEqual([]);
    expect(sweepVanishedPaneGroup(0, 3600)).toEqual([]);
    expect(sweepVanishedPaneGroup(-5, 3600)).toEqual([]);
  });
});
