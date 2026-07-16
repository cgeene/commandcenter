import { getAgent, listAgents, type Agent } from "../db/agents.js";
import { latestTaskEvent, logEvent } from "../db/events.js";
import { getTask, readyTasks, type Task } from "../db/tasks.js";
import { mainPromptClear } from "./notifqueue.js";
import { resumeAgent } from "./resume.js";
import { windowExists } from "./tmux.js";

function availableMain(preferred?: Agent): Agent | undefined {
  const candidates = preferred ? [preferred] : listAgents({ live: true });
  return candidates.find(
    (agent) =>
      agent.kind === "main" &&
      ["working", "idle"].includes(agent.state) &&
      agent.tmux_target !== null &&
      windowExists(agent.tmux_target),
  );
}

function taskPrompt(task: Task): string {
  return `[commandcenter] New human-submitted task #${task.id} is awaiting your triage (workspace_kind=${task.workspace_kind}). Call get_task(${task.id}), study its full prompt, validate the scope and execution settings, then dispatch it. For portfolio tasks, never spawn the parent: mark it in_progress, use list_repositories, create per-repository child tasks with parent_task_id=${task.id}, preserve the parent's selected provider/model/reasoning effort unless you deliberately document an override, and spawn those isolated children. For scratch tasks, spawn the task directly and review its result/transcript rather than expecting a Git diff.`;
}

/** Deliver a newly-created orchestrated task to Claude main, or leave it queued. */
export async function delegateTaskToMain(
  taskId: number,
  preferredMain?: Agent,
): Promise<boolean> {
  const task = getTask(taskId);
  if (!task || task.dispatch_mode !== "orchestrated" || task.status !== "queued") {
    return false;
  }
  if (!readyTasks("orchestrated").some((candidate) => candidate.id === task.id)) {
    return false;
  }
  const main = availableMain(preferredMain);
  if (!main) {
    logEvent("task.awaiting_main", { taskId });
    return false;
  }
  // Never merge the triage prompt into the human's mid-typed draft or fire it
  // mid-turn: deliver only when the main is idle with a genuinely clear prompt.
  // Otherwise leave the task queued — the main's idle/Stop hooks and the
  // scheduler's periodic delegatePendingTaskToLiveMain retry it.
  if (!main.tmux_target || main.state !== "idle" || !mainPromptClear(main.tmux_target)) {
    logEvent("task.awaiting_main", {
      taskId,
      payload: { main_agent_id: main.id, reason: "main_prompt_busy" },
    });
    return false;
  }
  const outcome = await resumeAgent(main.id, taskPrompt(task));
  if (outcome !== "sent") {
    logEvent("task.awaiting_main", { taskId, payload: { main_agent_id: main.id } });
    return false;
  }
  logEvent("task.delegated_to_main", {
    taskId,
    agentId: main.id,
    payload: { workspace_kind: task.workspace_kind },
  });
  return true;
}

/** On main startup/idle, re-deliver the oldest task that still needs triage. */
export async function delegatePendingTaskToMain(main: Agent): Promise<boolean> {
  if (!availableMain(main)) return false;
  const pending = readyTasks("orchestrated").filter((task) => {
    const delegated = latestTaskEvent(task.id, ["task.delegated_to_main"]);
    return !delegated || delegated.agent_id !== main.id;
  });
  const task = pending[0];
  return task ? delegateTaskToMain(task.id, main) : false;
}

/** Periodic recovery for tasks that become ready after a blocker completes. */
export async function delegatePendingTaskToLiveMain(): Promise<boolean> {
  const main = availableMain();
  return main ? delegatePendingTaskToMain(main) : false;
}

export function pendingOrchestratedTasks(): Task[] {
  return readyTasks("orchestrated");
}
