export interface CodexPermissionPayload {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { command?: unknown; [key: string]: unknown };
}

export interface CodexPermissionDecision {
  behavior: "allow" | "deny";
  message?: string;
}

/** Preserve Command Center's worker publishing boundary for Codex. */
export function codexPermissionDecision(
  payload: CodexPermissionPayload,
  taskId: string | undefined,
  workspaceKind: "repo" | "portfolio" | "scratch" | undefined,
): CodexPermissionDecision | undefined {
  if (
    !["PreToolUse", "PermissionRequest"].includes(payload.hook_event_name ?? "") ||
    payload.tool_name !== "Bash"
  ) {
    return undefined;
  }
  const command = payload.tool_input?.command;
  if (typeof command !== "string" || !taskId || !/^\d+$/.test(taskId)) {
    return undefined;
  }
  const ownPush = new RegExp(
    `^\\s*git\\s+push\\s+(?:-u\\s+)?origin\\s+agent/task-${taskId}\\s*$`,
  );
  if (workspaceKind === "repo" && ownPush.test(command)) {
    return { behavior: "allow" };
  }
  if (/\bgit\b[\s\S]*\bpush\b/i.test(command) || /\bgh\b[\s\S]*\bpr\s+merge\b/i.test(command)) {
    return {
      behavior: "deny",
      message: "Command Center workers may push only their own task branch and may not merge PRs.",
    };
  }
  return undefined;
}
