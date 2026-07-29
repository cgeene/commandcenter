import { describe, expect, it } from "vitest";
import {
  WORKER_FILED_PRIORITY_FLOOR,
  grantTaskPriority,
} from "../src/lib/task-priority.js";

describe("grantTaskPriority", () => {
  // One row per rule. A worker may never outrank its own task and never beat the
  // low-priority floor (task #177: a worker filed its own follow-up at the head
  // of the queue while its parent work sat at 2). Everyone else keeps full
  // control, and an absent priority must stay absent so createTask's own default
  // and portfolio-parent inheritance still apply.
  it("grants a worker at most the floor, and leaves everyone else alone", () => {
    for (const { why, args, out } of [
      { why: "an urgent worker request", args: { creatorKind: "worker", requested: 1, filerTaskPriority: 2 }, out: { priority: 3, requested: 1, clamped: true } },
      { why: "a worker trying to match its own task at 0", args: { creatorKind: "worker", requested: 0, filerTaskPriority: 0 }, out: { priority: 3, requested: 0, clamped: true } },
      { why: "no request at all", args: { creatorKind: "worker", filerTaskPriority: 2 }, out: { priority: WORKER_FILED_PRIORITY_FLOOR, requested: undefined, clamped: false } },
      { why: "a filer whose own priority is lower than the floor", args: { creatorKind: "worker", filerTaskPriority: 4 }, out: { priority: 4, requested: undefined, clamped: false } },
      { why: "a request more urgent than that lower filer", args: { creatorKind: "worker", requested: 2, filerTaskPriority: 4 }, out: { priority: 4, requested: 2, clamped: true } },
      { why: "a request less urgent than the floor (granted as asked)", args: { creatorKind: "worker", requested: 4, filerTaskPriority: 2 }, out: { priority: 4, requested: 4, clamped: false } },
      { why: "a filing worker with no task of its own", args: { creatorKind: "worker", requested: 1, filerTaskPriority: null }, out: { priority: 3, requested: 1, clamped: true } },
      { why: "a filing worker with neither task nor request", args: { creatorKind: "worker" }, out: { priority: 3, requested: undefined, clamped: false } },
    ] as const) {
      expect(grantTaskPriority(args as never), why).toEqual(out);
    }

    // main / reviewer / human submissions are never clamped.
    for (const creatorKind of ["main", "reviewer", null, undefined] as const) {
      expect(grantTaskPriority({ creatorKind, requested: 0 }), String(creatorKind)).toEqual({
        priority: 0,
        requested: 0,
        clamped: false,
      });
    }
  });

  it("keeps the floor less urgent than the createTask default", () => {
    // A worker-filed follow-up must queue behind ordinary priority-2 work.
    expect(WORKER_FILED_PRIORITY_FLOOR).toBeGreaterThan(2);
  });
});
