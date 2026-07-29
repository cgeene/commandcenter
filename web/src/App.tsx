import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { api } from "./api";
import {
  blockedByChain,
  groupByProject,
  isActive,
  isArchived,
  projectOfTask,
} from "../../src/lib/board";
import { openPanel, type Panel } from "../../src/lib/panel";
import { parseFrontmatter } from "../../src/lib/frontmatter";
import { softenLineBreaks } from "../../src/lib/markdown";
import { jiraChip } from "../../src/lib/jira";
import {
  canNotifyMain,
  canSpawnWorker,
  delegateOutcomeNote,
  type NoteTone,
} from "../../src/lib/taskactions";
import {
  syncAppBadge,
  newlyArrivedIds,
  browserAlertsEnabled,
  setBrowserAlerts,
} from "../../src/lib/app-attention";
import { Terminal } from "./Terminal";
import { orgCycleSpend as orgCycleSpendFor, resetsIn } from "../../src/lib/usage";
import { projectedCycleSpend } from "../../src/lib/pricing";
import type {
  Agent,
  AppSettings,
  AttentionItem,
  UsageMeter,
  UsagePayload,
  CronJob,
  Doc,
  DocWithContent,
  Event,
  JiraConfig,
  JiraMeta,
  JiraRepoConfig,
  Memory,
  ParsedPane,
  ProviderModel,
  ReasoningEffort,
  SchedulerConfig,
  SchedulerInfo,
  Task,
  TaskSession,
  TranscriptEntry,
  WorkspaceCatalog,
  WorkspaceKind,
} from "./types";

