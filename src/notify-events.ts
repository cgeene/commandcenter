/**
 * The catalog of push (ntfy) notification events.
 *
 * Every notify() call site in the daemon belongs to exactly one event here, and
 * every event has a default: push or don't. The default set is deliberately
 * tiny — a push should mean "a human has to do something now", not "something
 * happened". Anything the platform resolves by itself (a task entering the
 * automatic review loop, a worker waiting on the orchestrator, a task closing
 * out after a human merge) is off by default and stays visible in the dashboard
 * feed instead.
 *
 * Dependency-free on purpose (like providers.ts / publication.ts): the settings
 * layer, the daemon, and the web UI all read it, so it must not import either
 * the DB or config.
 */

/** Grouping for the Settings UI, in display order. */
export type NotifyCategory = "action" | "platform" | "info";

export const NOTIFY_CATEGORIES: {
  key: NotifyCategory;
  label: string;
  blurb: string;
}[] = [
  {
    key: "action",
    label: "Needs you now",
    blurb: "Nothing moves until you do something. On by default.",
  },
  {
    key: "platform",
    label: "Platform health",
    blurb: "The platform itself is degraded. On by default.",
  },
  {
    key: "info",
    label: "Informational",
    blurb:
      "Progress the platform handles on its own. Off by default — the dashboard feed already shows it.",
  },
];

export const NOTIFY_EVENT_KEYS = [
  // --- action: a human is the only thing that can move this forward ---
  "review_approved_ready",
  "task_blocked",
  "task_failed",
  "review_exhausted",
  "escalation",
  "pr_state_mismatch",
  // --- platform health ---
  "daemon_stale_build",
  "quota_threshold",
  "quota_spend_limit",
  // --- informational ---
  "task_review_entered",
  "task_completed",
  "worker_stalled",
  "sync_broken",
  "capacity_or_budget",
  "window_report",
] as const;

export type NotifyEventKey = (typeof NOTIFY_EVENT_KEYS)[number];

export interface NotifyEventSpec {
  key: NotifyEventKey;
  category: NotifyCategory;
  /** Short name shown in Settings. */
  label: string;
  /** What actually triggers it, and what it asks of the reader. */
  description: string;
  /** Push unless the operator says otherwise. */
  default_enabled: boolean;
}

export const NOTIFY_EVENTS: Record<NotifyEventKey, NotifyEventSpec> = {
  review_approved_ready: {
    key: "review_approved_ready",
    category: "action",
    label: "Reviewed & approved — ready for you",
    description:
      "The internal adversarial review approved the work AND the PR is open and out of draft, so it is genuinely mergeable. This is the push that replaced the old “entered review” one. For human-publication tasks it fires when the approved working tree is waiting for you to commit and push.",
    default_enabled: true,
  },
  task_blocked: {
    key: "task_blocked",
    category: "action",
    label: "Task blocked",
    description:
      "A task stopped and cannot restart itself: its spawn failed, its verification failed repeatedly, or its PR was closed without merging.",
    default_enabled: true,
  },
  task_failed: {
    key: "task_failed",
    category: "action",
    label: "Task failed",
    description: "A task gave up for good — its worker vanished twice.",
    default_enabled: true,
  },
  review_exhausted: {
    key: "review_exhausted",
    category: "action",
    label: "Review loop exhausted",
    description:
      "The automatic review⇄fix loop used up its rounds without converging (the reject cycle cap). The task is blocked on your decision.",
    default_enabled: true,
  },
  escalation: {
    key: "escalation",
    category: "action",
    label: "Escalated past the orchestrator",
    description:
      "Something reached you because the orchestrator could not handle it: the escalate tool, the watchdog page for a worker nobody unblocked, a provider trust/startup prompt, or the orchestrator's own prompt being jammed.",
    default_enabled: true,
  },
  pr_state_mismatch: {
    key: "pr_state_mismatch",
    category: "action",
    label: "PR draft/ready state is wrong",
    description:
      "A `gh pr ready` (or `--undo`) failed, so GitHub's draft state no longer matches the internal verdict. Needs a manual fix or an un-reviewed PR looks mergeable.",
    default_enabled: true,
  },
  daemon_stale_build: {
    key: "daemon_stale_build",
    category: "platform",
    label: "Daemon running stale code",
    description:
      "dist/ was rebuilt after the daemon started, so every change since then is silently not running.",
    default_enabled: true,
  },
  quota_threshold: {
    key: "quota_threshold",
    category: "platform",
    label: "Usage quota threshold crossed",
    description:
      "Live Claude usage crossed the alert threshold in Settings → Usage. Fires on the crossing, not on every poll: it re-arms when the rate-limit window rolls over or utilization drops back below the line.",
    default_enabled: true,
  },
  quota_spend_limit: {
    key: "quota_spend_limit",
    category: "platform",
    label: "Spend limit reached",
    description:
      "Extra-usage spending hit its cap. Agents start failing mid-task until the cap is raised or the cycle rolls over.",
    default_enabled: true,
  },
  task_review_entered: {
    key: "task_review_entered",
    category: "info",
    label: "Task entered automatic review",
    description:
      "A worker finished and the task moved to `review`. The automatic reviewer runs next — you are not needed unless it approves or blocks.",
    default_enabled: false,
  },
  task_completed: {
    key: "task_completed",
    category: "info",
    label: "Task completed",
    description:
      "A task reached `done` — its PR merged, or an approved no-PR task closed out. Nothing is asked of you.",
    default_enabled: false,
  },
  worker_stalled: {
    key: "worker_stalled",
    category: "info",
    label: "Agent stalled or vanished",
    description:
      "An agent went silent, failed to initialize, vanished (and was requeued), or stopped without producing a result/verdict. The scheduler retries and, if it truly cannot recover, the task ends up blocked or failed — which pushes on its own.",
    default_enabled: false,
  },
  sync_broken: {
    key: "sync_broken",
    category: "info",
    label: "PR / JIRA sync failing",
    description:
      "Repeated GitHub or JIRA sync failures for one task. Board state goes stale, but no work is lost.",
    default_enabled: false,
  },
  capacity_or_budget: {
    key: "capacity_or_budget",
    category: "info",
    label: "Scheduler capacity or budget hit",
    description:
      "Autonomous spawning paused: the daily spawn budget is spent, all worker slots are taken, or a review was skipped for budget.",
    default_enabled: false,
  },
  window_report: {
    key: "window_report",
    category: "info",
    label: "Scheduler window report",
    description: "The end-of-window task tally.",
    default_enabled: false,
  },
};

/** Catalog as a list, in NOTIFY_EVENT_KEYS order — what the API serves. */
export const NOTIFY_EVENT_LIST: NotifyEventSpec[] = NOTIFY_EVENT_KEYS.map(
  (k) => NOTIFY_EVENTS[k],
);

/** The built-in on/off per event — the minimal set, before any override. */
export const NOTIFY_EVENT_DEFAULTS: Record<NotifyEventKey, boolean> =
  Object.fromEntries(
    NOTIFY_EVENT_KEYS.map((k) => [k, NOTIFY_EVENTS[k].default_enabled]),
  ) as Record<NotifyEventKey, boolean>;

export function isNotifyEventKey(value: unknown): value is NotifyEventKey {
  return (
    typeof value === "string" &&
    (NOTIFY_EVENT_KEYS as readonly string[]).includes(value)
  );
}
