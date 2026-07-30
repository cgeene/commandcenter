import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-main-upgrade-"));
  process.env.CC_DATA_DIR = tmpDir;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("planMainUpgrade", () => {
  it("replaces the orchestrator that holds a pane, not an older empty row", async () => {
    // More than one live main row is ordinary: a spawn interrupted before
    // attachPane leaves one behind and nothing retires it. Resolving by row
    // order would pick that shell, and killing it stops nothing.
    const { planMainUpgrade } = await import("../src/cli/mainupgrade.js");
    const { createAgent } = await import("../src/db/agents.js");

    createAgent({ kind: "main", provider: "claude", state: "stalled" });
    const real = createAgent({
      kind: "main",
      provider: "claude",
      model: "fable",
      state: "idle",
      tmux_target: "cc:@9",
    });

    expect(planMainUpgrade([...(await listLive())])).toEqual({
      action: "replace",
      agent: expect.objectContaining({ id: real.id, model: "fable" }),
    });
  });

  it("refuses rather than replacing a paneless main whose session came up", async () => {
    // THE destructive outcome: killAgent reaches a window only through
    // tmux_target, so replacing this row would leave its orchestrator running
    // while a second one starts, and the two then fight over triage and merges.
    const { planMainUpgrade } = await import("../src/cli/mainupgrade.js");
    const { createAgent } = await import("../src/db/agents.js");
    const { logEvent } = await import("../src/db/events.js");

    const unclaimed = createAgent({ kind: "main", provider: "claude", state: "spawning" });
    logEvent("hook.sessionstart", { agentId: unclaimed.id });

    const plan = planMainUpgrade([...(await listLive())]);
    expect(plan.action).toBe("refuse");
    expect(plan).toMatchObject({
      reason: expect.stringContaining("never recorded a pane"),
    });
  });

  it("refuses while another spawn may still be in flight, then spawns once it cannot be", async () => {
    const { planMainUpgrade } = await import("../src/cli/mainupgrade.js");
    const { createAgent } = await import("../src/db/agents.js");

    const inFlight = createAgent({ kind: "main", provider: "claude", state: "spawning" });
    const spawnedMs = Date.parse(inFlight.spawned_at);

    expect(planMainUpgrade([...(await listLive())], spawnedMs + 1_000)).toMatchObject({
      action: "refuse",
      reason: expect.stringContaining("may still be in flight"),
    });
    // Nothing ever answered for the row, so it is not an orchestrator and
    // spawnMain retires it on the way past.
    expect(planMainUpgrade([...(await listLive())], spawnedMs + 61_000)).toEqual({
      action: "spawn",
    });
  });

  it("spawns when there is no main row at all", async () => {
    const { planMainUpgrade } = await import("../src/cli/mainupgrade.js");
    expect(planMainUpgrade([])).toEqual({ action: "spawn" });
  });

  it("ignores a dead main row", async () => {
    const { planMainUpgrade } = await import("../src/cli/mainupgrade.js");
    const { createAgent, updateAgent } = await import("../src/db/agents.js");
    const gone = createAgent({
      kind: "main",
      provider: "claude",
      state: "idle",
      tmux_target: "cc:@9",
    });
    updateAgent(gone.id, { state: "dead" });

    // The CLI asks for live rows, but the predicate must not depend on that.
    const { listAgents } = await import("../src/db/agents.js");
    expect(planMainUpgrade(listAgents())).toEqual({ action: "spawn" });
  });
});

/** What the CLI passes in: whatever `GET /api/agents?live=true` returned. */
async function listLive() {
  const { listAgents } = await import("../src/db/agents.js");
  return listAgents({ live: true });
}
