import { describe, expect, it } from "vitest";
import {
  blockedByChain,
  groupByProject,
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
