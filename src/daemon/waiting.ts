/** Hook event kinds that begin a waiting-for-input episode. Keep this shared
 * by hooks, escalation, and Needs You so provider-specific events cannot drift. */
export const WAIT_HOOK_EVENTS = [
  "hook.notification",
  "hook.permissionrequest",
  // Trust/startup prompts appear before provider hooks are available, so the
  // watchdog records the beginning of that wait itself.
  "agent.startup_permission",
] as const;
