import type { Agent } from "../db/agents.js";
import { mainSessionStarted, resolveMain } from "../daemon/reviewerhealth.js";
import { tmuxSession } from "../config.js";

/**
 * What `cc upgrade --main` should do about the orchestrator, decided separately
 * from doing it so the destructive branch is testable without a tmux server.
 */
export type MainUpgradePlan =
  | { action: "replace"; agent: Agent }
  | { action: "spawn" }
  | { action: "refuse"; reason: string };

/**
 * `killAgent` can only reach a window through `tmux_target`, so a row without
 * one is replaced but never stopped: the upgrade would start a second
 * orchestrator while the first keeps triaging, and the two then compete over the
 * same queue and merges. Refuse instead and say which window to close, since a
 * paneless row cannot be named as a target.
 *
 * The alternative — kill the row and let spawnMain's own guard catch it — does
 * not hold, because the guard sees only what is still live: retiring the paned
 * row first is what makes the shell the last main standing.
 */
export function planMainUpgrade(
  agents: Agent[],
  nowMs = Date.now(),
): MainUpgradePlan {
  const main = resolveMain(agents, nowMs);
  if (!main) return { action: "spawn" };
  if (main.tmux_target) return { action: "replace", agent: main };
  return {
    action: "refuse",
    reason: mainSessionStarted(main)
      ? `main agent a${main.id} is live (${main.state}) and its session started, but its spawn never recorded a pane, so upgrading cannot stop it — find the window named "main" in the ${tmuxSession()} tmux session and close it, then kill a${main.id}, before upgrading`
      : `a main agent spawn (a${main.id}, started ${main.spawned_at}) may still be in flight — retry in a moment, or kill a${main.id} if no spawn is running`,
  };
}
