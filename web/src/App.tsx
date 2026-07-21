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
import { Terminal } from "./Terminal";
import type {
  Agent,
  AppSettings,
  AttentionItem,
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
  TranscriptEntry,
  WorkspaceCatalog,
  WorkspaceKind,
} from "./types";

/** Dashboard tabs — add an entry here + a render branch in App to grow the dashboard. */
const TABS = [
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
  working: "#3fb950",
  idle: "#8b949e",
  waiting_input: "#d29922",
  spawning: "#58a6ff",
  stalled: "#f85149",
  dead: "#484f58",
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
  const [showNewTask, setShowNewTask] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [showCrons, setShowCrons] = useState(false);
  const [scheduler, setScheduler] = useState<SchedulerInfo | null>(null);
  const [jiraMeta, setJiraMeta] = useState<JiraMeta>({
    base_url: "https://nylas.atlassian.net",
    enabled_repos: [],
  });
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTabState] = useState<TabId>(tabFromHash);
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
  // Nav badge: open PRs the reviewer has approved and are now waiting on a
  // human merge — the one state that most wants Caleb's attention.
  const prsAwaitingMerge = tasks.filter(
    (t) => isOpenPr(t) && t.review_verdict === "approve",
  ).length;
  const tabBadge: Partial<Record<TabId, number>> = {
    board: attention.length,
    prs: prsAwaitingMerge,
  };

  return (
    <div className="app">
      {stale && (
        <div className="error">
          Daemon is running stale code — run <code>agp upgrade</code>
        </div>
      )}
      <header>
        <h1>commandcenter</h1>
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? "active" : ""}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {(tabBadge[t.id] ?? 0) > 0 && (
                <span className="tab-badge">{tabBadge[t.id]}</span>
              )}
            </button>
          ))}
        </nav>
        <span className="muted">
          {tasks.filter((t) => t.status === "in_progress").length} running ·{" "}
          {tasks.filter((t) => ["queued", "claimed"].includes(t.status)).length}{" "}
          queued · {agents.length} live agents
        </span>
        <div className="spacer" />
        {scheduler && (
          <button
            className={scheduler.config.enabled ? "sched-on" : ""}
            title={`workers ${scheduler.status.live_workers}/${scheduler.config.max_concurrent} · spawns today ${scheduler.status.spawns_today}/${scheduler.config.daily_spawn_limit}`}
            onClick={() =>
              act(() =>
                api("PATCH", "/api/scheduler", {
                  enabled: !scheduler.config.enabled,
                }),
              )
            }
          >
            {scheduler.config.enabled
              ? `■ Auto ON (${scheduler.status.spawns_today}/${scheduler.config.daily_spawn_limit})`
              : "▶ Auto OFF"}
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
          + New Task
        </button>
      </header>

      {error && (
        <div className="error" onClick={() => setError(null)}>
          {error}
        </div>
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

      {tab === "board" && (
        <AgentList
          agents={agents}
          panes={panes}
          onOpenTerminal={openTerminal}
          onAction={act}
        />
      )}

      {tab === "tokens" && <TokensView tasks={tasks} onSelect={(t) => openTask(t.id)} />}

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

        <aside className="events">
          <h2>Activity</h2>
          {events.map((e) => (
            <div key={e.id} className="event">
              <span className="muted">{e.ts.slice(11, 19)}</span>{" "}
              {e.narrative ?? e.kind}
            </div>
          ))}
          {events.length === 0 && <span className="muted">No activity yet</span>}
        </aside>
      </main>
      )}

      {selTask && (
        <TaskPanel
          key={selTask.id}
          task={selTask}
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
}: {
  task: Task;
  byId: Map<number, Task>;
  meta: JiraMeta;
  onSelect: (t: Task) => void;
  reviewMax?: number;
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
        #{task.id} {task.title}
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
        {task.status === "review" && (
          <span className="chip" title="Automatic review⇄fix round (current/cap)">
            Review round {Math.min(task.review_cycles + 1, reviewMax)}/{reviewMax}
          </span>
        )}
        {task.model && <span className="chip">{task.model}</span>}
        {task.reasoning_effort && <span className="chip">{task.reasoning_effort}</span>}
        <span className="chip">{task.worker_provider}</span>
        {task.agent_id && <span className="chip agent-chip">a{task.agent_id}</span>}
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
    </div>
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
type ApplyWhen = "immediate" | "next-spawn" | "restart";

const APPLY_LABEL: Record<ApplyWhen, string> = {
  immediate: "Applies immediately",
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

  const save = async () => {
    setSaving(true);
    onError("");
    try {
      const body: Record<string, unknown> = {
        ntfy_url: url.trim() || null,
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
      <p className="muted">
        Push alerts via ntfy (escalations, pages). Overrides CC_NTFY_URL /
        CC_NTFY_TOKEN and applies on the next notification.
      </p>
      <SettingRow
        label="ntfy topic URL"
        when="immediate"
        hint={
          effective.ntfy_url
            ? `In use now: ${effective.ntfy_url}`
            : "No URL configured — push is disabled."
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
  const [repoSuggestions, setRepoSuggestions] = useState<string[]>([]);
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

  // Known repos, offered as JIRA per-repo add-suggestions. Best-effort — a
  // failure just means no autocomplete, never a broken settings page.
  useEffect(() => {
    api<WorkspaceCatalog>("GET", "/api/workspaces")
      .then((cat) => {
        const paths = cat.repositories.map((r) => r.path);
        const named = cat.repositories.map((r) => r.name);
        setRepoSuggestions(Array.from(new Set([...paths, ...named])));
      })
      .catch(() => setRepoSuggestions([]));
  }, []);

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
  merge_pr: "⇧",
  merge_and_apply: "⚡",
  decision: "⚖",
  escalation: "⛔",
  stale_waiting: "⏳",
  scheduler_stalled: "🚦",
  orchestration: "◈",
  jira_sync: "🎫",
};

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
 * The live-agent list. The MAIN orchestrator is pinned at the top as a
 * prominent entry — Caleb jumps into its terminal constantly — with its
 * open-terminal action emphasized and no kill button (killing the
 * orchestrator from the dashboard is a footgun). Worker and reviewer
 * sub-agents list below as compact rows that keep their kill buttons.
 */
function AgentList({
  agents,
  panes,
  onOpenTerminal,
  onAction,
}: {
  agents: Agent[];
  panes: Record<number, ParsedPane>;
  onOpenTerminal: (agentId: number) => void;
  onAction: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  // At most one respond pane open at a time — mirrors the single-panel model
  // used elsewhere and keeps every waiting row compact until asked to expand.
  const [respondId, setRespondId] = useState<number | null>(null);
  const main = agents.find((a) => a.kind === "main");
  const workers = agents.filter((a) => a.kind !== "main");
  const toggleRespond = (id: number) =>
    setRespondId((cur) => (cur === id ? null : id));

  return (
    <section className="agents">
      {main ? (
        <AgentEntry
          agent={main}
          prominent
          pane={panes[main.id]}
          expanded={respondId === main.id}
          onToggleRespond={() => toggleRespond(main.id)}
          onOpenTerminal={onOpenTerminal}
          onAction={onAction}
        />
      ) : (
        <div className="agent-entry main empty">
          <span className="muted">No main agent — spawn one above</span>
        </div>
      )}

      <div className="agents-workers">
        <div className="agents-section-label muted">
          Workers <span>{workers.length}</span>
        </div>
        {workers.map((a) => (
          <AgentEntry
            key={a.id}
            agent={a}
            pane={panes[a.id]}
            expanded={respondId === a.id}
            onToggleRespond={() => toggleRespond(a.id)}
            onOpenTerminal={onOpenTerminal}
            onAction={onAction}
          />
        ))}
        {workers.length === 0 && (
          <span className="muted">No worker agents</span>
        )}
      </div>
    </section>
  );
}

/**
 * One agent row. Stays a compact single line for every state; a waiting_input
 * agent is marked with a thin yellow left border + "waiting" badge, and its
 * inline respond pane (see AgentPane) is revealed on demand via "respond" so
 * it never expands the layout on its own. The main orchestrator (`prominent`)
 * gets an emphasized terminal button and no kill button.
 */
function AgentEntry({
  agent,
  prominent = false,
  pane,
  expanded,
  onToggleRespond,
  onOpenTerminal,
  onAction,
}: {
  agent: Agent;
  prominent?: boolean;
  pane: ParsedPane | undefined;
  expanded: boolean;
  onToggleRespond: () => void;
  onOpenTerminal: (agentId: number) => void;
  onAction: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const waiting = agent.state === "waiting_input";
  const label = prominent
    ? "Main agent"
    : `a${agent.id}${
        agent.task_id
          ? ` · #${agent.task_id}`
          : agent.kind === "reviewer"
            ? " · review"
            : ""
      }`;
  return (
    <div
      className={`agent-entry${prominent ? " main" : ""}${waiting ? " waiting" : ""}`}
    >
      <div className="agent-entry-row">
        <span
          className="dot"
          style={{ background: STATE_COLORS[agent.state] ?? "#8b949e" }}
        />
        <b>{label}</b>
        <span className="muted agent-state">
          {AGENT_STATE_LABEL[agent.state] ?? agent.state} · {agent.provider} ·{" "}
          {agent.model ?? "default"}
          {agent.reasoning_effort ? ` · ${agent.reasoning_effort}` : ""}
        </span>
        {waiting && <span className="waiting-badge">Waiting</span>}
        {waiting && (
          <button onClick={onToggleRespond}>
            {expanded ? "Hide" : "Respond"}
          </button>
        )}
        <button
          className={prominent ? "primary" : ""}
          onClick={() => onOpenTerminal(agent.id)}
        >
          Terminal
        </button>
        {!prominent && (
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
        )}
      </div>
      {waiting && expanded && (
        <AgentPane
          agentId={agent.id}
          pane={pane}
          onAction={onAction}
          onOpenTerminal={() => onOpenTerminal(agent.id)}
        />
      )}
    </div>
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
  onSelect,
}: {
  tasks: Task[];
  onSelect: (t: Task) => void;
}) {
  const tracked = tasks.filter((t) => (t.tokens_used ?? 0) > 0);
  const total = tracked.reduce((s, t) => s + (t.tokens_used ?? 0), 0);
  const today = new Date().toISOString().slice(0, 10);
  const todayTotal = tracked
    .filter((t) => t.updated_at.slice(0, 10) === today)
    .reduce((s, t) => s + (t.tokens_used ?? 0), 0);

  const byModel = new Map<string, number>();
  for (const t of tracked) {
    const key = t.model ?? "default";
    byModel.set(key, (byModel.get(key) ?? 0) + (t.tokens_used ?? 0));
  }
  const rows = [...tracked].sort(
    (a, b) => (b.tokens_used ?? 0) - (a.tokens_used ?? 0),
  );

  return (
    <main>
      <div className="tokens-view">
        <div className="stat-cards">
          <div className="stat-card">
            <b>{fmtTokens(total)}</b>
            <span className="muted">Total tokens</span>
          </div>
          <div className="stat-card">
            <b>{fmtTokens(todayTotal)}</b>
            <span className="muted">Tasks touched today</span>
          </div>
          <div className="stat-card">
            <b>{tracked.length}</b>
            <span className="muted">Tasks tracked</span>
          </div>
          {[...byModel.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([model, n]) => (
              <div className="stat-card" key={model}>
                <b>{fmtTokens(n)}</b>
                <span className="muted">{model}</span>
              </div>
            ))}
        </div>

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
  onClose,
  onAction,
  onTerminal,
  onTranscript,
}: {
  task: Task;
  onClose: () => void;
  onAction: (fn: () => Promise<unknown>) => Promise<void>;
  onTerminal: (agentId: number) => void;
  onTranscript: (sessionId: string, provider: "claude" | "codex") => Promise<void>;
}) {
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
        <div className="actions">
          {["queued", "claimed"].includes(task.status) &&
            task.dispatch_mode === "direct" &&
            task.workspace_kind !== "portfolio" && (
            <button
              className="primary"
              onClick={() =>
                onAction(() => api("POST", "/api/agents", { task_id: task.id }))
              }
            >
              ▶ Spawn Worker
            </button>
          )}
          {task.status === "queued" && task.dispatch_mode === "orchestrated" && (
            <button
              className="primary"
              onClick={() =>
                onAction(() => api("POST", `/api/tasks/${task.id}/delegate`, {}))
              }
            >
              Notify Claude Main
            </button>
          )}
          {task.agent_id && (
            <button onClick={() => onTerminal(task.agent_id!)}>Terminal</button>
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
          {task.status === "review" && (
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
          {["blocked", "review", "failed", "cancelled"].includes(task.status) && (
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
          {!["done", "cancelled"].includes(task.status) && (
            <button
              className="danger"
              onClick={() => {
                const retained = task.workspace_kind === "repo"
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
