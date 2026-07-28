import { describe, expect, it } from "vitest";
import {
  WORKER_FILED_PRIORITY_FLOOR,
  grantTaskPriority,
} from "../src/lib/task-priority.js";

describe("grantTaskPriority", () => {
  it("clamps an urgent worker request down to the low-priority floor", () => {
    // The task #177 case: worker files its own follow-up at the head of the
    // queue while its parent work sits at 2.
    expect(
      grantTaskPriority({
        creatorKind: "worker",
        requested: 1,
        filerTaskPriority: 2,
      }),
    ).toEqual({ priority: 3, requested: 1, clamped: true });
  });

  it("never lets a worker outrank its own task", () => {
    expect(
      grantTaskPriority({ creatorKind: "worker", requested: 0, filerTaskPriority: 0 }),
    ).toEqual({ priority: 3, requested: 0, clamped: true });
  });

  it("files a worker follow-up at the floor when no priority is requested", () => {
    expect(
      grantTaskPriority({ creatorKind: "worker", filerTaskPriority: 2 }),
    ).toEqual({
      priority: WORKER_FILED_PRIORITY_FLOOR,
      requested: undefined,
      clamped: false,
    });
  });

  it("keeps a worker follow-up at its filer's priority when that is lower", () => {
    expect(
      grantTaskPriority({ creatorKind: "worker", filerTaskPriority: 4 }),
    ).toEqual({ priority: 4, requested: undefined, clamped: false });
    expect(
      grantTaskPriority({ creatorKind: "worker", requested: 2, filerTaskPriority: 4 }),
    ).toEqual({ priority: 4, requested: 2, clamped: true });
  });

  it("lets a worker file something less urgent than the floor", () => {
    expect(
      grantTaskPriority({ creatorKind: "worker", requested: 4, filerTaskPriority: 2 }),
    ).toEqual({ priority: 4, requested: 4, clamped: false });
  });

  it("falls back to the floor when the filing worker has no task", () => {
    expect(
      grantTaskPriority({ creatorKind: "worker", requested: 1, filerTaskPriority: null }),
    ).toEqual({ priority: 3, requested: 1, clamped: true });
    expect(grantTaskPriority({ creatorKind: "worker" })).toEqual({
      priority: 3,
      requested: undefined,
      clamped: false,
    });
  });

  it("leaves the orchestrator, reviewers, and humans in full control", () => {
    for (const creatorKind of ["main", "reviewer", null, undefined] as const) {
      expect(grantTaskPriority({ creatorKind, requested: 0 })).toEqual({
        priority: 0,
        requested: 0,
        clamped: false,
      });
      // An absent priority must stay absent so createTask's own default (and
      // portfolio-parent inheritance upstream) still applies.
      expect(grantTaskPriority({ creatorKind })).toEqual({
        priority: undefined,
        requested: undefined,
        clamped: false,
      });
    }
  });

  it("keeps the floor less urgent than the createTask default", () => {
    // A worker-filed follow-up must queue behind ordinary priority-2 work.
    expect(WORKER_FILED_PRIORITY_FLOOR).toBeGreaterThan(2);
  });
});
