import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-escalate-"));
  process.env.CC_DATA_DIR = tmpDir;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const noopDeps = {
  spawn: () => {},
  windowIds: () => [] as string[],
  now: () => new Date(),
};

async function backdateLatest(kind: string, minutesAgo: number) {
  const { getDb } = await import("../src/db/db.js");
  getDb()
    .prepare(
      "UPDATE events SET ts = ? WHERE id = (SELECT MAX(id) FROM events WHERE kind = ?)",
    )
    .run(new Date(Date.now() - minutesAgo * 60_000).toISOString(), kind);
}

describe("waiting_input delegation", () => {
  it("Notification with no live main leaves no delegation marker", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { createAgent, getAgent } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    const worker = createAgent({ kind: "worker", state: "working" });
    await handleHookEvent(worker.id, {
      hook_event_name: "Notification",
      message: "permission?",
    });
    expect(getAgent(worker.id)?.state).toBe("waiting_input");
    expect(listEvents(10).map((e) => e.kind)).not.toContain("waiting.delegated");
  });

  it("a main sitting on its own prompt is never used for delegation", async () => {
    const { handleHookEvent } = await import("../src/daemon/hooks.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { listEvents } = await import("../src/db/events.js");
    createAgent({ kind: "main", state: "waiting_input", tmux_target: "cc:@99" });
    const worker = createAgent({ kind: "worker", state: "working" });
    await handleHookEvent(worker.id, { hook_event_name: "Notification" });
    expect(listEvents(10).map((e) => e.kind)).not.toContain("waiting.delegated");
  });
});

describe("watchdog escalation", () => {
  it("pages the human once when a wait outlives escalate_minutes", async () => {
    const { watchdog } = await import("../src/daemon/scheduler.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { logEvent, listEvents } = await import("../src/db/events.js");
    const worker = createAgent({ kind: "worker", state: "waiting_input" });
    logEvent("hook.notification", { agentId: worker.id });
    await backdateLatest("hook.notification", 10); // default escalate_minutes = 5

    watchdog(noopDeps);
    watchdog(noopDeps); // second pass must not re-page
    const escalations = listEvents(20).filter((e) => e.kind === "waiting.escalated");
    expect(escalations.length).toBe(1);
    expect(escalations[0].agent_id).toBe(worker.id);
  });

  it("does not page before the deadline", async () => {
    const { watchdog } = await import("../src/daemon/scheduler.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { logEvent, listEvents } = await import("../src/db/events.js");
    const worker = createAgent({ kind: "worker", state: "waiting_input" });
    logEvent("hook.notification", { agentId: worker.id });
    await backdateLatest("hook.notification", 2);

    watchdog(noopDeps);
    expect(listEvents(20).map((e) => e.kind)).not.toContain("waiting.escalated");
  });

  it("pages for an overdue Codex PermissionRequest wait", async () => {
    const { watchdog } = await import("../src/daemon/scheduler.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { logEvent, listEvents } = await import("../src/db/events.js");
    const worker = createAgent({
      kind: "worker",
      provider: "codex",
      state: "waiting_input",
    });
    logEvent("hook.permissionrequest", { agentId: worker.id });
    await backdateLatest("hook.permissionrequest", 10);

    watchdog(noopDeps);
    expect(listEvents(20).map((event) => event.kind)).toContain("waiting.escalated");
  });

  it("a fresh wait after rescue is a new escalation episode", async () => {
    const { watchdog } = await import("../src/daemon/scheduler.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { logEvent, listEvents } = await import("../src/db/events.js");
    const worker = createAgent({ kind: "worker", state: "waiting_input" });
    logEvent("hook.notification", { agentId: worker.id });
    await backdateLatest("hook.notification", 20);
    watchdog(noopDeps); // episode 1 escalates
    await backdateLatest("waiting.escalated", 15);

    logEvent("hook.notification", { agentId: worker.id }); // new wait...
    await backdateLatest("hook.notification", 10); // ...also overdue
    watchdog(noopDeps); // episode 2 escalates again
    const escalations = listEvents(30).filter((e) => e.kind === "waiting.escalated");
    expect(escalations.length).toBe(2);
  });
});
