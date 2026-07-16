import { describe, expect, it } from "vitest";
import {
  blockedByChain,
  groupByProject,
  isActive,
  isArchived,
  projectOf,
  type BoardTask,
} from "../src/lib/board.js";

function t(over: Partial<BoardTask> & { id: number }): BoardTask {
  return { status: "queued", repo: "/home/caleb/projects/commandcenter", blocked_by: null, ...over };
}

describe("projectOf", () => {
  it("returns the repo directory basename", () => {
    expect(projectOf("/home/caleb/projects/commandcenter")).toBe("commandcenter");
    expect(projectOf("/opt/src/unicorn-k8s")).toBe("unicorn-k8s");
    expect(projectOf("/a/b/nylas-data-lake/")).toBe("nylas-data-lake"); // trailing slash
  });
});

describe("groupByProject", () => {
  it("groups by repo basename with a done/total rollup, preserving order", () => {
    const tasks = [
      t({ id: 1, repo: "/x/commandcenter", status: "in_progress" }),
      t({ id: 2, repo: "/x/unicorn-k8s", status: "done" }),
      t({ id: 3, repo: "/x/commandcenter", status: "done" }),
      t({ id: 4, repo: "/x/unicorn-k8s", status: "review" }),
    ];
    const groups = groupByProject(tasks);
    expect(groups.map((g) => g.project)).toEqual(["commandcenter", "unicorn-k8s"]);

    const cc = groups[0];
    expect(cc.tasks.map((x) => x.id)).toEqual([1, 3]); // input order kept
    expect(cc.done).toBe(1);
    expect(cc.total).toBe(2);

    const uk = groups[1];
    expect(uk.done).toBe(1);
    expect(uk.total).toBe(2);
  });

  it("groups portfolio and scratch tasks by their semantic workspace", () => {
    const groups = groupByProject([
      t({ id: 1, repo: "/repos", workspace_kind: "portfolio" }),
      t({ id: 2, repo: "/scratch/task-ABC123", workspace_kind: "scratch" }),
      t({ id: 3, repo: "/scratch/task-XYZ789", workspace_kind: "scratch" }),
    ]);
    expect(groups.map((group) => group.project)).toEqual([
      "all repositories",
      "investigations",
    ]);
    expect(groups[1].tasks.map((task) => task.id)).toEqual([2, 3]);
  });
});

describe("isArchived / isActive", () => {
  it("classifies done and cancelled as archived, everything else as active", () => {
    expect(isArchived("done")).toBe(true);
    expect(isArchived("cancelled")).toBe(true);
    for (const s of ["queued", "claimed", "in_progress", "blocked", "review", "failed"]) {
      expect(isArchived(s)).toBe(false);
      expect(isActive(s)).toBe(true);
    }
    expect(isActive("done")).toBe(false);
    expect(isActive("cancelled")).toBe(false);
  });
});

describe("groupByProject with a visible filter", () => {
  const tasks = [
    t({ id: 1, repo: "/x/commandcenter", status: "in_progress" }),
    t({ id: 2, repo: "/x/commandcenter", status: "done" }),
    t({ id: 3, repo: "/x/commandcenter", status: "cancelled" }),
    t({ id: 4, repo: "/x/unicorn-k8s", status: "done" }), // project is all-archived
  ];

  it("hides filtered-out cards but keeps done/total over ALL tasks", () => {
    const groups = groupByProject(tasks, { visible: (x) => isActive(x.status) });
    // unicorn-k8s is entirely archived -> dropped from the active board
    expect(groups.map((g) => g.project)).toEqual(["commandcenter"]);
    const cc = groups[0];
    expect(cc.tasks.map((x) => x.id)).toEqual([1]); // only the active card shows
    expect(cc.done).toBe(1); // rollup still counts the archived done task
    expect(cc.total).toBe(3); // ...and every task in the project
  });

  it("the archive view shows only archived cards", () => {
    const groups = groupByProject(tasks, { visible: (x) => isArchived(x.status) });
    expect(groups.map((g) => g.project)).toEqual(["commandcenter", "unicorn-k8s"]);
    expect(groups[0].tasks.map((x) => x.id)).toEqual([2, 3]);
    expect(groups[1].tasks.map((x) => x.id)).toEqual([4]);
  });

  it("without a filter, behaves exactly as before (all tasks visible)", () => {
    const groups = groupByProject(tasks);
    expect(groups[0].tasks.map((x) => x.id)).toEqual([1, 2, 3]);
    expect(groups[0].total).toBe(3);
  });
});

describe("blockedByChain", () => {
  const byId = (tasks: BoardTask[]) => new Map(tasks.map((x) => [x.id, x] as const));

  it("resolves the blocker one level deep to id + status", () => {
    const tasks = [
      t({ id: 27, status: "review" }),
      t({ id: 28, blocked_by: 27 }),
    ];
    expect(blockedByChain(tasks[1], byId(tasks))).toEqual({ id: 27, status: "review" });
  });

  it("returns null when unblocked", () => {
    const task = t({ id: 5, blocked_by: null });
    expect(blockedByChain(task, byId([task]))).toBeNull();
  });

  it("reports a missing blocker as unknown rather than dropping it", () => {
    const task = t({ id: 6, blocked_by: 99 });
    expect(blockedByChain(task, byId([task]))).toEqual({ id: 99, status: "unknown" });
  });
});