/** Dashboard tabs — add an entry here + a render branch in App to grow the dashboard. */
const TABS = [
  { id: "dashboard", label: "Dashboard" },
  { id: "board", label: "Board" },
  { id: "prs", label: "PRs" },
  { id: "docs", label: "Docs" },
  { id: "tokens", label: "Tokens" },
  { id: "archive", label: "Archive" },
  { id: "settings", label: "Settings" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const ALL_REASONING_LEVELS: Array<{
  effort: ReasoningEffort;
  description: string;
}> = [
  { effort: "low", description: "Fast responses with lighter reasoning" },
  { effort: "medium", description: "Balanced speed and reasoning depth" },
  { effort: "high", description: "Default; greater depth for complex work" },
  { effort: "xhigh", description: "Extra-high depth for difficult multi-step work" },
  { effort: "max", description: "Maximum depth for the hardest problems" },
  { effort: "ultra", description: "Maximum reasoning with automatic delegation" },
];

const BASE_REASONING_LEVELS = ALL_REASONING_LEVELS.filter((level) =>
  ["low", "medium", "high", "xhigh"].includes(level.effort),
);

/** A task-linked PR still awaiting action — merged/closed ones auto-clear. */
function isOpenPr(t: Task): boolean {
  return (
    !!t.pr_url &&
    t.open_pr !== 0 &&
    t.pr_state !== "merged" &&
    t.pr_state !== "closed"
  );
}

function tabFromHash(): TabId {
  const h = window.location.hash.replace(/^#\//, "");
  return TABS.some((t) => t.id === h) ? (h as TabId) : "board";
}

/**
 * On phones the virtual keyboard overlays the page without resizing it
 * (especially iOS Safari), hiding the bottom of fixed-position drawers.
 * Track the visual viewport and, when a keyboard is plausibly open, return
 * a style that pins the drawer to the *visible* area — the terminal then
 * re-fits and the input line lands just above the keyboard.
 */
function useKeyboardAwareStyle(): CSSProperties | undefined {
  const [style, setStyle] = useState<CSSProperties | undefined>(undefined);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const covered = window.innerHeight - vv.height - vv.offsetTop;
      if (covered > 80) {
        setStyle({ top: vv.offsetTop, height: vv.height, bottom: "auto" });
      } else {
        setStyle(undefined);
      }
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  return style;
}

const STATE_COLORS: Record<string, string> = {
  working: "#68d982",
  idle: "#8d96a6",
  waiting_input: "#f3b95f",
  spawning: "#7aa7ff",
  stalled: "#ff6b6b",
  dead: "#3b4658",
};

/**
 * Human-readable labels for the task-status enum. The enum values themselves
 * are load-bearing (className hooks, logic comparisons) so they're never
 * changed — this map is display-only, applied wherever a status is shown to a
 * person. Sentence case, with the underscore variant spelled out.
 */
const STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  claimed: "Claimed",
  in_progress: "In progress",
  blocked: "Blocked",
  review: "Review",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

function statusText(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

/** Human-readable label for a live agent's runtime state (see STATE_COLORS). */
const AGENT_STATE_LABEL: Record<string, string> = {
  working: "working",
  idle: "idle",
  waiting_input: "waiting for input",
  spawning: "spawning",
  stalled: "stalled",
  dead: "dead",
};

export function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [panes, setPanes] = useState<Record<number, ParsedPane>>({});
  const [events, setEvents] = useState<Event[]>([]);
  const [attention, setAttention] = useState<AttentionItem[]>([]);
  // One side panel at a time: task detail, terminal, or transcript. A single
  // union means any panel-opening click replaces whatever's open, so panels
  // can never stack. The heavier transcript payload lives in `transcript`,
  // keyed off the active panel's sessionId.
  const [panel, setPanel] = useState<Panel>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[] | null>(null);
  const [expandedAgentId, setExpandedAgentId] = useState<number | null>(null);
  const [showNewTask, setShowNewTask] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [showCrons, setShowCrons] = useState(false);
  const [scheduler, setScheduler] = useState<SchedulerInfo | null>(null);
  const [jiraMeta, setJiraMeta] = useState<JiraMeta>({
    base_url: "https://nylas.atlassian.net",
    enabled_repos: [],
  });
  const [stale, setStale] = useState(false);
  // Flips true after the first successful poll, so the attention notifier seeds
  // from real data instead of the empty pre-load render (which would make the
  // whole existing backlog look "new" and fire a burst of notifications).
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTabState] = useState<TabId>(tabFromHash);
  const { usage, refresh: refreshUsage, refreshing: refreshingUsage } = useUsage();
  const keyboardStyle = useKeyboardAwareStyle();

  const setTab = (t: TabId) => {
    window.location.hash = `/${t}`; // hashchange listener updates state
  };
  useEffect(() => {
    const onHash = () => setTabState(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // JIRA chip metadata (browse base URL + enabled repos) changes rarely — fetch
  // once on mount, best-effort. A failure just leaves the defaults; it must
  // never break the hot task/agent refresh loop below.
  useEffect(() => {
    api<JiraMeta>("GET", "/api/jira/meta")
      .then(setJiraMeta)
      .catch(() => {});
  }, []);

  // Every panel-opening control routes through openPanel: opening one closes
  // whatever was open (last click wins), and re-clicking the same control
  // toggles it closed.
  const openTask = (id: number) => setPanel((cur) => openPanel(cur, { kind: "task", id }));
  const openTerminal = (agentId: number) =>
    setPanel((cur) => openPanel(cur, { kind: "terminal", agentId }));
  const openTranscript = async (sessionId: string, provider: "claude" | "codex") => {
    const r = await api<{ entries: TranscriptEntry[] }>(
      "GET",
      `/api/transcript/${sessionId}?provider=${provider}`,
    );
    setTranscript(r.entries);
    setPanel((cur) => openPanel(cur, { kind: "transcript", sessionId }));
  };
  const closePanel = () => setPanel(null);

  const refresh = useCallback(async () => {
    try {
      const [t, a, e, s, at] = await Promise.all([
        api<Task[]>("GET", "/api/tasks"),
        api<Agent[]>("GET", "/api/agents?live=true"),
        api<Event[]>("GET", "/api/events?narrated=true&limit=30"),
        api<SchedulerInfo>("GET", "/api/scheduler"),
        api<AttentionItem[]>("GET", "/api/attention"),
      ]);
      setTasks(t);
      setAgents(a);
      setEvents(e);
      setScheduler(s);
      setAttention(at);
      setLoaded(true); // first real poll landed — safe to seed the notifier now

      // Waiting agents need their pane parsed so the card can show what
      // they're asking without opening the terminal.
      const waiting = a.filter((x) => x.state === "waiting_input");
      const paneEntries = await Promise.all(
        waiting.map(async (x): Promise<[number, ParsedPane] | null> => {
          try {
            return [x.id, await api<ParsedPane>("GET", `/api/agents/${x.id}/pane`)];
          } catch {
            return null;
          }
        }),
      );
      setPanes(
        Object.fromEntries(paneEntries.filter((e): e is [number, ParsedPane] => e !== null)),
      );
    } catch {
      /* daemon briefly unreachable — keep last state */
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 2500);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    const check = () =>
      api<{ stale: boolean }>("GET", "/api/version")
        .then((v) => setStale(v.stale))
        .catch(() => {});
    check();
    const id = setInterval(check, 60_000);
    return () => clearInterval(id);
  }, []);

  // Mirror the "Needs You" count onto the installed PWA's app icon (dock /
  // taskbar / home screen) via the Badging API — the same count as the board
  // tab badge. It updates only while the app window is running (backgrounded is
  // fine); a fully-quit app can't refresh its badge without a service worker +
  // push, which this manifest-only PWA deliberately omits. Best-effort: a
  // rejected badge call must never surface to the operator.
  useEffect(() => {
    syncAppBadge(navigator, attention.length)?.catch(() => {});
  }, [attention.length]);

  // Bounce the dock icon once per newly-arrived attention item by posting a
  // system notification. `seenAttention` tracks the ids we've already alerted
  // on. It's seeded only once `loaded` is true (the first successful poll), so
  // the pre-load empty render never seeds it and the existing backlog doesn't
  // all alert on open. Keyed on the id set (+ loaded), so it re-runs when
  // membership changes, not on every 2.5s poll returning the same items.
  const seenAttention = useRef<Set<string> | null>(null);
  // "\n"-joined: ids can't contain a newline, so distinct id sets never collide
  // into one key (a comma could, if an id ever embedded one).
  const attentionIdKey = attention.map((a) => a.id).join("\n");
  useEffect(() => {
    if (!loaded) return; // wait for real data before seeding (see comment above)
    const ids = attention.map((a) => a.id);
    const fresh = newlyArrivedIds(seenAttention.current, ids);
    seenAttention.current = new Set(ids);
    if (
      fresh.length === 0 ||
      typeof Notification === "undefined" ||
      Notification.permission !== "granted" ||
      !browserAlertsEnabled(localStorage, true) // permission already granted here
    ) {
      return;
    }
    const first = attention.find((a) => a.id === fresh[0]);
    const body =
      fresh.length === 1 && first ? first.title : `${fresh.length} items need you`;
    try {
      // Shared tag replaces (rather than stacks) a prior unread banner; each
      // call still raises a fresh alert, which is what bounces the dock icon.
      new Notification("commandcenter — Needs You", { body, tag: "cc-attention" });
    } catch {
      /* Notification constructor unavailable (e.g. some mobile browsers) */
    }
    // attentionIdKey captures the attention state we read; loaded gates seeding.
  }, [attentionIdKey, loaded]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      setError(null);
      await fn();
      await refresh();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  // The task drawer reads from the live `tasks` list by id, so it always
  // reflects the latest poll (no stale copy to re-sync); if the task vanishes
  // the drawer simply closes.
  const selTask = panel?.kind === "task" ? (tasks.find((t) => t.id === panel.id) ?? null) : null;

  const liveMain = agents.find((a) => a.kind === "main" && a.state !== "dead");
  const taskAgents = new Map<number, Agent[]>();
  for (const agent of agents) {
    if (agent.kind === "main" || agent.task_id == null || agent.state === "dead") continue;
    const list = taskAgents.get(agent.task_id) ?? [];
    list.push(agent);
    taskAgents.set(agent.task_id, list);
  }
  // Nav badge: open PRs the reviewer has approved and are now waiting on a
  // human merge — the one state that most wants Caleb's attention.
  const prsAwaitingMerge = tasks.filter(
    (t) => isOpenPr(t) && t.review_verdict === "approve",
  ).length;
  const tabBadge: Partial<Record<TabId, number>> = {
    board: attention.length,
    prs: prsAwaitingMerge,
  };
  const runningCount = tasks.filter((t) => t.status === "in_progress").length;
  const queuedCount = tasks.filter((t) => ["queued", "claimed"].includes(t.status)).length;
  const blockedCount = tasks.filter((t) => t.status === "blocked").length;
  const failedCount = tasks.filter((t) => t.status === "failed").length;
  const reviewCount = tasks.filter((t) => t.status === "review").length;
  const activeProjectCount = new Set(
    tasks.filter((t) => isActive(t.status)).map((t) => projectOfTask(t)),
  ).size;

  return (
    <div className="app">
      <div className="app-shell">
        <aside className="nav-rail">
          <div className="brand-lockup">
            <span className="brand-mark">CC</span>
            <div>
              <h1>Command Center</h1>
              <span>Mission Control</span>
            </div>
          </div>
          <nav className="tabs" aria-label="Primary">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={tab === t.id ? "active" : ""}
                onClick={() => setTab(t.id)}
              >
                <span>{t.label}</span>
                {(tabBadge[t.id] ?? 0) > 0 && (
                  <span className="tab-badge">{tabBadge[t.id]}</span>
                )}
              </button>
            ))}
          </nav>
          <div className="nav-health">
            <span>Operations</span>
            <b>{attention.length}</b>
            <small>items need a decision</small>
          </div>
        </aside>

        <div className="app-workspace">
          {stale && (
            <div className="error">
              Daemon is running stale code — run <code>agp upgrade</code>
            </div>
          )}
          <header className="command-bar">
            <div className="command-title">
              <span className="eyebrow">Live Operating Console</span>
              <strong>{TABS.find((t) => t.id === tab)?.label ?? "Board"}</strong>
            </div>
            <div className="command-summary" aria-label="Operational summary">
              <span className={attention.length > 0 ? "summary-pill attention" : "summary-pill"}>
                {attention.length} needs you
              </span>
              <span className="summary-pill">{runningCount} running</span>
              <span className="summary-pill">{queuedCount} queued</span>
              <span className={blockedCount > 0 ? "summary-pill blocked" : "summary-pill"}>
                {blockedCount} blocked
              </span>
              <span className="summary-pill">{reviewCount} in review</span>
              <span className="summary-pill">{agents.length} agents</span>
            </div>
            <div className="spacer" />
            {liveMain && (
              <button
                className={`main-agent-status state-${liveMain.state}`}
                title={`Open main agent terminal · ${AGENT_STATE_LABEL[liveMain.state] ?? liveMain.state}`}
                onClick={() => openTerminal(liveMain.id)}
              >
                <span
                  className="dot"
                  style={{ background: STATE_COLORS[liveMain.state] ?? STATE_COLORS.idle }}
                />
                Main {AGENT_STATE_LABEL[liveMain.state] ?? liveMain.state}
              </button>
            )}
            {scheduler && (
              <button
                className={scheduler.config.enabled ? "sched-on" : ""}
                title={`workers ${scheduler.status.live_workers}/${scheduler.config.max_concurrent}${
                  scheduler.status.parked_workers
                    ? ` (+${scheduler.status.parked_workers} parked in review)`
                    : ""
                } · spawns today ${scheduler.status.spawns_today}/${scheduler.config.daily_spawn_limit}`}
                onClick={() =>
                  act(() =>
                    api("PATCH", "/api/scheduler", {
                      enabled: !scheduler.config.enabled,
                    }),
                  )
                }
              >
                {scheduler.config.enabled
                  ? `Auto ON (${scheduler.status.spawns_today}/${scheduler.config.daily_spawn_limit})`
                  : "Auto OFF"}
              </button>
            )}
            {!liveMain && (
              <MainAgentSpawn
                onSpawn={(model) =>
                  act(() => api("POST", "/api/main", model ? { model } : {}))
                }
              />
            )}
            <button onClick={() => setShowCrons(true)}>Crons</button>
            <button onClick={() => setShowMemory(true)}>Memory</button>
            <button className="primary" onClick={() => setShowNewTask(true)}>
              New Task
            </button>
          </header>

          {error && (
            <div className="error" onClick={() => setError(null)}>
              {error}
            </div>
          )}

          {tab === "board" && (
            <OperationsSnapshot
              attentionCount={attention.length}
              runningCount={runningCount}
              queuedCount={queuedCount}
              activeProjectCount={activeProjectCount}
              reviewCount={reviewCount}
              prsAwaitingMerge={prsAwaitingMerge}
              blockedCount={blockedCount}
              failedCount={failedCount}
              agentCount={agents.length}
              mainOnline={!!liveMain}
              schedulerEnabled={scheduler?.config.enabled ?? false}
            />
          )}

          {tab === "board" && (
            <AttentionPanel
              items={attention}
              onDismiss={(key) =>
                act(() => api("POST", `/api/attention/${encodeURIComponent(key)}/dismiss`, {}))
              }
              onOpenTask={openTask}
            />
          )}

          {tab === "dashboard" && (
            <DashboardView
              tasks={tasks}
              agents={agents}
              events={events}
              attention={attention}
              usage={usage}
              onRefreshUsage={refreshUsage}
              refreshingUsage={refreshingUsage}
              onSelect={(t) => openTask(t.id)}
            />
          )}

          {tab === "tokens" && (
            <TokensView
              tasks={tasks}
              usage={usage}
              onRefreshUsage={refreshUsage}
              refreshingUsage={refreshingUsage}
              onSelect={(t) => openTask(t.id)}
            />
          )}

          {tab === "prs" && (
            <PrsView tasks={tasks} meta={jiraMeta} onSelect={(t) => openTask(t.id)} />
          )}

          {tab === "docs" && <DocsView />}

          {tab === "settings" && <SettingsView />}

          {tab === "archive" && (
            <ArchiveView tasks={tasks} meta={jiraMeta} onSelect={(t) => openTask(t.id)} />
          )}

          {tab === "board" && (
            <main>
              <div className="board">
                {(() => {
                  // Blocker may live in another project group, so resolve chains
                  // against all tasks, not just the current group's.
                  const byId = new Map(tasks.map((t) => [t.id, t] as const));
                  // Only active cards on the board; done/cancelled live under Archive.
                  // Headers still count archived tasks (rollup is over all tasks).
                  return groupByProject(tasks, { visible: (t) => isActive(t.status) }).map((g) => (
                    <div key={g.project} className="column">
                      <h2>
                        {g.project} <span className="muted">{g.done}/{g.total}</span>
                      </h2>
                      {g.tasks.map((t) => (
                        <TaskCard
                          key={t.id}
                          task={t}
                          byId={byId}
                          meta={jiraMeta}
                          onSelect={(sel) => openTask(sel.id)}
                          reviewMax={scheduler?.config.review_max_cycles ?? 4}
                          agents={taskAgents.get(t.id) ?? []}
                          panes={panes}
                          expandedAgentId={expandedAgentId}
                          onToggleAgent={(agentId) =>
                            setExpandedAgentId((cur) => (cur === agentId ? null : agentId))
                          }
                          onOpenTerminal={openTerminal}
                          onAction={act}
                        />
                      ))}
                    </div>
                  ));
                })()}
                {tasks.filter((t) => isActive(t.status)).length === 0 && (
                  <span className="muted">
                    {tasks.length === 0 ? "No tasks yet" : "No active tasks — see Archive"}
                  </span>
                )}
              </div>

              <SignalsPanel
                events={events}
                tasks={tasks}
                onOpenTask={openTask}
                onOpenTerminal={openTerminal}
              />
            </main>
          )}
        </div>
      </div>

      {selTask && (
        <TaskPanel
          key={selTask.id}
          task={selTask}
          agents={agents}
          onClose={closePanel}
          onAction={act}
          onTerminal={openTerminal}
          onTranscript={openTranscript}
        />
      )}

      {panel?.kind === "terminal" && (
        <div className="drawer terminal-drawer" style={keyboardStyle}>
          <div className="drawer-head">
            <b>Terminal — a{panel.agentId}</b>
            <div className="spacer" />
            <button onClick={closePanel}>Close</button>
          </div>
          <Terminal agentId={panel.agentId} />
        </div>
      )}

      {panel?.kind === "transcript" && transcript && (
        <div className="drawer">
          <div className="drawer-head">
            <b>Transcript</b>
            <div className="spacer" />
            <button onClick={closePanel}>Close</button>
          </div>
          <div className="transcript">
            {transcript.map((e, i) => (
              <div key={i} className={`msg ${e.role}`}>
                <span className="role">{e.role}</span>
                <pre>{e.text}</pre>
              </div>
            ))}
          </div>
        </div>
      )}

      {showMemory && <MemoryDrawer onClose={() => setShowMemory(false)} />}
      {showCrons && <CronsDrawer onClose={() => setShowCrons(false)} />}

      {showNewTask && (
        <NewTaskForm
          onClose={() => setShowNewTask(false)}
          onCreate={(body) =>
            act(async () => {
              await api("POST", "/api/tasks", body);
              setShowNewTask(false);
            })
          }
        />
      )}
    </div>
  );
}

function fmtAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** First non-empty line of a summary, clipped for a card. */
function firstLine(s: string | null, n = 140): string {
  if (!s) return "";
  const line = (s.split("\n").find((l) => l.trim()) ?? "").trim();
  return line.length > n ? line.slice(0, n) + "…" : line;
}

/**
 * Outcome-first task card for the board: status + reviewer-verdict chips, the
 * first line of the result, a one-level blocked_by chain, and a PR link — so
 * the card answers "how did this land?" without opening the detail drawer.
 */
/**
 * The JIRA ticket chip: key + workflow-independent status category, linking to
 * the browse URL, with a warning treatment when sync/create is failing (§5). A
 * PR-bearing task in a JIRA-enabled repo with no key yet shows a muted "ticket
 * pending" chip. Renders nothing when the task isn't expected to have a ticket.
 */
function JiraChipView({ task, meta }: { task: Task; meta: JiraMeta }) {
  const chip = jiraChip(task, {
    baseUrl: meta.base_url,
    enabledRepos: meta.enabled_repos,
  });
  if (chip.kind === "none") return null;
  const cls = `chip jira-chip ${chip.cls}${chip.failing ? " jira-failing" : ""}`;
  const text = `${chip.failing ? "⚠ " : ""}${chip.kind === "synced" ? `${chip.key} · ${chip.label}` : chip.label}`;
  if (chip.kind === "synced" && chip.url) {
    return (
      <a
        className={cls}
        href={chip.url}
        target="_blank"
        rel="noreferrer"
        title={chip.title}
        onClick={(e) => e.stopPropagation()}
      >
        {text}
      </a>
    );
  }
  return (
    <span className={cls} title={chip.title}>
      {text}
    </span>
  );
}

function TaskCard({
  task,
  byId,
  meta,
  onSelect,
  reviewMax = 4,
  agents = [],
  panes = {},
  expandedAgentId = null,
  onToggleAgent,
  onOpenTerminal,
  onAction,
}: {
  task: Task;
  byId: Map<number, Task>;
  meta: JiraMeta;
  onSelect: (t: Task) => void;
  reviewMax?: number;
  agents?: Agent[];
  panes?: Record<number, ParsedPane>;
  expandedAgentId?: number | null;
  onToggleAgent?: (agentId: number) => void;
  onOpenTerminal?: (agentId: number) => void;
  onAction?: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const chain = blockedByChain(task, byId);
  const summary = firstLine(task.result_summary);
  const statusLabel =
    task.status === "queued" && task.dispatch_mode === "orchestrated"
      ? "Awaiting main"
      : statusText(task.status);
  return (
    <div className={`card ${task.status}`} onClick={() => onSelect(task)}>
      <div className="card-title">
        <span className="card-id">#{task.id}</span> {task.title}
      </div>
      <div className="chips">
        <span className={`chip ${task.status}`}>{statusLabel}</span>
        {task.workspace_kind !== "repo" && (
          <span className="chip">
            {task.workspace_kind === "portfolio" ? "All repositories" : "Investigation"}
          </span>
        )}
        {task.review_verdict === "approve" && (
          <span className="chip approved">✓ Approved</span>
        )}
        {task.review_verdict === "reject" && (
          <span className="chip bad">✗ Changes</span>
        )}
        {task.publication_mode === "human" && (
          <span className="chip">
            {task.publication_state === "awaiting_human"
              ? "Needs your review"
              : "Human publishes"}
          </span>
        )}
        {task.status === "review" && (
          <span className="chip" title="Automatic review⇄fix round (current/cap)">
            Review round {Math.min(task.review_cycles + 1, reviewMax)}/{reviewMax}
          </span>
        )}
        {task.review_mode === "light" && (
          <span
            className="chip"
            title="Light review: the reviewer reads the diff and checks the claims, but does not independently re-run verification. Set at triage for docs/thresholds/runbooks."
          >
            Light review
          </span>
        )}
        {task.model && <span className="chip">{task.model}</span>}
        {task.reasoning_effort && <span className="chip">{task.reasoning_effort}</span>}
        <span className="chip">{task.worker_provider}</span>
        {task.agent_id && <span className="chip agent-chip">a{task.agent_id}</span>}
        {task.session_id && (
          <span
            className="chip session-chip"
            title={`${task.session_provider ?? task.worker_provider} session ${task.session_id}`}
          >
            session {task.session_id.slice(0, 8)}…
          </span>
        )}
        <JiraChipView task={task} meta={meta} />
      </div>
      {summary && <div className="card-summary">{summary}</div>}
      {chain && (
        <div className="card-blocked muted">
          ⇠ #{chain.id} ({statusText(chain.status)})
        </div>
      )}
      {task.pr_url && (
        <a
          className="card-pr"
          href={task.pr_url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
        >
          PR ↗
        </a>
      )}
      {agents.length > 0 && onOpenTerminal && onAction && (
        <div className="card-agents" onClick={(e) => e.stopPropagation()}>
          {agents.map((agent) => {
            const waiting = agent.state === "waiting_input";
            const expanded = expandedAgentId === agent.id;
            return (
              <div key={agent.id} className={`card-agent${waiting ? " waiting" : ""}`}>
                <div className="card-agent-row">
                  <span
                    className="dot"
                    style={{ background: STATE_COLORS[agent.state] ?? STATE_COLORS.idle }}
                  />
                  <span className="card-agent-meta">
                    a{agent.id} · {agent.kind} · {AGENT_STATE_LABEL[agent.state] ?? agent.state}
                  </span>
                  {waiting && <span className="waiting-badge">Waiting</span>}
                </div>
                <div className="card-agent-actions">
                  {waiting && onToggleAgent && (
                    <button onClick={() => onToggleAgent(agent.id)}>
                      {expanded ? "Hide" : "Respond"}
                    </button>
                  )}
                  <button onClick={() => onOpenTerminal(agent.id)}>Terminal</button>
                  <button
                    className="danger"
                    onClick={() =>
                      onAction(() =>
                        api("POST", `/api/agents/${agent.id}/kill`, {
                          requeue: agent.kind === "worker",
                        }),
                      )
                    }
                  >
                    Kill
                  </button>
                </div>
                {waiting && expanded && (
                  <div className="card-agent-pane">
                    <AgentPane
                      agentId={agent.id}
                      pane={panes[agent.id]}
                      onAction={onAction}
                      onOpenTerminal={() => onOpenTerminal(agent.id)}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

type SignalFilter = "all" | "attention" | "review" | "progress" | "system";
type SignalTone = "attention" | "review" | "progress" | "done" | "system";

const SIGNAL_FILTERS: Array<{ id: SignalFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "attention", label: "Attention" },
  { id: "review", label: "Review" },
  { id: "progress", label: "Progress" },
  { id: "system", label: "System" },
];

function eventPayload(event: Event): Record<string, unknown> {
  if (!event.payload) return {};
  try {
    const parsed: unknown = JSON.parse(event.payload);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function signalTitle(kind: string, payload: Record<string, unknown>): string {
  const titles: Record<string, string> = {
    "task.created": "Task queued",
    "task.claimed": "Task claimed",
    "task.review": "Ready for review",
    "task.blocked": "Task blocked",
    "task.failed": "Task failed",
    "task.cancelled": "Task cancelled",
    "task.reopened": "Task reopened",
    "task.requeued": "Task requeued",
    "task.autocompleted": "Task completed",
    "verify.passed": "Verification passed",
    "verify.failed": "Verification failed",
    "review.approved": "Review approved",
    "review.rejected": "Review rejected",
    "review.round_started": "Review started",
    "review.loop_exhausted": "Review exhausted",
    "review.verdict_superseded": "Review superseded",
    "review.skipped_no_pr": "Review skipped",
    "reviewer.auto_spawned": "Reviewer spawned",
    "reviewer.spawned": "Reviewer spawned",
    "reviewer.spawn_error": "Reviewer failed",
    "pr.feedback": payload.changes_requested ? "Changes requested" : "PR feedback",
    "pr.marked_ready": "PR ready",
    "pr.ready_failed": "PR ready failed",
    "pr.merged": "PR merged",
    "pr.closed": "PR closed",
    "pr.sync_broken": "PR sync broken",
    "pr.sync_error": "PR sync failed",
    "agent.spawned": "Agent spawned",
    "agent.killed": "Agent killed",
    "agent.stalled": "Agent stalled",
    "agent.vanished": "Agent vanished",
    "agent.auto_nudged": "Agent nudged",
    "waiting.escalated": "Waiting escalated",
    "waiting.delegated": "Question delegated",
    "delivery.persisted": "Delivery queued",
    "delivery.deferred": "Delivery deferred",
    "delivery.resumed_on_boot": "Delivery queue resumed",
    "delivery.delivered": "Delivery sent",
    "delivery.expired": "Delivery expired",
    "scheduler.capacity_blocked": "Scheduler at capacity",
    "scheduler.worker_over_cap": "Workers over cap (rework)",
    "scheduler.spawned": "Scheduler spawned",
    "scheduler.spawn_error": "Scheduler failed",
    "scheduler.budget_reached": "Spawn budget reached",
    "daemon.stale": "Daemon stale",
    "jira.sync_broken": "Jira sync broken",
    "jira.sync_error": "Jira sync failed",
    "jira.transition_failed": "Jira update failed",
    "jira.created": "Jira ticket created",
    "jira.transition": "Jira updated",
    "jira.commented": "Jira commented",
  };
  if (kind === "task.status") {
    const to = typeof payload.to === "string" ? payload.to : "";
    return to ? `Moved to ${statusText(to)}` : "Status changed";
  }
  return titles[kind] ?? kind.replaceAll(".", " ");
}

function signalCategory(kind: string, payload: Record<string, unknown>): SignalFilter {
  if (
    kind.includes("failed") ||
    kind.includes("broken") ||
    kind.includes("stalled") ||
    kind.includes("vanished") ||
    kind.includes("exhausted") ||
    kind === "task.blocked" ||
    kind === "task.failed" ||
    kind === "task.stopped_incomplete" ||
    kind === "review.rejected" ||
    kind === "review.verdict_superseded" ||
    kind === "waiting.escalated" ||
    kind === "scheduler.capacity_blocked" ||
    kind === "daemon.stale" ||
    (kind === "pr.feedback" && payload.changes_requested === true)
  ) {
    return "attention";
  }
  if (kind.startsWith("review.") || kind.startsWith("reviewer.") || kind.startsWith("pr.")) {
    return "review";
  }
  if (
    kind.startsWith("settings.") ||
    kind.startsWith("memory.") ||
    kind.startsWith("doc.") ||
    kind.startsWith("worktree.") ||
    kind.startsWith("hook.") ||
    kind.startsWith("cron.") ||
    kind.startsWith("scheduler.") ||
    kind.startsWith("watchdog.") ||
    kind.startsWith("notification.") ||
    kind.startsWith("jira.")
  ) {
    return "system";
  }
  return "progress";
}

function signalTone(kind: string, category: SignalFilter, payload: Record<string, unknown>): SignalTone {
  if (category === "attention") return "attention";
  if (kind.includes("approved") || kind.includes("passed") || kind.includes("completed") || kind.includes("merged")) {
    return "done";
  }
  if (kind === "pr.feedback" && payload.changes_requested !== true) return "review";
  if (category === "review") return "review";
  if (category === "system") return "system";
  return "progress";
}

function signalIcon(tone: SignalTone): string {
  switch (tone) {
    case "attention":
      return "!";
    case "review":
      return "R";
    case "done":
      return "✓";
    case "system":
      return "S";
    default:
      return "→";
  }
}

function SignalsPanel({
  events,
  tasks,
  onOpenTask,
  onOpenTerminal,
}: {
  events: Event[];
  tasks: Task[];
  onOpenTask: (taskId: number) => void;
  onOpenTerminal: (agentId: number) => void;
}) {
  const [filter, setFilter] = useState<SignalFilter>("all");
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const signals = events.map((event) => {
    const payload = eventPayload(event);
    const category = signalCategory(event.kind, payload);
    const tone = signalTone(event.kind, category, payload);
    const task = event.task_id != null ? taskById.get(event.task_id) : undefined;
    return {
      event,
      category,
      tone,
      title: signalTitle(event.kind, payload),
      task,
      detail: event.narrative ?? event.kind,
    };
  });
  const counts = SIGNAL_FILTERS.reduce<Record<SignalFilter, number>>(
    (acc, f) => {
      acc[f.id] = f.id === "all" ? signals.length : signals.filter((s) => s.category === f.id).length;
      return acc;
    },
    { all: 0, attention: 0, review: 0, progress: 0, system: 0 },
  );
  const visible = signals.filter((signal) => filter === "all" || signal.category === filter).slice(0, 14);

  return (
    <aside className="signals">
      <div className="signals-head">
        <div>
          <span className="eyebrow">Signals</span>
          <h2>Latest system movement</h2>
        </div>
      </div>
      <div className="signal-filters" aria-label="Signal filters">
        {SIGNAL_FILTERS.map((f) => (
          <button
            key={f.id}
            className={filter === f.id ? "active" : ""}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
            {counts[f.id] > 0 && <span>{counts[f.id]}</span>}
          </button>
        ))}
      </div>
      <div className="signal-list">
        {visible.map(({ event, category, tone, title, task, detail }) => (
          <div key={event.id} className={`signal-row tone-${tone}`}>
            <span className="signal-icon">{signalIcon(tone)}</span>
            <div className="signal-main">
              <div className="signal-title">
                <b>{title}</b>
                <span>{category}</span>
              </div>
              <div className="signal-context">
                {task ? `#${task.id} ${task.title}` : detail}
              </div>
              {task && detail && (
                <div className="signal-detail">{detail}</div>
              )}
              <div className="signal-meta">
                {event.agent_id != null && <span>a{event.agent_id}</span>}
                <span title={event.ts}>{fmtAge(Date.now() - Date.parse(event.ts))} ago</span>
              </div>
            </div>
            <div className="signal-actions">
              {event.task_id != null && (
                <button onClick={() => onOpenTask(event.task_id!)}>Task</button>
              )}
              {event.agent_id != null && (
                <button onClick={() => onOpenTerminal(event.agent_id!)}>Terminal</button>
              )}
            </div>
          </div>
        ))}
        {visible.length === 0 && (
          <span className="muted">
            {events.length === 0 ? "No signals yet" : "No signals match this filter"}
          </span>
        )}
      </div>
    </aside>
  );
}

const CI_BADGE: Record<string, { label: string; cls: string }> = {
  pass: { label: "✓ CI", cls: "ci-pass" },
  fail: { label: "✗ CI", cls: "ci-fail" },
  pending: { label: "● CI", cls: "ci-pending" },
  none: { label: "– CI", cls: "ci-none" },
};

function CiBadge({ checks }: { checks: string | null }) {
  const b = CI_BADGE[checks ?? "none"] ?? CI_BADGE.none;
  return <span className={`pr-ci ${b.cls}`}>{b.label}</span>;
}

/** The reviewer verdict — "reviewer approved — awaiting merge" is the state
 *  the whole board is built to surface. A draft PR is called out distinctly:
 *  it has NOT passed internal adversarial review, so it is not merge-ready. */
function VerdictBadge({ task }: { task: Task }) {
  if (task.pr_is_draft === 1) {
    return (
      <span className="pr-verdict draft" title="Draft PR — internal adversarial review pending; flips to ready only on approval">
        ✎ Draft — in internal review
      </span>
    );
  }
  if (task.review_verdict === "approve") {
    return <span className="pr-verdict approved">✓ Reviewer approved — awaiting merge</span>;
  }
  if (task.review_verdict === "reject") {
    return <span className="pr-verdict bad">✗ Changes requested</span>;
  }
  return <span className="pr-verdict muted">In review</span>;
}

function prNumber(url: string | null): string {
  return url?.match(/\/pull\/(\d+)/)?.[1] ?? "?";
}

function PrRow({
  task,
  meta,
  onSelect,
}: {
  task: Task;
  meta: JiraMeta;
  onSelect: (t: Task) => void;
}) {
  const broken = (task.pr_sync_fails ?? 0) >= 3;
  return (
    <div className="pr-row">
      <a className="pr-link" href={task.pr_url!} target="_blank" rel="noreferrer">
        #{prNumber(task.pr_url)} {task.title}
      </a>
      <button className="pr-task" onClick={() => onSelect(task)}>
        #{task.id}
      </button>
      <CiBadge checks={task.pr_checks} />
      <VerdictBadge task={task} />
      <JiraChipView task={task} meta={meta} />
      {broken && (
        <span className="chip bad" title="prsync has failed 3+ times in a row">
          ⚠ Sync broken
        </span>
      )}
      <span className="pr-age muted" title={task.pr_synced_at ?? task.updated_at}>
        {fmtAge(Date.now() - Date.parse(task.updated_at))}
      </span>
    </div>
  );
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function fmtUsd(n: number): string {
  if (n >= 1000) return `$${Math.round(n).toLocaleString()}`;
  if (n >= 10) return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}

/**
 * Spend data for the whole dashboard. Polled slowly on its own timer rather
 * than folded into the 2.5s task refresh: the live figure only moves hourly,
 * and the org page it mirrors is nobody's idea of a hot path.
 */
function useUsage(): {
  usage: UsagePayload | null;
  refresh: () => Promise<void>;
  refreshing: boolean;
} {
  const [usage, setUsage] = useState<UsagePayload | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const load = () =>
      api<UsagePayload>("GET", "/api/usage")
        .then(setUsage)
        .catch(() => {}); // spend is never load-bearing — a failure just leaves the last figure
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  // Forces an upstream fetch rather than re-reading the hourly cache — what
  // the operator wants right after a big run finishes.
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setUsage(await api<UsagePayload>("POST", "/api/usage/refresh", {}));
    } catch {
      /* keep whatever we had */
    } finally {
      setRefreshing(false);
    }
  }, []);

  return { usage, refresh, refreshing };
}

/**
 * "$X of $Y this cycle" against the configured monthly quota.
 *
 * Rendered independently of the live feed. The live meters report plan windows
 * as percentages (on a Team seat they carry no dollars at all), so if this bar
 * only appeared when the live feed was DOWN, a configured quota would be
 * invisible on the machines that matter. Percent meters and a dollar budget
 * answer different questions and are shown together.
 */
/**
 * Org billing dollars for the CURRENT cycle, or null.
 *
 * The org cache is only usable when it was built for the cycle we're showing.
 * It is deliberately kept across failures (a 401 after a key rotation, a
 * network blip, the admin key being removed) so a transient error doesn't blank
 * the figure — but that same stickiness means a cache from July survives into
 * August. Presenting July's dollars against August's quota, labelled "org
 * billing", would be worse than falling back to the estimate. So: window must
 * match, or we don't use it.
 */
function orgCycleSpend(usage: UsagePayload): { usd: number; fetched_at: string | null } | null {
  return orgCycleSpendFor(usage.org, usage.local.cycle.start);
}

/** "as of Jul 20" — freshness for a figure that only refreshes hourly and can
 *  sit unchanged through an outage. */
function asOf(fetchedAt: string | null): string {
  if (!fetchedAt) return "";
  const t = Date.parse(fetchedAt);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Points at Settings when no budget is configured.
 *
 * Rendered on every path, including the live-feed branch and the compact
 * mission-control panel. The live meters report plan windows as percentages
 * and say nothing about dollars, so without this a quota is simply an
 * undiscoverable feature on exactly the machines where the live feed works.
 */
function QuotaHint({ usage }: { usage: UsagePayload }) {
  if (usage.quota.monthly_quota_usd !== null) return null;
  return (
    <p className="spend-note muted">
      No monthly quota set — add one in Settings to draw a budget line against cycle burn.
    </p>
  );
}

function QuotaBudgetBar({ usage }: { usage: UsagePayload }) {
  const quota = usage.quota.monthly_quota_usd;
  if (quota === null) return null;
  const org = orgCycleSpend(usage);
  const spent = org?.usd ?? usage.local.cycle.cost_usd;
  const pct = Math.min(100, (spent / quota) * 100);
  const stamp = org ? asOf(org.fetched_at) : "";
  return (
    <div className="bar-row">
      <div className="bar-label">
        <span>
          Budget{" "}
          <span className="muted">
            ({org ? `org billing${stamp ? `, as of ${stamp}` : ""}` : "local estimate"})
          </span>
        </span>
        <b>
          {fmtUsd(spent)} / {fmtUsd(quota)}
        </b>
      </div>
      <div className="bar-track">
        <span className={`bar-fill quota ${meterTone(pct)}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Percent → the same red/yellow/green banding the rest of the board uses. */
function meterTone(percent: number | null): string {
  if (percent === null) return "";
  if (percent >= 90) return "bad";
  if (percent >= 70) return "warn";
  return "ok";
}

function MeterBar({ meter, now }: { meter: UsageMeter; now: Date }) {
  const pct = meter.percent ?? 0;
  const resets = resetsIn(meter.resets_at, now);
  return (
    <div className="bar-row">
      <div className="bar-label">
        <span>{meter.label}</span>
        <b>{meter.percent === null ? "—" : `${Math.round(meter.percent)}%`}</b>
      </div>
      <div className="bar-track">
        <span
          className={`bar-fill quota ${meterTone(meter.percent)}`}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
      {resets && <span className="meter-reset muted">resets in {resets}</span>}
    </div>
  );
}

/**
 * The headline "how much of my quota is left" widget, shared by the Tokens tab
 * and the mission-control spend panel.
 *
 * Source precedence is the whole point of this component. The live feed is the
 * only number that matches the claude.ai usage page, because it also counts
 * work done outside commandcenter (interactive Claude Code sessions, the
 * orchestrator itself). The local estimate can never reconcile with it, so it
 * is shown as a clearly-labelled fallback rather than blended in.
 */
function SpendHeadline({
  usage,
  onRefresh,
  refreshing,
  compact = false,
}: {
  usage: UsagePayload | null;
  onRefresh: () => void;
  refreshing: boolean;
  compact?: boolean;
}) {
  const now = new Date();
  if (!usage) return <span className="empty-panel muted">Loading usage…</span>;

  const live = usage.live.usage;
  const headline = live?.headline ?? null;
  const meters = live?.meters ?? [];
  const spend = live?.spend ?? null;

  if (headline) {
    const shown = compact ? meters.slice(0, 2) : meters;
    return (
      <div className="spend-headline">
        <div className="spend-top">
          <b className={meterTone(headline.percent)}>
            {headline.percent === null ? "—" : `${Math.round(headline.percent)}%`}
          </b>
          <span className="muted">of {headline.label}</span>
          <span className="chip approved" title="Live from Claude — the same figure as the usage page, including usage outside commandcenter">
            org usage data
          </span>
          <button className="linkish" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? "refreshing…" : "refresh"}
          </button>
        </div>
        <div className="bar-list">
          {shown.map((m) => (
            <MeterBar key={m.key} meter={m} now={now} />
          ))}
          <QuotaBudgetBar usage={usage} />
        </div>
        <QuotaHint usage={usage} />
        {spend?.limit_reached && (
          <p className="spend-note bad">
            Extra-usage spend limit reached
            {spend.limit_usd !== null && ` (${fmtUsd(spend.used_usd)} of ${fmtUsd(spend.limit_usd)})`}
            .
          </p>
        )}
        {spend && !spend.limit_reached && spend.limit_usd !== null && (
          <p className="spend-note muted">
            Extra usage: {fmtUsd(spend.used_usd)} of {fmtUsd(spend.limit_usd)}
          </p>
        )}
        <p className="spend-note muted">
          Checked {usage.live.checked_at ? usage.live.checked_at.slice(11, 16) : "—"} UTC
          {usage.live.error && ` · last refresh failed: ${usage.live.error}`}
        </p>
      </div>
    );
  }

  // No live feed — fall back to the local estimate against the configured
  // budget, and say plainly that it is neither live nor billing data.
  return (
    <LocalSpendHeadline
      usage={usage}
      onRefresh={onRefresh}
      refreshing={refreshing}
      compact={compact}
    />
  );
}

function LocalSpendHeadline({
  usage,
  onRefresh,
  refreshing,
  compact,
}: {
  usage: UsagePayload;
  onRefresh: () => void;
  refreshing: boolean;
  compact: boolean;
}) {
  const org = orgCycleSpend(usage);
  const spent = org?.usd ?? usage.local.cycle.cost_usd;
  const quota = usage.quota.monthly_quota_usd;
  const pct = quota ? Math.min(100, (spent / quota) * 100) : null;
  const stamp = org ? asOf(org.fetched_at) : "";

  return (
    <div className="spend-headline">
      <div className="spend-top">
        <b className={meterTone(pct)}>{fmtUsd(spent)}</b>
        <span className="muted">{quota ? `of ${fmtUsd(quota)} this cycle` : "this cycle"}</span>
        <span
          className={`chip ${org ? "approved" : ""}`}
          title={
            org
              ? "Anthropic Admin API cost report (Console/Platform API spend)"
              : "Estimated from local session transcripts — not billing data, and it only counts work this daemon ran"
          }
        >
          {org ? `org billing data${stamp ? ` · as of ${stamp}` : ""}` : "local estimate — not billing data"}
        </span>
        <button className="linkish" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? "refreshing…" : "refresh"}
        </button>
      </div>
      {quota !== null && (
        <div className="bar-track">
          <span
            className={`bar-fill quota ${meterTone(pct)}`}
            style={{ width: `${pct ?? 0}%` }}
          />
        </div>
      )}
      {/* Always shown when unset — a hidden hint is the same as no feature. */}
      <QuotaHint usage={usage} />
      {!compact && (
        <p className="spend-note muted">
          {usage.live.error
            ? `Live Claude usage unavailable (${usage.live.error}) — showing the local estimate instead.`
            : "Live Claude usage unavailable — showing the local estimate instead."}
        </p>
      )}
    </div>
  );
}

/**
 * Daily burn bars for the current cycle with a linear pace line. Local
 * estimate only — the live feed reports windows, not a per-day series, so this
 * is the breakdown the org page can't give you.
 */
function BurnChart({ usage }: { usage: UsagePayload }) {
  const { cycle } = usage.local;
  const quota = usage.quota.monthly_quota_usd;
  const maxDay = Math.max(0.01, ...cycle.days.map((d) => d.cost_usd));
  // The pace line sits at the per-day spend that would exactly exhaust the
  // quota over the cycle — bars above it are days that outran the budget.
  const perDayPace = quota ? quota / cycle.days_total : null;
  const scaleMax = Math.max(maxDay, perDayPace ?? 0);
  const today = dayKey(new Date());

  return (
    <div className="burn-chart-wrap">
      <div className="burn-chart" aria-label="Estimated daily spend this cycle">
        {perDayPace !== null && (
          <span
            className="pace-line"
            style={{ bottom: `${(perDayPace / scaleMax) * 100}%` }}
            title={`Pace to stay within budget: ${fmtUsd(perDayPace)}/day`}
          />
        )}
        {cycle.days.map((d) => (
          <div
            key={d.day}
            className={`burn-day${d.day === today ? " today" : ""}`}
            title={`${d.day}: ${fmtUsd(d.cost_usd)} estimated · ${fmtTokens(d.tokens)} tokens`}
          >
            <span
              className="burn-bar"
              style={{ height: `${Math.max(2, (d.cost_usd / scaleMax) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="chart-legend">
        <span>
          {cycle.start} → {cycle.end}
        </span>
        {perDayPace !== null && (
          <span>
            <i className="legend-dot pace" /> pace {fmtUsd(perDayPace)}/day
          </span>
        )}
        {/* The chart sits under an "org usage data" chip on mission control.
            Without this it reads as billing data; it is neither billing nor
            live, so the label travels with the chart rather than living in a
            paragraph only the Tokens tab renders. */}
        <span className="estimate-tag">local estimate — not billing data</span>
      </div>
    </div>
  );
}

function shortDayLabel(key: string): string {
  const [, month, day] = key.split("-");
  return `${month}/${day}`;
}

function DashboardView({
  tasks,
  agents,
  events,
  attention,
  usage,
  onRefreshUsage,
  refreshingUsage,
  onSelect,
}: {
  tasks: Task[];
  agents: Agent[];
  events: Event[];
  attention: AttentionItem[];
  usage: UsagePayload | null;
  onRefreshUsage: () => void;
  refreshingUsage: boolean;
  onSelect: (t: Task) => void;
}) {
  const [spendView, setSpendView] = useState<"cycle" | "all">("cycle");
  const statusOrder = ["queued", "in_progress", "review", "blocked", "done", "failed"];
  const statusRows = statusOrder.map((status) => ({
    status,
    label: statusText(status),
    count: tasks.filter((t) => t.status === status).length,
  }));
  const maxStatus = Math.max(1, ...statusRows.map((row) => row.count));

  const today = new Date();
  const flow = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() - (13 - i));
    return { key: dayKey(d), created: 0, completed: 0 };
  });
  const flowByKey = new Map(flow.map((bucket) => [bucket.key, bucket]));
  for (const task of tasks) {
    const createdBucket = flowByKey.get(task.created_at.slice(0, 10));
    if (createdBucket) createdBucket.created++;
    if (["done", "cancelled"].includes(task.status)) {
      const completedBucket = flowByKey.get(task.updated_at.slice(0, 10));
      if (completedBucket) completedBucket.completed++;
    }
  }
  const maxFlow = Math.max(1, ...flow.flatMap((bucket) => [bucket.created, bucket.completed]));

  const tokenRows = Array.from(
    tasks.reduce((acc, task) => {
      const tokens = task.tokens_used ?? 0;
      if (tokens <= 0) return acc;
      const key = task.model ?? task.worker_provider;
      acc.set(key, (acc.get(key) ?? 0) + tokens);
      return acc;
    }, new Map<string, number>()),
  )
    .map(([label, tokens]) => ({ label, tokens }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5);
  const maxTokens = Math.max(1, ...tokenRows.map((row) => row.tokens));

  const reviewRows = [
    {
      label: "Approved",
      count: tasks.filter((t) => t.review_verdict === "approve" && isOpenPr(t)).length,
      cls: "approved",
    },
    {
      label: "In review",
      count: tasks.filter((t) => t.status === "review" && t.review_verdict !== "approve").length,
      cls: "review",
    },
    {
      label: "Changes",
      count: tasks.filter((t) => t.review_verdict === "reject").length,
      cls: "bad",
    },
  ];
  const reviewTotal = Math.max(1, reviewRows.reduce((sum, row) => sum + row.count, 0));

  const agentRows = ["working", "waiting_input", "idle", "spawning", "stalled"].map((state) => ({
    state,
    label: AGENT_STATE_LABEL[state] ?? state,
    count: agents.filter((agent) => agent.state === state).length,
  }));
  const maxAgents = Math.max(1, ...agentRows.map((row) => row.count));

  const riskTasks = tasks
    .filter((task) => ["blocked", "failed"].includes(task.status) || attention.some((it) => it.task_id === task.id))
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
    .slice(0, 4);

  return (
    <main className="dashboard-page">
      <div className="dashboard-grid">
        <section className="dashboard-panel panel-wide">
          <div className="panel-head">
            <div>
              <span className="eyebrow">Task Flow</span>
              <h2>Created vs completed</h2>
            </div>
            <span className="panel-meta">14 days</span>
          </div>
          <div className="flow-chart" aria-label="Created and completed tasks over the last 14 days">
            {flow.map((bucket) => (
              <div key={bucket.key} className="flow-day" title={`${bucket.key}: ${bucket.created} created, ${bucket.completed} completed`}>
                <div className="flow-bars">
                  <span
                    className="flow-bar created"
                    style={{ height: `${Math.max(4, (bucket.created / maxFlow) * 100)}%` }}
                  />
                  <span
                    className="flow-bar completed"
                    style={{ height: `${Math.max(4, (bucket.completed / maxFlow) * 100)}%` }}
                  />
                </div>
                <span>{shortDayLabel(bucket.key)}</span>
              </div>
            ))}
          </div>
          <div className="chart-legend">
            <span><i className="legend-dot created" /> Created</span>
            <span><i className="legend-dot completed" /> Completed</span>
          </div>
        </section>

        <section className="dashboard-panel">
          <div className="panel-head">
            <div>
              <span className="eyebrow">Workload</span>
              <h2>Status distribution</h2>
            </div>
          </div>
          <div className="bar-list">
            {statusRows.map((row) => (
              <div key={row.status} className="bar-row">
                <div className="bar-label">
                  <span>{row.label}</span>
                  <b>{row.count}</b>
                </div>
                <div className="bar-track">
                  <span className={`bar-fill ${row.status}`} style={{ width: `${(row.count / maxStatus) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="dashboard-panel">
          <div className="panel-head">
            <div>
              <span className="eyebrow">Review</span>
              <h2>Review lane</h2>
            </div>
          </div>
          <div className="pipeline-bar">
            {reviewRows.map((row) => (
              <span
                key={row.label}
                className={`pipeline-segment ${row.cls}`}
                style={{ width: `${(row.count / reviewTotal) * 100}%` }}
                title={`${row.label}: ${row.count}`}
              />
            ))}
          </div>
          <div className="metric-list">
            {reviewRows.map((row) => (
              <div key={row.label} className="metric-row">
                <span>{row.label}</span>
                <b>{row.count}</b>
              </div>
            ))}
          </div>
        </section>

        <section className="dashboard-panel">
          <div className="panel-head">
            <div>
              <span className="eyebrow">Spend</span>
              <h2>Quota this cycle</h2>
            </div>
          </div>
          <SpendHeadline
            usage={usage}
            onRefresh={onRefreshUsage}
            refreshing={refreshingUsage}
            compact
          />
          {/* Cycle-to-date is the default view here too — an all-time counter
              can't tell you whether this month is on track. All-time stays one
              click away. */}
          <div className="view-toggle">
            <button
              className={spendView === "cycle" ? "sched-on" : ""}
              onClick={() => setSpendView("cycle")}
            >
              This cycle
            </button>
            <button
              className={spendView === "all" ? "sched-on" : ""}
              onClick={() => setSpendView("all")}
            >
              All time
            </button>
          </div>
          {spendView === "cycle" ? (
            usage && usage.local.cycle.tokens > 0 ? (
              <BurnChart usage={usage} />
            ) : (
              <span className="empty-panel muted">No burn recorded this cycle yet</span>
            )
          ) : tokenRows.length > 0 ? (
            <div className="bar-list">
              {tokenRows.map((row) => (
                <div key={row.label} className="bar-row">
                  <div className="bar-label">
                    <span>{row.label}</span>
                    <b>{fmtTokens(row.tokens)}</b>
                  </div>
                  <div className="bar-track">
                    <span className="bar-fill tokens" style={{ width: `${(row.tokens / maxTokens) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <span className="empty-panel muted">No token usage recorded yet</span>
          )}
        </section>

        <section className="dashboard-panel">
          <div className="panel-head">
            <div>
              <span className="eyebrow">Fleet</span>
              <h2>Agent states</h2>
            </div>
          </div>
          <div className="bar-list">
            {agentRows.map((row) => (
              <div key={row.state} className="bar-row">
                <div className="bar-label">
                  <span>{row.label}</span>
                  <b>{row.count}</b>
                </div>
                <div className="bar-track">
                  <span className={`bar-fill agent-${row.state}`} style={{ width: `${(row.count / maxAgents) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="dashboard-panel panel-wide">
          <div className="panel-head">
            <div>
              <span className="eyebrow">Embedded Views</span>
              <h2>Operational graph slots</h2>
            </div>
          </div>
          <div className="embed-grid">
            <div className="embed-frame">
              <div className="embed-head">
                <span>API SLA</span>
                <b>source pending</b>
              </div>
              <div className="embed-sparkline" aria-hidden="true">
                {Array.from({ length: 18 }, (_, i) => (
                  <span key={i} style={{ height: `${28 + ((i * 17) % 52)}%` }} />
                ))}
              </div>
            </div>
            <div className="embed-frame">
              <div className="embed-head">
                <span>Jira Risk Report</span>
                <b>source pending</b>
              </div>
              <div className="embed-bars" aria-hidden="true">
                <span style={{ width: "72%" }} />
                <span style={{ width: "46%" }} />
                <span style={{ width: "58%" }} />
                <span style={{ width: "31%" }} />
              </div>
            </div>
          </div>
        </section>

        <section className="dashboard-panel">
          <div className="panel-head">
            <div>
              <span className="eyebrow">Attention</span>
              <h2>Current risks</h2>
            </div>
          </div>
          {riskTasks.length > 0 ? (
            <div className="risk-list">
              {riskTasks.map((task) => (
                <button key={task.id} className="risk-row" onClick={() => onSelect(task)}>
                  <span>#{task.id} {task.title}</span>
                  <b>{statusText(task.status)}</b>
                </button>
              ))}
            </div>
          ) : (
            <span className="empty-panel muted">No blocked or failed work</span>
          )}
        </section>

        <section className="dashboard-panel">
          <div className="panel-head">
            <div>
              <span className="eyebrow">Activity</span>
              <h2>Latest events</h2>
            </div>
          </div>
          <div className="dashboard-events">
            {events.slice(0, 6).map((event) => (
              <div key={event.id}>
                <span className="muted">{event.ts.slice(11, 19)}</span>
                <p>{event.narrative ?? event.kind}</p>
              </div>
            ))}
            {events.length === 0 && <span className="empty-panel muted">No events yet</span>}
          </div>
        </section>
      </div>
    </main>
  );
}

/**
 * The PR board: every task-linked PR grouped by repo/project, merged & closed
 * ones auto-cleared. Leads with the reviewer verdict so approved-awaiting-merge
 * work is unmissable.
 */
function PrsView({
  tasks,
  meta,
  onSelect,
}: {
  tasks: Task[];
  meta: JiraMeta;
  onSelect: (t: Task) => void;
}) {
  const groups = groupByProject(tasks.filter(isOpenPr));
  return (
    <main>
      <div className="prs-view">
        {groups.length === 0 && (
          <span className="muted">No open PRs — everything's merged or in flight</span>
        )}
        {groups.map((g) => (
          <div key={g.project} className="pr-group">
            <h2>
              {g.project} <span className="muted">{g.total}</span>
            </h2>
            {g.tasks.map((t) => (
              <PrRow key={t.id} task={t} meta={meta} onSelect={onSelect} />
            ))}
          </div>
        ))}
      </div>
    </main>
  );
}

/**
 * The Archive tab: done + cancelled tasks, same project-grouped layout as the
 * board, so finished work stays browsable without cluttering the active board.
 * A single text box filters by project name or task title.
 */
function ArchiveView({
  tasks,
  meta,
  onSelect,
}: {
  tasks: Task[];
  meta: JiraMeta;
  onSelect: (t: Task) => void;
}) {
  const [filter, setFilter] = useState("");
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const q = filter.trim().toLowerCase();
  const groups = groupByProject(tasks, {
    visible: (t) =>
      isArchived(t.status) &&
      (q === "" ||
        projectOfTask(t).toLowerCase().includes(q) ||
        t.title.toLowerCase().includes(q)),
  });
  const archivedCount = tasks.filter((t) => isArchived(t.status)).length;

  return (
    <main>
      <div className="archive-view">
        <input
          className="archive-filter"
          placeholder="Filter archive by project or title…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="board">
          {groups.map((g) => (
            <div key={g.project} className="column">
              <h2>
                {g.project} <span className="muted">{g.done}/{g.total}</span>
              </h2>
              {g.tasks.map((t) => (
                <TaskCard key={t.id} task={t} byId={byId} meta={meta} onSelect={onSelect} />
              ))}
            </div>
          ))}
          {groups.length === 0 && (
            <span className="muted">
              {archivedCount === 0
                ? "Nothing archived yet"
                : "No archived tasks match your filter"}
            </span>
          )}
        </div>
      </div>
    </main>
  );
}

/**
 * Render agent-authored markdown safely. react-markdown never passes raw HTML
 * through to the DOM (no dangerouslySetInnerHTML), so embedded <script>/<img
 * onerror> in a doc is shown as inert text; rehype-sanitize is layered on as
 * defense-in-depth. remark-gfm adds tables, task lists, and fenced code.
 *
 * `looseLineBreaks` is for prose fields (task prompt/result_summary/review
 * notes) that are markdown-ish but not guaranteed valid markdown — plain
 * single newlines there must still render as visible line breaks, so the
 * content is run through softenLineBreaks first. Curated docs (Docs tab)
 * leave it off so intentionally-wrapped paragraphs still fill.
 */
function Markdown({
  content,
  looseLineBreaks = false,
}: {
  content: string;
  looseLineBreaks?: boolean;
}) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          a: ({ node, href, children, ...rest }) => (
            <a {...rest} href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {looseLineBreaks ? softenLineBreaks(content) : content}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Markdown with a max-height clamp + expand/collapse toggle, so a long
 * result_summary/review_notes/prompt doesn't dominate the task panel. The
 * toggle only appears when the rendered content actually overflows the cap.
 */
function CollapsibleMarkdown({
  content,
  looseLineBreaks = false,
  maxHeight = 220,
}: {
  content: string;
  looseLineBreaks?: boolean;
  maxHeight?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    setOverflowing(!!el && el.scrollHeight > maxHeight + 2);
  }, [content, maxHeight]);

  return (
    <div className="clamp-wrap">
      <div
        ref={bodyRef}
        className={overflowing && !expanded ? "clamp-body clamped" : "clamp-body"}
        style={overflowing && !expanded ? { maxHeight } : undefined}
      >
        <Markdown content={content} looseLineBreaks={looseLineBreaks} />
      </div>
      {overflowing && (
        <button className="clamp-toggle" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "▲ Collapse" : "▼ Expand"}
        </button>
      )}
    </div>
  );
}

function basename(p: string): string {
  return p.split(/[/\\]/).pop() ?? p;
}

/* ------------------------------------------------------------------ *
 * Settings tab                                                        *
 * ------------------------------------------------------------------ */

/** When a saved setting takes effect. The daemon reads most settings at their
 *  natural point (a scheduler tick, the next spawn, the next notify call), so
 *  changes rarely need a restart — but the badge tells the operator exactly
 *  when to expect each change to bite. */
type ApplyWhen = "immediate" | "next-task" | "next-spawn" | "restart";

const APPLY_LABEL: Record<ApplyWhen, string> = {
  immediate: "Applies immediately",
  "next-task": "Applies to new tasks",
  "next-spawn": "Applies to next spawn",
  restart: "Needs daemon restart",
};

function ApplyBadge({ when }: { when: ApplyWhen }) {
  return <span className={`apply-badge apply-${when}`}>{APPLY_LABEL[when]}</span>;
}

function SettingRow({
  label,
  when,
  hint,
  children,
}: {
  label: string;
  when: ApplyWhen;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="setting-row">
      <div className="setting-head">
        <span className="setting-label">{label}</span>
        <ApplyBadge when={when} />
      </div>
      {children}
      {hint && <span className="setting-hint muted">{hint}</span>}
    </div>
  );
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function SchedulerSection({
  info,
  onSaved,
  onError,
}: {
  info: SchedulerInfo;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [draft, setDraft] = useState<SchedulerConfig>(info.config);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof SchedulerConfig>(k: K, v: SchedulerConfig[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const save = async () => {
    setSaving(true);
    onError("");
    try {
      await api("PATCH", "/api/scheduler", {
        max_concurrent: draft.max_concurrent,
        daily_spawn_limit: draft.daily_spawn_limit,
        stall_minutes: draft.stall_minutes,
        active_hours: draft.active_hours,
        auto_review: draft.auto_review,
        review_max_cycles: draft.review_max_cycles,
        escalate_minutes: draft.escalate_minutes,
        reap_after_minutes: draft.reap_after_minutes,
        attention_stale_minutes: draft.attention_stale_minutes,
        read_only_extra_allow: draft.read_only_extra_allow,
      });
      onSaved();
    } catch (e) {
      onError(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  const hours = draft.active_hours;

  return (
    <section className="settings-section">
      <h2>Scheduler</h2>
      <p className="muted">
        The autonomous scheduler reads these on every tick, so edits take hold
        right away. Toggle the master switch from the header ▶/■ control.
      </p>
      <div className="settings-grid">
        <SettingRow label="Max concurrent workers" when="immediate">
          <input
            type="number"
            min={1}
            max={10}
            value={draft.max_concurrent}
            onChange={(e) => set("max_concurrent", Number(e.target.value))}
          />
        </SettingRow>
        <SettingRow label="Daily spawn limit" when="immediate">
          <input
            type="number"
            min={1}
            max={200}
            value={draft.daily_spawn_limit}
            onChange={(e) => set("daily_spawn_limit", Number(e.target.value))}
          />
        </SettingRow>
        <SettingRow
          label="Stall threshold (min)"
          when="immediate"
          hint="No hook event for this long → a working agent is marked stalled."
        >
          <input
            type="number"
            min={2}
            max={240}
            value={draft.stall_minutes}
            onChange={(e) => set("stall_minutes", Number(e.target.value))}
          />
        </SettingRow>
        <SettingRow label="Escalate to human (min)" when="immediate">
          <input
            type="number"
            min={1}
            max={120}
            value={draft.escalate_minutes}
            onChange={(e) => set("escalate_minutes", Number(e.target.value))}
          />
        </SettingRow>
        <SettingRow
          label="Reap terminal worker (min)"
          when="immediate"
          hint="Idle grace before a done/cancelled worker's window is reaped."
        >
          <input
            type="number"
            min={1}
            max={240}
            value={draft.reap_after_minutes}
            onChange={(e) => set("reap_after_minutes", Number(e.target.value))}
          />
        </SettingRow>
        <SettingRow label="Attention stale (min)" when="immediate">
          <input
            type="number"
            min={1}
            max={240}
            value={draft.attention_stale_minutes}
            onChange={(e) =>
              set("attention_stale_minutes", Number(e.target.value))
            }
          />
        </SettingRow>
        <SettingRow
          label="Max review rounds"
          when="immediate"
          hint="Automatic review⇄fix rounds before the loop blocks the task for a human decision."
        >
          <input
            type="number"
            min={1}
            max={20}
            value={draft.review_max_cycles}
            onChange={(e) => set("review_max_cycles", Number(e.target.value))}
          />
        </SettingRow>
      </div>

      <SettingRow label="Auto-review" when="immediate">
        <label className="setting-check">
          <input
            type="checkbox"
            checked={draft.auto_review}
            onChange={(e) => set("auto_review", e.target.checked)}
          />
          Spawn an adversarial reviewer when a task reaches review
        </label>
      </SettingRow>

      <SettingRow
        label="Active hours"
        when="immediate"
        hint="Only auto-spawn inside this local-time window. start > end wraps overnight (e.g. 22 → 6)."
      >
        <label className="setting-check">
          <input
            type="checkbox"
            checked={hours !== null}
            onChange={(e) =>
              set("active_hours", e.target.checked ? { start: 9, end: 17 } : null)
            }
          />
          Restrict auto-spawn to a time window
        </label>
        {hours !== null && (
          <div className="setting-inline">
            <span className="muted">from</span>
            <input
              type="number"
              min={0}
              max={23}
              value={hours.start}
              onChange={(e) =>
                set("active_hours", { ...hours, start: Number(e.target.value) })
              }
            />
            <span className="muted">to</span>
            <input
              type="number"
              min={0}
              max={23}
              value={hours.end}
              onChange={(e) =>
                set("active_hours", { ...hours, end: Number(e.target.value) })
              }
            />
          </div>
        )}
      </SettingRow>

      <SettingRow
        label="Extra read-only allow patterns"
        when="next-spawn"
        hint="One permission pattern per line, appended to worker/reviewer read-only profiles. Never put state-changing patterns here."
      >
        <textarea
          rows={3}
          value={draft.read_only_extra_allow.join("\n")}
          onChange={(e) =>
            set(
              "read_only_extra_allow",
              e.target.value
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean),
            )
          }
        />
      </SettingRow>

      <div className="settings-actions">
        <button className="primary" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save Scheduler"}
        </button>
      </div>
    </section>
  );
}

/**
 * PR integration: what the platform does about the window where finished work
 * waits to be merged. Two-task-per-repo parallelism is the default and is safe
 * (each worker has its own worktree); what is not safe is two PRs sitting open
 * while the default branch moves, so freshening re-merges them and the nudge
 * asks for a merge sooner.
 *
 * Strict-serial repos are a TOGGLE PER KNOWN REPOSITORY rather than a text
 * field on purpose: the stored value is compared against `tasks.repo`, so a
 * mistyped absolute path would read as "strict-serial is on" while matching
 * nothing at all. A stored path the catalog no longer lists is still shown (as a
 * removable stale row) so saving can never silently drop it either.
 */
function IntegrationSection({
  settings,
  repositories,
  onSaved,
  onError,
}: {
  settings: AppSettings;
  repositories: WorkspaceCatalog["repositories"];
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const { stored } = settings.integration;
  const [autoFreshen, setAutoFreshen] = useState(stored.auto_freshen);
  const [maxAttempts, setMaxAttempts] = useState(String(stored.freshen_max_attempts));
  const [perPass, setPerPass] = useState(String(stored.freshen_per_pass_limit));
  const [nudge, setNudge] = useState(
    stored.merge_nudge_minutes === null ? "" : String(stored.merge_nudge_minutes),
  );
  const [serial, setSerial] = useState<string[]>(stored.strict_serial_repos);
  const [saving, setSaving] = useState(false);

  const toggleSerial = (path: string, on: boolean) =>
    setSerial((cur) =>
      on ? Array.from(new Set([...cur, path])) : cur.filter((p) => p !== path),
    );

  const known = new Set(repositories.map((r) => r.path));
  const stale = serial.filter((p) => !known.has(p));

  const save = async () => {
    setSaving(true);
    onError("");
    try {
      const whole = (raw: string, label: string, max: number): number => {
        const n = Number(raw.trim());
        if (!Number.isInteger(n) || n < 1 || n > max) {
          throw new Error(`${label} must be a whole number from 1 to ${max}.`);
        }
        return n;
      };
      const nudgeRaw = nudge.trim();
      await api("PATCH", "/api/settings/integration", {
        auto_freshen: autoFreshen,
        freshen_max_attempts: whole(maxAttempts, "Re-merge attempt limit", 20),
        freshen_per_pass_limit: whole(perPass, "Re-merges per pass", 20),
        strict_serial_repos: serial,
        merge_nudge_minutes:
          nudgeRaw === "" ? null : whole(nudgeRaw, "Merge nudge", 10080),
      });
      onSaved();
    } catch (e) {
      onError(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-section">
      <h2>PR integration</h2>
      <p className="muted">
        Two tasks may work in one repository at the same time — that is the
        default, and overlapping ones are sequenced with <code>blocked_by</code>{" "}
        when the work is triaged. What conflicts is not the work but the wait:
        once another PR merges, every still-open branch is missing those commits.
        Nothing here ever merges a PR — that stays yours.
      </p>
      <SettingRow label="Auto-freshen open PRs" when="immediate">
        <label className="setting-check">
          <input
            type="checkbox"
            checked={autoFreshen}
            onChange={(e) => setAutoFreshen(e.target.checked)}
          />
          Re-merge the default branch into open agent PRs that fall behind it
        </label>
      </SettingRow>
      <SettingRow
        label="Re-merge attempt limit"
        when="immediate"
        hint="A clean re-merge whose verification passes is pushed to the same branch; a conflict or a failed verification pushes nothing and relaunches the task's worker to reconcile it. After this many attempts without the PR merging, the platform stops touching it and notifies you instead."
      >
        <input
          type="number"
          min="1"
          max="20"
          step="1"
          value={maxAttempts}
          onChange={(e) => setMaxAttempts(e.target.value)}
        />
      </SettingRow>
      <SettingRow
        label="Re-merges per pass"
        when="immediate"
        hint="How many PRs may be re-merged in one PR-sync pass (~2 min). A burst of merges queues instead of relaunching a crowd of workers at once; the rest are picked up on the next pass."
      >
        <input
          type="number"
          min="1"
          max="20"
          step="1"
          value={perPass}
          onChange={(e) => setPerPass(e.target.value)}
        />
      </SettingRow>
      <SettingRow
        label="Merge nudge (minutes)"
        when="immediate"
        hint="Notify you once when an approved, mergeable PR has waited this long while other tasks in the same repo are queued or running — merging it then is what stops the other branches needing a re-merge. Blank turns the nudge off. It only notifies; merging is never automated. The push itself can be silenced under Notifications → What gets pushed."
      >
        <input
          type="number"
          min="1"
          max="10080"
          step="30"
          placeholder="off"
          value={nudge}
          onChange={(e) => setNudge(e.target.value)}
        />
      </SettingRow>

      <div className="jira-repos">
        <div className="setting-head">
          <span className="setting-label">Strict-serial repositories</span>
          <ApplyBadge when="immediate" />
        </div>
        <span className="setting-hint muted">
          The blunt opt-in guarantee: <b>one active task per repository</b>{" "}
          (active = claimed, in progress, in review, or still holding an open
          agent PR). Everything else queues, and a spawn is refused while the
          repo is busy. Off for every repo by default — the normal mode is
          parallel work with overlap sequenced by <code>blocked_by</code> at
          triage. Turn it on only where you want the guarantee more than the
          throughput.
        </span>

        {repositories.length === 0 && stale.length === 0 && (
          <p className="muted">
            No repositories in the catalog yet — nothing to serialize.
          </p>
        )}

        <div className="repo-toggle-list">
          {repositories.map((r) => (
            <label className="repo-toggle" key={r.path}>
              <input
                type="checkbox"
                checked={serial.includes(r.path)}
                onChange={(e) => toggleSerial(r.path, e.target.checked)}
              />
              <span>{r.name}</span>
              <code>{r.path}</code>
            </label>
          ))}
          {stale.map((p) => (
            <div className="repo-toggle" key={p}>
              <span className="repo-toggle-stale">Not in the catalog</span>
              <code>{p}</code>
              <button className="link-btn" onClick={() => toggleSerial(p, false)}>
                Remove
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="settings-actions">
        <button className="primary" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save PR Integration"}
        </button>
      </div>
    </section>
  );
}

function AgentsSection({
  settings,
  onSaved,
  onError,
}: {
  settings: AppSettings;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const { stored, effective } = settings.agents;
  const [mainModel, setMainModel] = useState(stored.default_main_model ?? "");
  const [workerProvider, setWorkerProvider] = useState(
    stored.default_worker_provider ?? "",
  );
  const [reviewerProvider, setReviewerProvider] = useState(
    stored.default_reviewer_provider ?? "",
  );
  const [variety, setVariety] = useState(
    stored.reviewer_variety === null ? "" : String(stored.reviewer_variety),
  );
  const [publicationMode, setPublicationMode] = useState(
    stored.worker_publication_mode ?? "",
  );
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    onError("");
    try {
      await api("PATCH", "/api/settings/agents", {
        default_main_model: mainModel || null,
        default_worker_provider: workerProvider || null,
        default_reviewer_provider: reviewerProvider || null,
        reviewer_variety: variety === "" ? null : variety === "true",
        worker_publication_mode: publicationMode || null,
      });
      onSaved();
    } catch (e) {
      onError(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-section">
      <h2>Agents</h2>
      <p className="muted">
        Defaults for newly spawned agents. Leaving a field on “default” falls
        back to the env var, then the built-in default (setting &gt; env &gt;
        default). Live agents are unaffected.
      </p>
      <div className="settings-grid">
        <SettingRow
          label="Default main-agent model"
          when="next-spawn"
          hint={`Overrides CC_MAIN_MODEL at spawnMain time. In use now: ${effective.default_main_model}.`}
        >
          <select
            value={mainModel}
            onChange={(e) => setMainModel(e.target.value)}
          >
            <option value="">Default ({effective.default_main_model})</option>
            {settings.model_choices.map((slug) => (
              <option key={slug} value={slug}>
                {slug}
              </option>
            ))}
          </select>
        </SettingRow>

        <SettingRow
          label="Default worker provider"
          when="next-spawn"
          hint={`Overrides CC_WORKER_PROVIDER. In use now: ${effective.default_worker_provider}.`}
        >
          <select
            value={workerProvider}
            onChange={(e) => setWorkerProvider(e.target.value)}
          >
            <option value="">
              Default ({effective.default_worker_provider})
            </option>
            {settings.provider_choices.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </SettingRow>

        <SettingRow
          label="Reviewer provider pin"
          when="next-spawn"
          hint="Overrides CC_REVIEWER_PROVIDER. “no pin” lets the variety policy (or Claude) decide."
        >
          <select
            value={reviewerProvider}
            onChange={(e) => setReviewerProvider(e.target.value)}
          >
            <option value="">
              No pin
              {effective.default_reviewer_provider
                ? ` (env pins ${effective.default_reviewer_provider})`
                : ""}
            </option>
            {settings.provider_choices.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </SettingRow>

        <SettingRow
          label="Cross-model review variety"
          when="next-spawn"
          hint={`Reviewer takes the OPPOSITE provider from the worker. Asserts both providers are set up. In use now: ${effective.reviewer_variety ? "on" : "off"}.`}
        >
          <select value={variety} onChange={(e) => setVariety(e.target.value)}>
            <option value="">
              Default ({effective.reviewer_variety ? "on" : "off"})
            </option>
            <option value="true">On</option>
            <option value="false">Off</option>
          </select>
        </SettingRow>

        <SettingRow
          label="Worker publication"
          when="next-task"
          hint={`Agent publishes keeps the existing commit/push/PR workflow. Human publishes leaves reviewed changes uncommitted for you. In use now: ${effective.worker_publication_mode}.`}
        >
          <select
            value={publicationMode}
            onChange={(e) => setPublicationMode(e.target.value)}
          >
            <option value="">
              Default ({effective.worker_publication_mode})
            </option>
            <option value="agent">Agent publishes</option>
            <option value="human">Human publishes</option>
          </select>
        </SettingRow>
      </div>
      <div className="settings-actions">
        <button className="primary" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save Agents"}
        </button>
      </div>
    </section>
  );
}

function WorkspaceSection({
  settings,
  onSaved,
  onError,
}: {
  settings: AppSettings;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const { stored, effective } = settings.workspace;
  const [worktreesDir, setWorktreesDir] = useState(stored.worktrees_dir ?? "");
  const [mainDir, setMainDir] = useState(stored.main_workspace_dir ?? "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    onError("");
    try {
      await api("PATCH", "/api/settings/workspace", {
        worktrees_dir: worktreesDir.trim() || null,
        main_workspace_dir: mainDir.trim() || null,
      });
      onSaved();
    } catch (e) {
      onError(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-section">
      <h2>Workspace</h2>
      <p className="muted">
        Absolute paths to existing directories; leave blank to use the default.
        The main-agent cwd is a free choice — no lockdown, no deny-list.
      </p>
      <SettingRow
        label="Worktrees base directory"
        when="next-spawn"
        hint={`Where each worker's git worktree is created. In use now: ${effective.worktrees_dir}`}
      >
        <input
          type="text"
          placeholder={effective.worktrees_dir}
          value={worktreesDir}
          onChange={(e) => setWorktreesDir(e.target.value)}
        />
      </SettingRow>
      <SettingRow
        label="Main agent working directory"
        when="next-spawn"
        hint={`The cwd the main orchestrator's terminal opens in. Default is $HOME. In use now: ${effective.main_workspace_dir}`}
      >
        <input
          type="text"
          placeholder={effective.main_workspace_dir}
          value={mainDir}
          onChange={(e) => setMainDir(e.target.value)}
        />
      </SettingRow>
      <div className="settings-actions">
        <button className="primary" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save Workspace"}
        </button>
      </div>
    </section>
  );
}

/**
 * Two settings that both concern spend but read from opposite sources, which is
 * why the copy works so hard to separate them:
 *
 *  - monthly quota + cycle reset day draw a budget line against the LOCAL
 *    estimate. When the live Claude feed is reachable it brings its own limits
 *    and these are ignored, so the section says so rather than implying they
 *    drive the headline.
 *  - the alert threshold is the other direction entirely: it watches the LIVE
 *    feed's headline meter and is what pages the operator.
 */
function QuotaSection({
  settings,
  onSaved,
  onError,
}: {
  settings: AppSettings;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const { stored, admin_key_set, live_usage_enabled } = settings.quota;
  const [quota, setQuota] = useState(
    stored.monthly_quota_usd === null ? "" : String(stored.monthly_quota_usd),
  );
  const [resetDay, setResetDay] = useState(String(stored.cycle_reset_day));
  const [alertPct, setAlertPct] = useState(
    stored.alert_threshold_percent === null ? "" : String(stored.alert_threshold_percent),
  );
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    onError("");
    try {
      const trimmed = quota.trim();
      const parsed = trimmed === "" ? null : Number(trimmed);
      if (parsed !== null && (!Number.isFinite(parsed) || parsed <= 0)) {
        throw new Error("Monthly quota must be a positive number of dollars, or blank.");
      }
      const pctRaw = alertPct.trim();
      const pct = pctRaw === "" ? null : Number(pctRaw);
      if (pct !== null && (!Number.isInteger(pct) || pct < 1 || pct > 100)) {
        throw new Error("Alert threshold must be a whole number from 1 to 100, or blank.");
      }
      await api("PATCH", "/api/settings/quota", {
        monthly_quota_usd: parsed,
        cycle_reset_day: Number(resetDay),
        alert_threshold_percent: pct,
      });
      onSaved();
    } catch (e) {
      onError(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-section">
      <h2>Spend &amp; quota</h2>
      <p className="muted">
        The monthly quota draws a budget line against the <b>local estimate</b> on the
        Tokens tab. When live Claude usage is available it carries its own limits and takes
        over the headline — the budget line doesn&rsquo;t change it. The alert threshold is
        the other way round: it watches the <b>live feed</b>.
      </p>
      <SettingRow
        label="Monthly quota (USD)"
        when="immediate"
        hint="Blank shows cycle burn with no budget line."
      >
        <input
          type="number"
          min="1"
          step="1"
          placeholder="e.g. 500"
          value={quota}
          onChange={(e) => setQuota(e.target.value)}
        />
      </SettingRow>
      <SettingRow
        label="Cycle reset day"
        when="immediate"
        hint="Day of month the budget resets. 1-28, so every month has it."
      >
        <select value={resetDay} onChange={(e) => setResetDay(e.target.value)}>
          {Array.from({ length: 28 }, (_, i) => String(i + 1)).map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </SettingRow>
      <SettingRow
        label="Quota alert threshold (%)"
        when="immediate"
        hint="Pushes a notification (and raises a Needs You item) once the live feed's busiest meter reaches this share of its window — once per crossing, not once per hourly poll. Blank turns off the utilization alert; hitting the org spend cap still alerts either way. Needs live Claude usage enabled. The push itself can be silenced under Notifications → What gets pushed, which leaves the Needs You item in place."
      >
        <input
          type="number"
          min="1"
          max="100"
          step="5"
          placeholder="off"
          value={alertPct}
          onChange={(e) => setAlertPct(e.target.value)}
        />
      </SettingRow>
      <SettingRow
        label="Live Claude usage"
        when="immediate"
        hint="Off unless CC_LIVE_USAGE=1 is set in the daemon env. When on, the daemon reads the OAuth token Claude Code already stores on this machine (read-only, never refreshed) and shows the same quota figures as the claude.ai usage page — including usage from outside commandcenter."
      >
        <span className={`chip ${live_usage_enabled ? "approved" : ""}`}>
          {live_usage_enabled ? "Enabled" : "Disabled"}
        </span>
      </SettingRow>
      <SettingRow
        label="Org billing data"
        when="immediate"
        hint="Set CC_ANTHROPIC_ADMIN_KEY in the daemon env to pull real dollars from the Anthropic Admin API cost report. Note it reports Console/Platform API spend, which is a different surface from a Claude Code subscription seat."
      >
        <span className={`chip ${admin_key_set ? "approved" : ""}`}>
          {admin_key_set ? "Admin key set" : "Admin key unset"}
        </span>
      </SettingRow>
      <button onClick={save} disabled={saving}>
        {saving ? "Saving…" : "Save"}
      </button>
    </section>
  );
}

function NotificationsSection({
  settings,
  onSaved,
  onError,
}: {
  settings: AppSettings;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const { stored, effective, ntfy_token_set } = settings.notifications;
  const [url, setUrl] = useState(stored.ntfy_url ?? "");
  const [tokenInput, setTokenInput] = useState("");
  const [clearToken, setClearToken] = useState(false);
  const [saving, setSaving] = useState(false);
  // Per-event push toggles, edited as the fully-resolved on/off map. On save we
  // diff against the built-in defaults and store only genuine overrides, so an
  // untouched event keeps following the default if we ever change it.
  const eventSpecs = settings.notify_event_choices ?? [];
  const [events, setEvents] = useState<Record<string, boolean>>(
    () => ({ ...effective.events }),
  );

  // Browser (in-app) alerts: a desktop notification + dock bounce for a new
  // "Needs You" item. Two independent gates — the browser permission (one-way:
  // requestable, not revocable from JS) and this per-browser on/off preference
  // in localStorage. The toggle drives the preference and requests permission
  // when turning on; App's firing effect honors both.
  const notifSupported = typeof Notification !== "undefined";
  const [perm, setPerm] = useState<NotificationPermission>(
    notifSupported ? Notification.permission : "denied",
  );
  const [alertsOn, setAlertsOn] = useState(
    () => notifSupported && browserAlertsEnabled(localStorage, perm === "granted"),
  );
  const toggleAlerts = (on: boolean) => {
    if (!on) {
      setAlertsOn(false);
      setBrowserAlerts(localStorage, false);
      return;
    }
    const commit = (p: NotificationPermission) => {
      setPerm(p);
      const granted = p === "granted";
      setAlertsOn(granted);
      setBrowserAlerts(localStorage, granted); // deny -> stays off, not stuck "on"
    };
    if (perm !== "default") {
      commit(perm); // granted -> on; denied -> can't, stays off
      return;
    }
    try {
      // This click is the user gesture browsers require to prompt.
      const r = Notification.requestPermission(commit);
      if (r && typeof r.then === "function") r.then(commit).catch(() => {});
    } catch {
      /* blocked — leave it off */
    }
  };

  // Keep the toggle honest with the live truth it can't see directly: the
  // preference being flipped in another tab (`storage` fires only in *other*
  // tabs) and the permission being changed via the browser's own site settings.
  useEffect(() => {
    if (!notifSupported) return;
    const sync = () => {
      setPerm(Notification.permission);
      setAlertsOn(browserAlertsEnabled(localStorage, Notification.permission === "granted"));
    };
    window.addEventListener("storage", sync);
    let cancelled = false;
    let status: PermissionStatus | undefined;
    navigator.permissions
      ?.query({ name: "notifications" as PermissionName })
      .then((s) => {
        if (cancelled) return; // unmounted before the query resolved
        status = s;
        s.addEventListener("change", sync);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      window.removeEventListener("storage", sync);
      status?.removeEventListener("change", sync);
    };
  }, [notifSupported]);

  const save = async () => {
    setSaving(true);
    onError("");
    try {
      const eventPatch: Record<string, boolean | null> = {};
      for (const spec of eventSpecs) {
        const on = events[spec.key] ?? spec.default_enabled;
        // null clears the override; only a genuine deviation is stored.
        eventPatch[spec.key] = on === spec.default_enabled ? null : on;
      }
      const body: Record<string, unknown> = {
        ntfy_url: url.trim() || null,
        events: eventPatch,
      };
      // Only touch the token when the operator explicitly set or cleared it —
      // omitting it leaves the stored secret untouched.
      if (clearToken) body.ntfy_token = null;
      else if (tokenInput.trim()) body.ntfy_token = tokenInput;
      await api("PATCH", "/api/settings/notifications", body);
      setTokenInput("");
      setClearToken(false);
      onSaved();
    } catch (e) {
      onError(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-section">
      <h2>Notifications</h2>
      <SettingRow
        label="Browser alerts"
        when="immediate"
        hint="Desktop notification + dock-icon bounce when a new “Needs You” item appears while this tab is open. Per-browser; the dock badge (count) works regardless. Also requires the browser/app to be allowed to notify in your OS settings."
      >
        {!notifSupported ? (
          <span className="muted">This browser doesn’t support notifications.</span>
        ) : perm === "denied" ? (
          <span className="muted">
            Blocked in your browser — allow notifications for this site, then
            reload.
          </span>
        ) : (
          <button
            className={alertsOn ? "sched-on" : ""}
            onClick={() => toggleAlerts(!alertsOn)}
          >
            {alertsOn ? "on" : "off"}
          </button>
        )}
      </SettingRow>
      <p className="muted">
        Push alerts via ntfy (escalations, pages). Overrides CC_NTFY_URL /
        CC_NTFY_TOKEN and applies on the next notification.
      </p>
      <SettingRow
        label="ntfy topic URL"
        when="immediate"
        hint={
          !effective.ntfy_url_set
            ? "No URL configured — push is disabled."
            : stored.ntfy_url
              ? "Push is enabled, using the URL above."
              : "Push is enabled, using CC_NTFY_URL from the daemon’s environment. Set a URL here to override it."
        }
      >
        <input
          type="text"
          placeholder="https://ntfy.sh/your-topic"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </SettingRow>
      <SettingRow
        label="ntfy auth token"
        when="immediate"
        hint="The stored token is never shown. Type a new value to replace it, or clear it."
      >
        <div className="setting-inline">
          <span className={`chip ${ntfy_token_set ? "approved" : ""}`}>
            {ntfy_token_set ? "Token set" : "Token unset"}
          </span>
          <input
            type="password"
            autoComplete="new-password"
            placeholder={ntfy_token_set ? "Replace token…" : "Set token…"}
            value={clearToken ? "" : tokenInput}
            disabled={clearToken}
            onChange={(e) => setTokenInput(e.target.value)}
          />
          {ntfy_token_set && (
            <label className="setting-check">
              <input
                type="checkbox"
                checked={clearToken}
                onChange={(e) => setClearToken(e.target.checked)}
              />
              Clear
            </label>
          )}
        </div>
      </SettingRow>
      <h3>What gets pushed</h3>
      <p className="muted">
        A push should mean “do something now”. The defaults are the smallest set
        that meets that bar; everything else stays in the activity feed. Turn any
        of it back on here.
      </p>
      {(settings.notify_category_choices ?? []).map((cat) => {
        const specs = eventSpecs.filter((s) => s.category === cat.key);
        if (specs.length === 0) return null;
        return (
          <div className="setting-row" key={cat.key}>
            <div className="setting-head">
              <span className="setting-label">{cat.label}</span>
            </div>
            <span className="setting-hint muted">{cat.blurb}</span>
            {specs.map((spec) => {
              const on = events[spec.key] ?? spec.default_enabled;
              return (
                <div key={spec.key}>
                  <label className="setting-check">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) =>
                        setEvents((prev) => ({
                          ...prev,
                          [spec.key]: e.target.checked,
                        }))
                      }
                    />
                    {spec.label}
                    {on !== spec.default_enabled && (
                      <span className="chip">overridden</span>
                    )}
                  </label>
                  <span className="setting-hint muted">{spec.description}</span>
                </div>
              );
            })}
          </div>
        );
      })}
      <div className="settings-actions">
        <button className="primary" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save Notifications"}
        </button>
      </div>
    </section>
  );
}

/** Editable view of one per-repo JIRA row. Allow-lists are edited as comma-
 *  separated text and parsed to arrays on save. */
interface JiraRepoDraft {
  key: string;
  enabled: boolean;
  project: string;
  projects: string;
  issue_types: string;
  labels: string;
}

function csvToArr(s: string): string[] {
  return s
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function arrToCsv(a: string[] | undefined): string {
  return (a ?? []).join(", ");
}

function toRepoDrafts(repos: Record<string, JiraRepoConfig>): JiraRepoDraft[] {
  return Object.entries(repos).map(([key, r]) => ({
    key,
    enabled: r.enabled,
    project: r.project ?? "",
    projects: arrToCsv(r.projects),
    issue_types: arrToCsv(r.issue_types),
    labels: arrToCsv(r.labels),
  }));
}

function JiraSection({
  settings,
  repoSuggestions,
  onSaved,
  onError,
}: {
  settings: AppSettings;
  repoSuggestions: string[];
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const { stored, token_set, base_url } = settings.jira;
  const [enabled, setEnabled] = useState(stored.enabled);
  const [classifierModel, setClassifierModel] = useState(
    stored.classifier_model ?? "sonnet",
  );
  const [assignee, setAssignee] = useState(
    stored.default_assignee_account_id ?? "",
  );
  const [repos, setRepos] = useState<JiraRepoDraft[]>(
    toRepoDrafts(stored.repos ?? {}),
  );
  const [newRepo, setNewRepo] = useState("");
  const [saving, setSaving] = useState(false);

  const setRepo = (i: number, patch: Partial<JiraRepoDraft>) =>
    setRepos((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const addRepo = () => {
    const key = newRepo.trim();
    if (!key) return;
    if (repos.some((r) => r.key === key)) {
      onError(`repo "${key}" is already configured`);
      return;
    }
    onError("");
    setRepos((rs) => [
      ...rs,
      { key, enabled: false, project: "", projects: "", issue_types: "", labels: "" },
    ]);
    setNewRepo("");
  };

  const removeRepo = (i: number) =>
    setRepos((rs) => rs.filter((_, j) => j !== i));

  const save = async () => {
    setSaving(true);
    onError("");
    try {
      const reposOut: Record<string, JiraRepoConfig> = {};
      for (const r of repos) {
        const key = r.key.trim();
        if (!key) continue;
        const cfg: JiraRepoConfig = {
          enabled: r.enabled,
          project: r.project.trim().toUpperCase(),
        };
        const projects = csvToArr(r.projects).map((p) => p.toUpperCase());
        if (projects.length) cfg.projects = projects;
        const its = csvToArr(r.issue_types);
        if (its.length) cfg.issue_types = its;
        const labels = csvToArr(r.labels);
        if (labels.length) cfg.labels = labels;
        reposOut[key] = cfg;
      }
      // assignee_map is intentionally omitted — the top-level merge preserves any
      // hand-edited map. default_assignee_account_id sends null to clear.
      await api("PATCH", "/api/settings/jira", {
        enabled,
        repos: reposOut,
        classifier_model: classifierModel,
        default_assignee_account_id: assignee.trim() || null,
      });
      onSaved();
    } catch (e) {
      onError(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  // Repos not yet configured — offered as add-suggestions.
  const configured = new Set(repos.map((r) => r.key));
  const suggestions = repoSuggestions.filter((s) => !configured.has(s));

  return (
    <section className="settings-section">
      <h2>JIRA</h2>
      <p className="muted">
        commandcenter mints a JIRA ticket for a task iff it opens a PR, on
        enabled repos only. JIRA config is read on every sync pass, so edits
        apply immediately. Secrets stay in the environment: the API token, its
        account email, and the base URL come from{" "}
        <code>CC_JIRA_TOKEN</code> / <code>CC_JIRA_EMAIL</code> /{" "}
        <code>CC_JIRA_BASE_URL</code> and are never set here.
      </p>

      {!token_set && (
        <div className="banner banner-warn">
          JIRA sync disabled: no token configured — set{" "}
          <code>CC_JIRA_TOKEN</code> (and <code>CC_JIRA_EMAIL</code>) in the
          daemon environment. Until then the whole subsystem is inert: no
          tickets are created and nothing below takes effect.
        </div>
      )}

      <SettingRow
        label="Enable JIRA sync (master switch)"
        when="immediate"
        hint="Off = no tickets anywhere, regardless of per-repo settings. Default off."
      >
        <label className="setting-check">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          {enabled ? "Enabled" : "Disabled"}
        </label>
      </SettingRow>

      <SettingRow
        label="Classifier model"
        when="immediate"
        hint="Cheap model for the one-shot ticket classifier (project + issue type). Falls back to the per-repo default on any failure."
      >
        <select
          value={classifierModel}
          onChange={(e) => setClassifierModel(e.target.value)}
        >
          {settings.model_choices.map((slug) => (
            <option key={slug} value={slug}>
              {slug}
            </option>
          ))}
        </select>
      </SettingRow>

      <SettingRow
        label="Default assignee accountId"
        when="immediate"
        hint="JIRA accountId to assign created tickets to. Blank = create unassigned. Not an email."
      >
        <input
          type="text"
          placeholder="e.g. 5b10ac8d82e05b22cc7d4ef5"
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
        />
      </SettingRow>

      <div className="jira-repos">
        <div className="setting-head">
          <span className="setting-label">Per-repo configuration</span>
          <ApplyBadge when="immediate" />
        </div>
        <span className="setting-hint muted">
          Each repo is opt-in (default off) and maps to a default project key
          (<code>^[A-Z][A-Z0-9]+$</code>, e.g. <code>EN</code>). Allow-lists
          are comma-separated; the classifier picks within them, falling back to
          the default project + <code>Task</code>.
        </span>

        {repos.length === 0 && (
          <p className="muted">No repos configured yet.</p>
        )}

        {repos.map((r, i) => (
          <div className="jira-repo-row" key={r.key}>
            <div className="jira-repo-head">
              <code className="jira-repo-key">{r.key}</code>
              <label className="setting-check">
                <input
                  type="checkbox"
                  checked={r.enabled}
                  onChange={(e) => setRepo(i, { enabled: e.target.checked })}
                />
                {r.enabled ? "Enabled" : "Disabled"}
              </label>
              <button className="link-btn" onClick={() => removeRepo(i)}>
                Remove
              </button>
            </div>
            <div className="jira-repo-fields">
              <label>
                Default project
                <input
                  type="text"
                  placeholder="EN"
                  value={r.project}
                  onChange={(e) => setRepo(i, { project: e.target.value })}
                />
              </label>
              <label>
                Projects allow-list
                <input
                  type="text"
                  placeholder="EN, UN, TW"
                  value={r.projects}
                  onChange={(e) => setRepo(i, { projects: e.target.value })}
                />
              </label>
              <label>
                Issue types allow-list
                <input
                  type="text"
                  placeholder="Task, Story, Bug"
                  value={r.issue_types}
                  onChange={(e) => setRepo(i, { issue_types: e.target.value })}
                />
              </label>
              <label>
                Extra labels
                <input
                  type="text"
                  placeholder="backend, from-commandcenter"
                  value={r.labels}
                  onChange={(e) => setRepo(i, { labels: e.target.value })}
                />
              </label>
            </div>
          </div>
        ))}

        <div className="setting-inline">
          <input
            type="text"
            list="jira-repo-suggestions"
            placeholder="Add repo (absolute path or owner/name)"
            value={newRepo}
            onChange={(e) => setNewRepo(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addRepo();
              }
            }}
          />
          <datalist id="jira-repo-suggestions">
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          <button onClick={addRepo}>Add Repo</button>
        </div>
      </div>

      <div className="settings-actions">
        <span className="muted jira-endpoint">
          {base_url}
          {settings.jira.email ? ` · ${settings.jira.email}` : ""}
        </span>
        <button className="primary" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save JIRA"}
        </button>
      </div>
    </section>
  );
}

function SettingsView() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [scheduler, setScheduler] = useState<SchedulerInfo | null>(null);
  const [repositories, setRepositories] = useState<
    WorkspaceCatalog["repositories"]
  >([]);
  const [error, setError] = useState<string>("");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(() => {
    setError("");
    void Promise.all([
      api<AppSettings>("GET", "/api/settings"),
      api<SchedulerInfo>("GET", "/api/scheduler"),
    ])
      .then(([s, sched]) => {
        setSettings(s);
        setScheduler(sched);
      })
      .catch((e) => setError(errMsg(e)))
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // The server-validated repository catalog: JIRA per-repo add-suggestions and
  // the strict-serial toggles both come from it, so a repo key/path is never
  // typed by hand. Best-effort — a failure means no suggestions and no toggles,
  // never a broken settings page.
  useEffect(() => {
    api<WorkspaceCatalog>("GET", "/api/workspaces")
      .then((cat) => setRepositories(cat.repositories))
      .catch(() => setRepositories([]));
  }, []);

  const repoSuggestions = useMemo(
    () =>
      Array.from(
        new Set(repositories.flatMap((r) => [r.path, r.name])),
      ),
    [repositories],
  );

  return (
    <main className="settings-view">
      {error && <div className="error">{error}</div>}
      {!loaded && !error && <span className="muted">Loading settings…</span>}
      {scheduler && (
        // key on the fetched config so a save+refetch re-seeds each section's
        // local draft from the server's canonical values.
        <SchedulerSection
          key={JSON.stringify(scheduler.config)}
          info={scheduler}
          onSaved={load}
          onError={setError}
        />
      )}
      {settings && (
        <>
          <IntegrationSection
            key={`i${JSON.stringify(settings.integration.stored)}`}
            settings={settings}
            repositories={repositories}
            onSaved={load}
            onError={setError}
          />
          <AgentsSection
            key={`a${JSON.stringify(settings.agents.stored)}`}
            settings={settings}
            onSaved={load}
            onError={setError}
          />
          <WorkspaceSection
            key={`w${JSON.stringify(settings.workspace.stored)}`}
            settings={settings}
            onSaved={load}
            onError={setError}
          />
          <NotificationsSection
            key={`n${JSON.stringify(settings.notifications)}`}
            settings={settings}
            onSaved={load}
            onError={setError}
          />
          <QuotaSection
            key={`q${JSON.stringify(settings.quota.stored)}`}
            settings={settings}
            onSaved={load}
            onError={setError}
          />
          <JiraSection
            key={`j${JSON.stringify(settings.jira.stored)}`}
            settings={settings}
            repoSuggestions={repoSuggestions}
            onSaved={load}
            onError={setError}
          />
        </>
      )}
    </main>
  );
}

/**
 * The Docs tab: a read-only viewer for the internal doc store. Docs are listed
 * grouped by project on the left; selecting one fetches its body and renders it
 * as sanitized markdown. Attachments (CSV etc.) are offered as download links.
 */
function DocsView() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [selected, setSelected] = useState<DocWithContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Doc[]>("GET", "/api/docs")
      .then(setDocs)
      .catch((e) => setError(String(e instanceof Error ? e.message : e)));
  }, []);

  const open = async (id: number) => {
    setLoading(true);
    setError(null);
    try {
      setSelected(await api<DocWithContent>("GET", `/api/docs/${id}`));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  };

  // Group by project, preserving the API's updated_at-desc order.
  const order: string[] = [];
  const byProject = new Map<string, Doc[]>();
  for (const d of docs) {
    let bucket = byProject.get(d.project);
    if (!bucket) {
      bucket = [];
      byProject.set(d.project, bucket);
      order.push(d.project);
    }
    bucket.push(d);
  }

  const attachments: string[] = selected?.attachments
    ? (JSON.parse(selected.attachments) as string[])
    : [];

  // The API already returns the body without frontmatter, but parse defensively
  // so a doc whose body still embeds a YAML block renders as a compact header
  // rather than a raw `---` block above the prose.
  const parsed = selected ? parseFrontmatter(selected.content) : null;
  const fmTags = parsed?.data.tags;
  const tags: string[] = selected?.tags
    ? selected.tags.split(",").map((t) => t.trim()).filter(Boolean)
    : Array.isArray(fmTags)
      ? fmTags
      : typeof fmTags === "string"
        ? fmTags.split(",").map((t) => t.trim()).filter(Boolean)
        : [];

  return (
    <main>
      <div className="docs-view">
        <aside className="docs-list">
          {order.map((project) => (
            <div key={project} className="docs-group">
              <h3>{project}</h3>
              {byProject.get(project)!.map((d) => (
                <button
                  key={d.id}
                  className={`docs-item ${selected?.id === d.id ? "active" : ""}`}
                  onClick={() => open(d.id)}
                >
                  <span className="docs-item-title">{d.title}</span>
                  {d.summary && (
                    <span className="docs-item-summary muted">{d.summary}</span>
                  )}
                </button>
              ))}
            </div>
          ))}
          {docs.length === 0 && !error && (
            <span className="muted">No docs yet</span>
          )}
        </aside>
        <section className="docs-body">
          {error && <div className="error">{error}</div>}
          {loading && <span className="muted">Loading…</span>}
          {!loading && !selected && !error && (
            <span className="muted">Select a doc to read it</span>
          )}
          {selected && (
            <>
              <div className="docs-head">
                <h2>{selected.title}</h2>
                <span className="muted">
                  {selected.project} · v{selected.version} · updated{" "}
                  {selected.updated_at.slice(0, 10)}
                </span>
                {tags.length > 0 && (
                  <div className="chips">
                    {tags.map((t) => (
                      <span key={t} className="chip">
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              {attachments.length > 0 && (
                <div className="docs-attachments">
                  <b className="muted">Attachments</b>
                  {attachments.map((rel) => {
                    const name = basename(rel);
                    return (
                      <a
                        key={rel}
                        className="docs-attachment"
                        href={`/api/docs/${selected.id}/attachments/${encodeURIComponent(name)}`}
                      >
                        ⬇ {name}
                      </a>
                    );
                  })}
                </div>
              )}
              <Markdown content={parsed ? parsed.body : selected.content} />
            </>
          )}
        </section>
      </div>
    </main>
  );
}

const KIND_ICON: Record<AttentionItem["kind"], string> = {
  publish_task: "👤",
  merge_pr: "⇧",
  merge_and_apply: "⚡",
  decision: "⚖",
  stalled_transition: "🛑",
  escalation: "⛔",
  stale_waiting: "⏳",
  scheduler_stalled: "🚦",
  orchestration: "◈",
  jira_sync: "🎫",
  quota: "📊",
};

function OperationsSnapshot({
  attentionCount,
  runningCount,
  queuedCount,
  activeProjectCount,
  reviewCount,
  prsAwaitingMerge,
  blockedCount,
  failedCount,
  agentCount,
  mainOnline,
  schedulerEnabled,
}: {
  attentionCount: number;
  runningCount: number;
  queuedCount: number;
  activeProjectCount: number;
  reviewCount: number;
  prsAwaitingMerge: number;
  blockedCount: number;
  failedCount: number;
  agentCount: number;
  mainOnline: boolean;
  schedulerEnabled: boolean;
}) {
  const riskCount = blockedCount + failedCount;
  const items = [
    {
      label: "Needs You",
      value: attentionCount,
      detail: attentionCount === 1 ? "decision waiting" : "decisions waiting",
      tone: attentionCount > 0 ? "warn" : "good",
    },
    {
      label: "Active Work",
      value: runningCount,
      detail: `${queuedCount} queued · ${activeProjectCount} active project${activeProjectCount === 1 ? "" : "s"}`,
      tone: "accent",
    },
    {
      label: "Review Lane",
      value: reviewCount,
      detail: `${prsAwaitingMerge} approved PR${prsAwaitingMerge === 1 ? "" : "s"} awaiting merge`,
      tone: prsAwaitingMerge > 0 ? "good" : "neutral",
    },
    {
      label: "Risk",
      value: riskCount,
      detail: `${blockedCount} blocked · ${failedCount} failed`,
      tone: riskCount > 0 ? "danger" : "good",
    },
    {
      label: "Agent Fleet",
      value: agentCount,
      detail: `${mainOnline ? "main online" : "main offline"} · ${schedulerEnabled ? "auto on" : "auto off"}`,
      tone: mainOnline ? "accent" : "warn",
    },
  ];

  return (
    <section className="ops-snapshot" aria-label="Operations snapshot">
      {items.map((item) => (
        <div key={item.label} className={`ops-tile tone-${item.tone}`}>
          <span className="ops-label">{item.label}</span>
          <b>{item.value}</b>
          <span className="ops-detail">{item.detail}</span>
        </div>
      ))}
    </section>
  );
}

/**
 * The pinned "Needs You" queue. Always shown on the board: a severity-colored
 * row per action when non-empty, collapsed to a single reassuring line when
 * there's nothing to do.
 */
function AttentionPanel({
  items,
  onDismiss,
  onOpenTask,
}: {
  items: AttentionItem[];
  onDismiss: (key: string) => void;
  onOpenTask: (taskId: number) => void;
}) {
  if (items.length === 0) {
    return (
      <section className="attention empty">
        <span className="muted">✓ Nothing needs you</span>
      </section>
    );
  }
  return (
    <section className="attention">
      <h2>
        Needs You <span className="muted">{items.length}</span>
      </h2>
      {items.map((it) => (
        <div key={it.id} className={`attention-row sev-${it.severity}`}>
          <span className="att-icon" title={it.kind}>
            {KIND_ICON[it.kind]}
          </span>
          <div className="att-main">
            <div className="att-title">
              {it.title}
              {it.urgent && <span className="att-urgent">Urgent</span>}
            </div>
            {it.context && <div className="att-context muted">{it.context}</div>}
          </div>
          <span className="att-age muted" title={it.created_at}>
            {fmtAge(it.age_ms)}
          </span>
          {it.pr_url ? (
            <a
              className="att-open"
              href={it.pr_url}
              target="_blank"
              rel="noreferrer"
            >
              Open
            </a>
          ) : it.task_id != null ? (
            <button className="att-open" onClick={() => onOpenTask(it.task_id!)}>
              Open
            </button>
          ) : (
            <span className="att-open" />
          )}
          <button className="att-dismiss" onClick={() => onDismiss(it.id)}>
            Dismiss
          </button>
        </div>
      ))}
    </section>
  );
}

/**
 * Inline "what is this agent asking?" panel for a waiting_input row — the
 * whole point being that Caleb (or the orchestrator) can answer it right
 * here instead of opening the terminal to find out. Every action is an
 * explicit click; nothing here is ever auto-sent.
 */
function AgentPane({
  agentId,
  pane,
  onAction,
  onOpenTerminal,
}: {
  agentId: number;
  pane: ParsedPane | undefined;
  onAction: (fn: () => Promise<unknown>) => Promise<void>;
  onOpenTerminal: () => void;
}) {
  const [reply, setReply] = useState("");
  const send = (text: string) =>
    onAction(() => api("POST", `/api/agents/${agentId}/send`, { text }));

  const submitReply = () => {
    if (!reply.trim()) return;
    void send(reply.trim());
    setReply("");
  };

  return (
    <div className="agent-pane">
      {pane?.unsubmitted_input && (
        <div className="pane-banner">
          <span>
            Unsubmitted text in prompt: "{pane.unsubmitted_input}"
          </span>
          <div className="pane-banner-actions">
            <button
              className="primary"
              onClick={() =>
                onAction(() => api("POST", `/api/agents/${agentId}/submit-input`, {}))
              }
            >
              Submit It
            </button>
            <button
              className="danger"
              onClick={() =>
                onAction(() => api("POST", `/api/agents/${agentId}/clear-input`, {}))
              }
            >
              Clear It
            </button>
          </div>
        </div>
      )}

      {pane?.pending_permission && (
        <div className="pane-block">
          <div className="pane-question">{pane.pending_permission.question}</div>
          <div className="pane-options">
            {pane.pending_permission.options.map((o) => (
              <button key={o.n} onClick={() => send(String(o.n))}>
                {o.n}. {o.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {!pane?.pending_permission && pane?.pending_question && (
        <div className="pane-block">
          <div className="pane-question">{pane.pending_question}</div>
          {pane.unsubmitted_input ? (
            // Sending now would type the reply directly after whatever's
            // already sitting unsubmitted in the prompt, garbling both into
            // one message — resolve the banner above first.
            <span className="muted">
              Resolve the unsubmitted text above before replying
            </span>
          ) : (
            <div className="pane-reply">
              <input
                placeholder="Reply…"
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitReply();
                }}
              />
              <button className="primary" disabled={!reply.trim()} onClick={submitReply}>
                Send
              </button>
            </div>
          )}
        </div>
      )}

      <button className="pane-terminal-link" onClick={onOpenTerminal}>
        Open Terminal
      </button>
    </div>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function TokensView({
  tasks,
  usage,
  onRefreshUsage,
  refreshingUsage,
  onSelect,
}: {
  tasks: Task[];
  usage: UsagePayload | null;
  onRefreshUsage: () => void;
  refreshingUsage: boolean;
  onSelect: (t: Task) => void;
}) {
  // Cycle-to-date is the default: an all-time counter can't answer "how much
  // of this month's quota is left", which is the question this tab exists for.
  const [view, setView] = useState<"cycle" | "all">("cycle");
  const tracked = tasks.filter((t) => (t.tokens_used ?? 0) > 0);
  const total = tracked.reduce((s, t) => s + (t.tokens_used ?? 0), 0);
  const rows = [...tracked].sort(
    (a, b) => (b.tokens_used ?? 0) - (a.tokens_used ?? 0),
  );

  // Not `window` — that shadows the DOM global inside this component.
  const activeWindow = usage ? (view === "cycle" ? usage.local.cycle : usage.local.all_time) : null;
  const projected =
    usage && view === "cycle"
      ? projectedCycleSpend(usage.local.cycle.cost_usd, usage.local.cycle)
      : null;

  return (
    <main>
      <div className="tokens-view">
        <section className="dashboard-panel">
          <div className="panel-head">
            <div>
              <span className="eyebrow">Quota</span>
              <h2>Usage this cycle</h2>
            </div>
          </div>
          <SpendHeadline
            usage={usage}
            onRefresh={onRefreshUsage}
            refreshing={refreshingUsage}
          />
        </section>

        <div className="view-toggle">
          <button
            className={view === "cycle" ? "sched-on" : ""}
            onClick={() => setView("cycle")}
          >
            This cycle
          </button>
          <button className={view === "all" ? "sched-on" : ""} onClick={() => setView("all")}>
            All time
          </button>
        </div>

        {usage && activeWindow && (
          <>
            <div className="stat-cards">
              <div className="stat-card">
                <b>{fmtUsd(activeWindow.cost_usd)}</b>
                <span className="muted">
                  Estimated {view === "cycle" ? "this cycle" : "all time"}
                </span>
              </div>
              <div className="stat-card">
                <b>{fmtTokens(activeWindow.tokens)}</b>
                <span className="muted">Tokens</span>
              </div>
              {view === "cycle" && projected !== null && (
                <div className="stat-card">
                  <b>{fmtUsd(projected)}</b>
                  <span className="muted">Projected at this pace</span>
                </div>
              )}
              {view === "cycle" && (
                <div className="stat-card">
                  <b>
                    {usage.local.cycle.days_elapsed}/{usage.local.cycle.days_total}
                  </b>
                  <span className="muted">Days into cycle</span>
                </div>
              )}
            </div>

            {view === "cycle" && <BurnChart usage={usage} />}

            {activeWindow.by_model.length > 0 && (
              <table className="token-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th className="num">Tokens</th>
                    <th className="num">Estimated</th>
                  </tr>
                </thead>
                <tbody>
                  {activeWindow.by_model.map((m) => (
                    <tr key={m.model}>
                      <td>{m.model}</td>
                      <td className="num">{fmtTokens(m.tokens)}</td>
                      <td className="num">
                        {m.priced ? (
                          fmtUsd(m.cost_usd)
                        ) : (
                          <span className="muted" title="No price on file for this model — its tokens are counted but not costed">
                            not priced
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <p className="muted token-note">
              Per-day and per-model figures are a <b>local estimate</b> from session
              transcripts priced against a static rate table — not billing data. They cover
              only work this daemon ran, so they will read lower than the org figure above,
              which also counts interactive Claude Code sessions.{" "}
              {/* Fast mode roughly doubles the per-token rate and leaves no marker in
                  the transcript, so there is no way to detect it here. Saying so
                  matters: it is a ~2x undercount on exactly the heaviest days, and an
                  unstated one would make this gauge read as truth. */}
              They also assume standard rates: <b>fast mode</b> bills about twice as much
              (Opus 5 at $10/$50 per Mtok against the standard $5/$25) and isn&rsquo;t
              recorded in the transcript, so on days you used it the estimate is a floor,
              not a total.
              {usage.local.tracked_since
                ? ` Daily tracking starts ${usage.local.tracked_since}.`
                : " No daily burn recorded yet — tracking starts at the next agent Stop."}
            </p>
          </>
        )}

        <div className="panel-subhead muted">Lifetime tokens per task</div>
        {rows.length > 0 ? (
          <table className="token-table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Model</th>
                <th>Status</th>
                <th className="num">Tokens</th>
                <th className="num">Share</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} onClick={() => onSelect(t)}>
                  <td>
                    #{t.id} {t.title}
                  </td>
                  <td>{t.model ?? "—"}</td>
                  <td>
                    <span className={`chip ${t.status}`}>{statusText(t.status)}</span>
                  </td>
                  <td className="num">{fmtTokens(t.tokens_used ?? 0)}</td>
                  <td className="num muted">
                    {total ? Math.round(((t.tokens_used ?? 0) / total) * 100) : 0}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <span className="muted">
            No token data yet — usage is recorded each time a worker finishes a turn
          </span>
        )}
        <p className="muted token-note">
          Input + output + cache tokens summed from session transcripts.
          Approximate: a fresh (non-resumed) respawn resets a task's count.
        </p>
      </div>
    </main>
  );
}

function MainAgentSpawn({
  onSpawn,
}: {
  onSpawn: (model?: string) => Promise<void>;
}) {
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [modelChoice, setModelChoice] = useState("");
  const [customModel, setCustomModel] = useState("");

  useEffect(() => {
    let cancelled = false;
    void api<{ default_main_model?: string }>("GET", "/api/providers")
      .then((metadata) => {
        if (!cancelled && metadata.default_main_model) {
          setDefaultModel(metadata.default_main_model);
        }
      })
      .catch(() => {});
    void api<{ models: ProviderModel[] }>("GET", "/api/providers/claude/models")
      .then((catalog) => {
        if (!cancelled) setModels(catalog.models);
      })
      .catch(() => {
        // The configured default and custom escape hatch still work without a catalog.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedModel =
    modelChoice === "__custom__" ? customModel.trim() : modelChoice;

  return (
    <div className="main-spawn">
      <select
        aria-label="Main agent model"
        value={modelChoice}
        onChange={(e) => {
          setModelChoice(e.target.value);
          if (e.target.value !== "__custom__") setCustomModel("");
        }}
      >
        <option value="">
          Claude {defaultModel ? `${defaultModel} (default)` : "configured default"}
        </option>
        {models.filter((model) => model.slug !== defaultModel).map((model) => (
          <option key={model.slug} value={model.slug}>
            {model.display_name}
            {model.description ? ` — ${model.description}` : ""}
          </option>
        ))}
        <option value="__custom__">Custom Claude model…</option>
      </select>
      {modelChoice === "__custom__" && (
        <input
          aria-label="Custom main agent model"
          placeholder="Claude model slug"
          value={customModel}
          onChange={(e) => setCustomModel(e.target.value)}
        />
      )}
      <button
        disabled={modelChoice === "__custom__" && !selectedModel}
        onClick={() => onSpawn(selectedModel || undefined)}
      >
        ▶ Spawn Main Agent
      </button>
    </div>
  );
}

function TaskPanel({
  task,
  agents,
  onClose,
  onAction,
  onTerminal,
  onTranscript,
}: {
  task: Task;
  agents: Agent[];
  onClose: () => void;
  onAction: (fn: () => Promise<unknown>) => Promise<void>;
  onTerminal: (agentId: number) => void;
  onTranscript: (sessionId: string, provider: "claude" | "codex") => Promise<void>;
}) {
  const [publicationPrUrl, setPublicationPrUrl] = useState(task.pr_url ?? "");
  // "Notify Claude Main" does not always reach the main agent right away — a
  // busy or mid-draft composer defers the send and the ping is queued instead.
  // Say so, rather than letting a silent success imply instant delivery. (A
  // genuinely undeliverable ping 409s and surfaces in the global error banner.)
  const [delegateNote, setDelegateNote] = useState<{
    tone: NoteTone;
    message: string;
  } | null>(null);
  const [sessionDetails, setSessionDetails] = useState<TaskSession | null>(null);
  const [sessionCopyState, setSessionCopyState] = useState<
    "idle" | "loading" | "copied" | "manual" | "error"
  >("idle");
  const linkedAgent = task.agent_id
    ? agents.find((agent) => agent.id === task.agent_id)
    : undefined;
  const liveTaskAgent = agents.find(
    (agent) => agent.task_id === task.id && agent.kind !== "main",
  );
  // `agents` is the daemon's live-only list. A task keeps its historical
  // agent_id after reaping for transcript/session provenance, so presence in
  // this list—not agent_id alone—is what makes Terminal a valid action.
  const terminalLive = Boolean(linkedAgent);
  const approvedWorkerIsStopped =
    task.status === "review" &&
    task.review_verdict === "approve" &&
    !liveTaskAgent;

  useEffect(() => {
    setSessionDetails(null);
    setSessionCopyState("idle");
  }, [task.id, task.session_id]);

  const copyResumeCommand = async () => {
    setSessionCopyState("loading");
    try {
      const details = await api<TaskSession>(
        "GET",
        `/api/tasks/${task.id}/session`,
      );
      setSessionDetails(details);
      try {
        if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
        await navigator.clipboard.writeText(details.resume_command);
        setSessionCopyState("copied");
      } catch {
        setSessionCopyState("manual");
      }
    } catch {
      setSessionDetails(null);
      setSessionCopyState("error");
    }
  };

  return (
    <div className="drawer">
      <div className="drawer-head">
        <b>
          #{task.id} {task.title}
        </b>
        <span className={`chip ${task.status}`}>{statusText(task.status)}</span>
        <div className="spacer" />
        <button onClick={onClose}>Close</button>
      </div>
      <div className="panel-body">
        <div className="field-label">Prompt</div>
        <div className="prompt">
          <CollapsibleMarkdown content={task.prompt} looseLineBreaks />
        </div>
        <dl>
          <dt>Workspace</dt>
          <dd>
            {task.workspace_kind === "portfolio"
              ? "All repositories"
              : task.workspace_kind === "scratch"
                ? "Investigation scratch"
                : "Repository"}
          </dd>
          <dt>{task.workspace_kind === "portfolio" ? "Root" : "Path"}</dt>
          <dd>{task.repo}</dd>
          {task.parent_task_id && (
            <>
              <dt>Parent</dt>
              <dd>#{task.parent_task_id}</dd>
            </>
          )}
          <dt>Dispatch</dt>
          <dd>{task.dispatch_mode === "orchestrated" ? "Claude main" : "Direct scheduler"}</dd>
          <dt>Worker</dt>
          <dd>
            {task.worker_provider}
            {task.model ? ` · ${task.model}` : " · default model"}
            {task.reasoning_effort ? ` · ${task.reasoning_effort}` : ""}
          </dd>
          <dt>Publication</dt>
          <dd>
            {task.publication_mode === "human"
              ? `Human publishes${task.publication_state ? ` · ${task.publication_state.replaceAll("_", " ")}` : ""}`
              : "Agent publishes"}
          </dd>
          {task.branch && (
            <>
              <dt>Branch</dt>
              <dd>{task.branch}</dd>
            </>
          )}
          {task.worktree && (
            <>
              <dt>Worktree</dt>
              <dd>{task.worktree}</dd>
            </>
          )}
          {task.session_id && (
            <>
              <dt>Session</dt>
              <dd>
                <div>
                  {task.session_provider ?? task.worker_provider} ·{" "}
                  <span className="session-id">{task.session_id}</span>
                </div>
                <button
                  className="session-copy"
                  disabled={sessionCopyState === "loading"}
                  onClick={() => void copyResumeCommand()}
                >
                  {sessionCopyState === "loading"
                    ? "Loading…"
                    : sessionCopyState === "copied"
                      ? "✓ Resume command copied"
                      : sessionCopyState === "error"
                        ? "Retry resume command"
                      : "Copy resume command"}
                </button>
                {sessionDetails && (
                  <code className="resume-command">
                    {sessionDetails.resume_command}
                  </code>
                )}
                {sessionCopyState === "manual" && (
                  <div className="muted">
                    Clipboard access is unavailable; copy the command shown above.
                  </div>
                )}
                {sessionCopyState === "error" && (
                  <div className="muted">
                    Could not load the resume command. Try again.
                  </div>
                )}
              </dd>
            </>
          )}
          {task.verify_cmd && (
            <>
              <dt>Verify</dt>
              <dd>{task.verify_cmd}</dd>
            </>
          )}
          {task.tokens_used != null && task.tokens_used > 0 && (
            <>
              <dt>Tokens</dt>
              <dd>{fmtTokens(task.tokens_used)}</dd>
            </>
          )}
          {task.pr_url && (
            <>
              <dt>PR</dt>
              <dd>
                <a href={task.pr_url} target="_blank" rel="noreferrer">
                  {task.pr_url}
                </a>
              </dd>
            </>
          )}
        </dl>
        {task.result_summary && (
          <>
            <div className="field-label">Result</div>
            <CollapsibleMarkdown content={task.result_summary} looseLineBreaks />
          </>
        )}
        {task.review_notes && (
          <>
            <div className="field-label">Review notes</div>
            <CollapsibleMarkdown content={task.review_notes} looseLineBreaks />
          </>
        )}
        {task.publication_mode === "human" &&
          task.publication_state === "awaiting_human" &&
          task.review_verdict === "approve" && (
            <div className="prompt">
              Automated review approved this exact working-tree snapshot.
              Review the uncommitted changes in GitHub Desktop, commit and
              publish them without changing the content, then confirm below.
              {task.open_pr !== 0 && (
                <input
                  type="url"
                  placeholder="https://github.com/owner/repo/pull/123"
                  value={publicationPrUrl}
                  onChange={(e) => setPublicationPrUrl(e.target.value)}
                />
              )}
            </div>
          )}
        {approvedWorkerIsStopped && (
          <div className="prompt">
            The approved worker is no longer live. Command Center normally
            stops it after the grace period to free its concurrency slot.
            {task.session_id
              ? " Its provider session is preserved."
              : " No resumable provider session was recorded, so resuming will start a fresh one with the saved handoff."}{" "}
            Resume it only if you want more work: doing so reopens the task and
            invalidates this approval.
          </div>
        )}
        <div className="actions">
          {canNotifyMain(task) && (
            <button
              className="primary"
              onClick={() => {
                setDelegateNote(null);
                void onAction(async () => {
                  const res = await api<{ status?: string }>(
                    "POST",
                    `/api/tasks/${task.id}/delegate`,
                    {},
                  );
                  setDelegateNote(delegateOutcomeNote(res.status));
                });
              }}
            >
              Notify Claude Main
            </button>
          )}
          {canSpawnWorker(task) && (
            <button
              // Secondary next to "Notify Claude Main": on an orchestrated task
              // this bypasses main's triage and starts the worker now.
              className={canNotifyMain(task) ? undefined : "primary"}
              title={
                canNotifyMain(task)
                  ? "Spawn the worker now, without waiting for Claude main's triage"
                  : undefined
              }
              onClick={() =>
                onAction(() => api("POST", "/api/agents", { task_id: task.id }))
              }
            >
              ▶ Spawn Worker
            </button>
          )}
          {terminalLive && task.agent_id && (
            <button onClick={() => onTerminal(task.agent_id!)}>Terminal</button>
          )}
          {approvedWorkerIsStopped && (
            <button
              className="primary"
              onClick={() => {
                const instructions = window.prompt(
                  `Resume the worker for task #${task.id}?\n\nThis reopens the task and invalidates its current automated approval. Add the follow-up or changed requirement below, or leave it blank to continue from the preserved session.`,
                  "",
                );
                if (instructions === null) return;
                void onAction(() =>
                  api("POST", `/api/tasks/${task.id}/resume-worker`, {
                    ...(instructions.trim()
                      ? { instructions: instructions.trim() }
                      : {}),
                  }),
                );
              }}
            >
              ↺ Resume Worker
            </button>
          )}
          {task.session_id && (
            <button
              onClick={() =>
                onTranscript(task.session_id!, task.session_provider ?? "claude")
              }
            >
              Transcript
            </button>
          )}
          {task.publication_mode === "human" &&
            task.publication_state === "awaiting_human" &&
            task.review_verdict === "approve" && (
              <button
                className="primary"
                disabled={task.open_pr !== 0 && !publicationPrUrl.trim()}
                onClick={() =>
                  onAction(() =>
                    api("POST", `/api/tasks/${task.id}/publication`, {
                      ...(publicationPrUrl.trim()
                        ? { pr_url: publicationPrUrl.trim() }
                        : {}),
                    }),
                  )
                }
              >
                ✓ Confirm Published
              </button>
            )}
          {task.status === "review" &&
            !(
              task.publication_mode === "human" &&
              task.publication_state !== "published"
            ) && (
            <button
              className="primary"
              onClick={() =>
                onAction(() =>
                  api("PATCH", `/api/tasks/${task.id}`, { status: "done" }),
                )
              }
            >
              ✓ Mark Done
            </button>
          )}
          {["blocked", "review", "failed"].includes(task.status) &&
            !(
              task.status === "review" &&
              task.review_verdict === "approve"
            ) && (
            <button
              onClick={() =>
                onAction(() =>
                  api("PATCH", `/api/tasks/${task.id}`, { status: "queued" }),
                )
              }
            >
              ↺ Requeue
            </button>
          )}
          {isArchived(task.status) && (
            <button
              className="primary"
              onClick={() => {
                const instructions = window.prompt(
                  `Resume task #${task.id}?\n\nAdd changed requirements, or leave this blank to continue from the archived result.${task.dispatch_mode === "orchestrated" ? " Claude main will triage it before the worker resumes." : ""}`,
                  "",
                );
                if (instructions === null) return;
                void onAction(() =>
                  api("POST", `/api/tasks/${task.id}/resume`, {
                    ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
                  }),
                );
              }}
            >
              ↺ Resume Task
            </button>
          )}
          {!["done", "cancelled"].includes(task.status) && (
            <button
              className="danger"
              onClick={() => {
                const approvedHumanWork =
                  task.publication_mode === "human" &&
                  task.publication_state === "awaiting_human" &&
                  task.review_verdict === "approve";
                const retained = approvedHumanWork
                  ? "the approved snapshot and worktree are retained for recovery"
                  : task.workspace_kind === "repo"
                    ? "the branch survives"
                    : task.workspace_kind === "scratch"
                      ? "scratch files are retained until cleanup"
                      : "existing child tasks are not cancelled automatically";
                if (!confirm(`Cancel task #${task.id}? Live agents are killed; ${retained}.`)) return;
                void onAction(() => api("POST", `/api/tasks/${task.id}/cancel`, {}));
              }}
            >
              ✕ Cancel Task
            </button>
          )}
        </div>
        {delegateNote && (
          <div className={`banner banner-${delegateNote.tone}`}>
            {delegateNote.message}
          </div>
        )}
      </div>
    </div>
  );
}

function CronsDrawer({ onClose }: { onClose: () => void }) {
  const [crons, setCrons] = useState<CronJob[]>([]);

  const load = useCallback(async () => {
    setCrons(await api<CronJob[]>("GET", "/api/crons"));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const patch = async (id: number, body: Record<string, unknown>) => {
    await api("PATCH", `/api/crons/${id}`, body);
    load();
  };

  return (
    <div className="drawer">
      <div className="drawer-head">
        <b>Crons</b>
        <div className="spacer" />
        <button onClick={onClose}>Close</button>
      </div>
      <div className="panel-body">
        {crons.map((c) => (
          <div key={c.id} className="memory-item">
            <div className="memory-meta">
              <b>
                {c.name} <span className="muted">· {c.schedule}</span>
              </b>
              <span>
                <button onClick={() => patch(c.id, { enabled: !c.enabled })}>
                  {c.enabled ? "Disable" : "Enable"}
                </button>{" "}
                <button
                  onClick={async () => {
                    await api("POST", `/api/crons/${c.id}/run`);
                    load();
                  }}
                >
                  Run Now
                </button>{" "}
                <button
                  className="danger"
                  onClick={async () => {
                    await api("DELETE", `/api/crons/${c.id}`);
                    load();
                  }}
                >
                  Delete
                </button>
              </span>
            </div>
            <div className="muted">
              {c.enabled ? `next ${c.next_run_at?.slice(0, 16) ?? "?"}` : "disabled"}
              {c.last_run_at ? ` · last ${c.last_run_at.slice(0, 16)}` : " · never run"}
              {` · ${c.worker_provider}`}
              {c.model ? ` · ${c.model}` : ""}
              {c.reasoning_effort ? ` · ${c.reasoning_effort}` : ""} · {c.repo.split("/").pop()}
            </div>
            <div>{c.title}</div>
          </div>
        ))}
        {crons.length === 0 && (
          <span className="muted">
            No crons — create one with: agp cron add &lt;name&gt; -s "0 3 * * *" -p "..."
          </span>
        )}
      </div>
    </div>
  );
}

function MemoryDrawer({ onClose }: { onClose: () => void }) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [query, setQuery] = useState("");
  const [newText, setNewText] = useState("");

  const load = useCallback(async (q: string) => {
    const qs = q.trim() ? `?q=${encodeURIComponent(q)}&limit=30` : "?limit=30";
    setMemories(await api<Memory[]>("GET", `/api/memories${qs}`));
  }, []);

  useEffect(() => {
    const t = setTimeout(() => load(query), 250);
    return () => clearTimeout(t);
  }, [query, load]);

  return (
    <div className="drawer">
      <div className="drawer-head">
        <b>Memory</b>
        <div className="spacer" />
        <button onClick={onClose}>Close</button>
      </div>
      <div className="panel-body">
        <input
          placeholder="Search memories…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="memory-add">
          <textarea
            placeholder="Store a new memory…"
            rows={2}
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
          />
          <button
            className="primary"
            disabled={!newText.trim()}
            onClick={async () => {
              await api("POST", "/api/memories", { text: newText.trim() });
              setNewText("");
              load(query);
            }}
          >
            Remember
          </button>
        </div>
        {memories.map((m) => (
          <div key={m.id} className="memory-item">
            <div className="memory-meta">
              <span className="muted">
                #{m.id} · {m.created_at.slice(0, 10)}
                {m.tags ? ` · ${m.tags}` : ""}
                {m.task_id ? ` · task #${m.task_id}` : ""}
                {m.use_count > 0 ? ` · recalled ${m.use_count}×` : ""}
              </span>
              <button
                className="danger"
                onClick={async () => {
                  await api("DELETE", `/api/memories/${m.id}`);
                  load(query);
                }}
              >
                Forget
              </button>
            </div>
            <div>{m.text}</div>
          </div>
        ))}
        {memories.length === 0 && <span className="muted">No memories</span>}
      </div>
    </div>
  );
}

function NewTaskForm({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (body: Record<string, unknown>) => void;
}) {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [repo, setRepo] = useState("");
  const [workspaceKind, setWorkspaceKind] = useState<WorkspaceKind>("repo");
  const [repoRoot, setRepoRoot] = useState("");
  const [workspaceCatalog, setWorkspaceCatalog] =
    useState<WorkspaceCatalog | null>(null);
  const [workspacesLoading, setWorkspacesLoading] = useState(true);
  const [workspacesError, setWorkspacesError] = useState("");
  const [modelChoice, setModelChoice] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [reasoningEffort, setReasoningEffort] =
    useState<ReasoningEffort>("high");
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsUnavailable, setModelsUnavailable] = useState(false);
  const [provider, setProvider] = useState<"" | "claude" | "codex">("");
  const [verify, setVerify] = useState("");
  const [priority, setPriority] = useState(2);

  useEffect(() => {
    let cancelled = false;
    setWorkspacesLoading(true);
    void api<WorkspaceCatalog>("GET", "/api/workspaces")
      .then((catalog) => {
        if (cancelled) return;
        setWorkspaceCatalog(catalog);
        setRepoRoot((current) => current || catalog.roots[0]?.path || "");
        setWorkspacesError("");
      })
      .catch(() => {
        if (!cancelled) setWorkspacesError("repository catalog unavailable");
      })
      .finally(() => {
        if (!cancelled) setWorkspacesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void api<{ default_worker_provider: "claude" | "codex" }>(
      "GET",
      "/api/providers",
    )
      .then((result) => {
        if (!cancelled) {
          setProvider((current) => current || result.default_worker_provider);
        }
      })
      .catch(() => {
        // Older daemons do not expose provider metadata; keep system default.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!provider) {
      setModels([]);
      return;
    }
    let cancelled = false;
    setModelsLoading(true);
    setModelsUnavailable(false);
    void api<{ models: ProviderModel[] }>("GET", `/api/providers/${provider}/models`)
      .then((result) => {
        if (!cancelled) setModels(result.models);
      })
      .catch(() => {
        if (!cancelled) {
          setModels([]);
          setModelsUnavailable(true);
        }
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [provider]);

  const selectedModel =
    modelChoice === "__custom__" ? customModel.trim() : modelChoice;
  const selectedCatalogModel = models.find((model) => model.slug === selectedModel);
  const availableReasoningLevels = useMemo(() => {
    if (provider !== "codex") return [];
    if (modelChoice === "__custom__") return ALL_REASONING_LEVELS;
    if (selectedCatalogModel?.reasoning_levels.length) {
      return selectedCatalogModel.reasoning_levels;
    }
    if (modelChoice) return BASE_REASONING_LEVELS;
    if (models.length === 0) return BASE_REASONING_LEVELS;
    const common = ALL_REASONING_LEVELS.filter((level) =>
      models.every((model) =>
        model.reasoning_levels.some((candidate) => candidate.effort === level.effort),
      ),
    );
    return common.length > 0 ? common : BASE_REASONING_LEVELS;
  }, [provider, modelChoice, selectedCatalogModel, models]);
  const effectiveReasoningEffort = availableReasoningLevels.some(
    (level) => level.effort === reasoningEffort,
  )
    ? reasoningEffort
    : (availableReasoningLevels.find((level) => level.effort === "high")?.effort ??
      availableReasoningLevels[0]?.effort ??
      "high");

  useEffect(() => {
    if (provider === "codex" && effectiveReasoningEffort !== reasoningEffort) {
      setReasoningEffort(effectiveReasoningEffort);
    }
  }, [provider, reasoningEffort, effectiveReasoningEffort]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New Task</h2>
        <input
          placeholder="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
        />
        <textarea
          placeholder="Prompt — what should be accomplished?"
          rows={6}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <div className="workspace-picker">
          <label>
            <span>Workspace</span>
            <select
              aria-label="Workspace type"
              value={workspaceKind}
              onChange={(e) => setWorkspaceKind(e.target.value as WorkspaceKind)}
            >
              <option value="repo">Repository</option>
              <option
                value="portfolio"
                disabled={!workspacesLoading && workspaceCatalog?.roots.length === 0}
              >
                All repositories — Claude scopes it
              </option>
              <option value="scratch">Investigation — empty scratch workspace</option>
            </select>
          </label>

          {workspaceKind === "repo" &&
            !workspacesLoading &&
            workspaceCatalog?.roots.length === 0 && (
            <label>
              <span>Repository</span>
              <input
                aria-label="Repository path"
                placeholder="Repo (absolute path)"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
              />
            </label>
          )}

          {workspaceKind === "repo" &&
            (workspacesLoading || (workspaceCatalog?.roots.length ?? 0) > 0) && (
            <label>
              <span>Repository</span>
              <select
                aria-label="Repository"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                disabled={workspacesLoading || !workspaceCatalog?.repositories.length}
              >
                <option value="">
                  {workspacesLoading
                    ? "Loading repositories…"
                    : workspaceCatalog?.repositories.length
                      ? "Select a repository…"
                      : "No repositories configured"}
                </option>
                {workspaceCatalog?.repositories.map((entry) => (
                  <option key={entry.path} value={entry.path}>
                    {workspaceCatalog.roots.length > 1
                      ? `${entry.root.split("/").pop()} / `
                      : ""}
                    {entry.relative_path}
                  </option>
                ))}
              </select>
            </label>
          )}

          {workspaceKind === "portfolio" && (
            <label>
              <span>Repository root</span>
              <select
                aria-label="Repository root"
                value={repoRoot}
                onChange={(e) => setRepoRoot(e.target.value)}
                disabled={workspacesLoading || !workspaceCatalog?.roots.length}
              >
                <option value="">
                  {workspacesLoading ? "Loading roots…" : "Select a root…"}
                </option>
                {workspaceCatalog?.roots.map((root) => (
                  <option key={root.path} value={root.path}>
                    {root.label} — {root.path}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="workspace-help">
            {workspaceKind === "repo" && workspaceCatalog?.roots.length === 0 &&
              "No repository allow-list is configured, so this deployment uses the legacy absolute-path workflow."}
            {workspaceKind === "repo" && workspaceCatalog?.roots.length !== 0 &&
              "Claude main studies the task, then starts one worker in an isolated Git worktree."}
            {workspaceKind === "portfolio" &&
              "Claude main identifies every affected repository and creates isolated child tasks. The root is never given to a write-capable worker."}
            {workspaceKind === "scratch" &&
              `Command Center creates a private, non-Git workspace and retains it for ${workspaceCatalog?.scratch_retention_days ?? 7} days after completion.`}
          </div>
          {workspacesError && <div className="workspace-error">{workspacesError}</div>}
        </div>
        <div className="row">
          <select
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value as "" | "claude" | "codex");
              setModelChoice("");
              setCustomModel("");
              setReasoningEffort("high");
            }}
          >
            <option value="">Provider (system default)</option>
            <option value="claude">Claude Code</option>
            <option value="codex">Codex</option>
          </select>
          <select
            value={modelChoice}
            onChange={(e) => setModelChoice(e.target.value)}
          >
            <option value="">Model (provider default)</option>
            {modelsLoading && <option disabled>Loading models…</option>}
            {models.map((option) => (
              <option key={option.slug} value={option.slug}>
                {option.display_name}
                {option.description ? ` — ${option.description}` : ""}
              </option>
            ))}
            <option value="__custom__">
              {modelsUnavailable ? "Model catalog unavailable — type model…" : "Custom model…"}
            </option>
          </select>
          {modelChoice === "__custom__" && (
            <input
              placeholder="Provider model slug"
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
            />
          )}
          {provider === "codex" && (
            <select
              aria-label="Codex reasoning effort"
              value={effectiveReasoningEffort}
              onChange={(e) => setReasoningEffort(e.target.value as ReasoningEffort)}
            >
              {availableReasoningLevels.map((level) => (
                <option key={level.effort} value={level.effort}>
                  {level.effort === "xhigh"
                    ? "Extra High"
                    : level.effort[0].toUpperCase() + level.effort.slice(1)}
                  {level.effort === "high" ? " (default)" : ""}
                  {level.description ? ` — ${level.description}` : ""}
                </option>
              ))}
            </select>
          )}
          <select
            value={priority}
            onChange={(e) => setPriority(Number(e.target.value))}
          >
            {[0, 1, 2, 3, 4].map((p) => (
              <option key={p} value={p}>
                Priority {p}
              </option>
            ))}
          </select>
        </div>
        <input
          placeholder="Verify command (optional, e.g. make test)"
          value={verify}
          onChange={(e) => setVerify(e.target.value)}
        />
        <div className="actions">
          <button
            className="primary"
            disabled={
              !title ||
              workspacesLoading ||
              !!workspacesError ||
              (workspaceKind === "repo" && !repo) ||
              (workspaceKind === "portfolio" && !repoRoot)
            }
            onClick={() =>
              onCreate({
                title,
                prompt: prompt || title,
                workspace_kind: workspaceKind,
                ...(workspaceKind === "repo" ? { repo } : {}),
                ...(workspaceKind === "portfolio" ? { repo_root: repoRoot } : {}),
                worker_provider: provider || undefined,
                model: selectedModel || undefined,
                reasoning_effort:
                  provider === "codex" ? effectiveReasoningEffort : undefined,
                priority,
                verify_cmd: verify || undefined,
              })
            }
          >
            Create
          </button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
