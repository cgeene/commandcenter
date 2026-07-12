import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { api } from "./api";
import { blockedByChain, groupByProject, isActive, isArchived, projectOf } from "../../src/lib/board";
import { openPanel, type Panel } from "../../src/lib/panel";
import { parseFrontmatter } from "../../src/lib/frontmatter";
import { Terminal } from "./Terminal";
import type {
  Agent,
  AttentionItem,
  CronJob,
  Doc,
  DocWithContent,
  Event,
  Memory,
  ParsedPane,
  SchedulerInfo,
  Task,
  TranscriptEntry,
} from "./types";

/** Dashboard tabs — add an entry here + a render branch in App to grow the dashboard. */
const TABS = [
  { id: "board", label: "board" },
  { id: "prs", label: "PRs" },
  { id: "docs", label: "docs" },
  { id: "tokens", label: "tokens" },
  { id: "archive", label: "archive" },
] as const;
type TabId = (typeof TABS)[number]["id"];

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
          daemon is running stale code — run <code>agp upgrade</code>
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
              ? `■ auto ON (${scheduler.status.spawns_today}/${scheduler.config.daily_spawn_limit})`
              : "▶ auto OFF"}
          </button>
        )}
        {!liveMain && (
          <button onClick={() => act(() => api("POST", "/api/main", {}))}>
            ▶ spawn main agent
          </button>
        )}
        <button onClick={() => setShowCrons(true)}>crons</button>
        <button onClick={() => setShowMemory(true)}>memory</button>
        <button className="primary" onClick={() => setShowNewTask(true)}>
          + new task
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
      <section className="agents">
        {agents.map((a) => (
          <div
            key={a.id}
            className={`agent-card ${a.state === "waiting_input" ? "waiting" : ""}`}
          >
            <div className="agent-card-row">
              <span
                className="dot"
                style={{ background: STATE_COLORS[a.state] ?? "#8b949e" }}
              />
              <b>
                a{a.id} {a.kind === "main" ? "· main" : a.task_id ? `· #${a.task_id}` : ""}
              </b>
              <span className="muted">
                {a.state} · {a.provider} · {a.model ?? "default"}
              </span>
              <button onClick={() => openTerminal(a.id)}>terminal</button>
              <button
                className="danger"
                onClick={() =>
                  act(() => api("POST", `/api/agents/${a.id}/kill`, { requeue: a.kind === "worker" }))
                }
              >
                kill
              </button>
            </div>
            {a.state === "waiting_input" && (
              <AgentPane
                agentId={a.id}
                pane={panes[a.id]}
                onAction={act}
                onOpenTerminal={() => openTerminal(a.id)}
              />
            )}
          </div>
        ))}
        {agents.length === 0 && <span className="muted">no live agents</span>}
      </section>
      )}

      {tab === "tokens" && <TokensView tasks={tasks} onSelect={(t) => openTask(t.id)} />}

      {tab === "prs" && <PrsView tasks={tasks} onSelect={(t) => openTask(t.id)} />}

      {tab === "docs" && <DocsView />}

      {tab === "archive" && <ArchiveView tasks={tasks} onSelect={(t) => openTask(t.id)} />}

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
                    onSelect={(sel) => openTask(sel.id)}
                  />
                ))}
              </div>
            ));
          })()}
          {tasks.filter((t) => isActive(t.status)).length === 0 && (
            <span className="muted">
              {tasks.length === 0 ? "no tasks yet" : "no active tasks — see Archive"}
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
          {events.length === 0 && <span className="muted">no activity yet</span>}
        </aside>
      </main>
      )}

      {selTask && (
        <TaskPanel
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
            <b>terminal — a{panel.agentId}</b>
            <div className="spacer" />
            <button onClick={closePanel}>close</button>
          </div>
          <Terminal agentId={panel.agentId} />
        </div>
      )}

      {panel?.kind === "transcript" && transcript && (
        <div className="drawer">
          <div className="drawer-head">
            <b>transcript</b>
            <div className="spacer" />
            <button onClick={closePanel}>close</button>
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
function TaskCard({
  task,
  byId,
  onSelect,
}: {
  task: Task;
  byId: Map<number, Task>;
  onSelect: (t: Task) => void;
}) {
  const chain = blockedByChain(task, byId);
  const summary = firstLine(task.result_summary);
  return (
    <div className={`card ${task.status}`} onClick={() => onSelect(task)}>
      <div className="card-title">
        #{task.id} {task.title}
      </div>
      <div className="chips">
        <span className={`chip ${task.status}`}>{task.status}</span>
        {task.review_verdict === "approve" && (
          <span className="chip approved">✓ approved</span>
        )}
        {task.review_verdict === "reject" && (
          <span className="chip bad">✗ changes</span>
        )}
        {task.model && <span className="chip">{task.model}</span>}
        <span className="chip">{task.worker_provider}</span>
        {task.agent_id && <span className="chip agent-chip">a{task.agent_id}</span>}
      </div>
      {summary && <div className="card-summary">{summary}</div>}
      {chain && (
        <div className="card-blocked muted">
          ⇠ #{chain.id} ({chain.status})
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
 *  the whole board is built to surface. */
function VerdictBadge({ task }: { task: Task }) {
  if (task.review_verdict === "approve") {
    return <span className="pr-verdict approved">✓ reviewer approved — awaiting merge</span>;
  }
  if (task.review_verdict === "reject") {
    return <span className="pr-verdict bad">✗ changes requested</span>;
  }
  return <span className="pr-verdict muted">in review</span>;
}

function prNumber(url: string | null): string {
  return url?.match(/\/pull\/(\d+)/)?.[1] ?? "?";
}

function PrRow({ task, onSelect }: { task: Task; onSelect: (t: Task) => void }) {
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
      {broken && (
        <span className="chip bad" title="prsync has failed 3+ times in a row">
          ⚠ sync broken
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
  onSelect,
}: {
  tasks: Task[];
  onSelect: (t: Task) => void;
}) {
  const groups = groupByProject(tasks.filter(isOpenPr));
  return (
    <main>
      <div className="prs-view">
        {groups.length === 0 && (
          <span className="muted">no open PRs — everything's merged or in flight</span>
        )}
        {groups.map((g) => (
          <div key={g.project} className="pr-group">
            <h2>
              {g.project} <span className="muted">{g.total}</span>
            </h2>
            {g.tasks.map((t) => (
              <PrRow key={t.id} task={t} onSelect={onSelect} />
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
  onSelect,
}: {
  tasks: Task[];
  onSelect: (t: Task) => void;
}) {
  const [filter, setFilter] = useState("");
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const q = filter.trim().toLowerCase();
  const groups = groupByProject(tasks, {
    visible: (t) =>
      isArchived(t.status) &&
      (q === "" ||
        projectOf(t.repo).toLowerCase().includes(q) ||
        t.title.toLowerCase().includes(q)),
  });
  const archivedCount = tasks.filter((t) => isArchived(t.status)).length;

  return (
    <main>
      <div className="archive-view">
        <input
          className="archive-filter"
          placeholder="filter archive by project or title…"
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
                <TaskCard key={t.id} task={t} byId={byId} onSelect={onSelect} />
              ))}
            </div>
          ))}
          {groups.length === 0 && (
            <span className="muted">
              {archivedCount === 0
                ? "nothing archived yet"
                : "no archived tasks match your filter"}
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
 */
function Markdown({ content }: { content: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function basename(p: string): string {
  return p.split(/[/\\]/).pop() ?? p;
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
            <span className="muted">no docs yet</span>
          )}
        </aside>
        <section className="docs-body">
          {error && <div className="error">{error}</div>}
          {loading && <span className="muted">loading…</span>}
          {!loading && !selected && !error && (
            <span className="muted">select a doc to read it</span>
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
                  <b className="muted">attachments</b>
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
        <span className="muted">✓ nothing needs you</span>
      </section>
    );
  }
  return (
    <section className="attention">
      <h2>
        Needs you <span className="muted">{items.length}</span>
      </h2>
      {items.map((it) => (
        <div key={it.id} className={`attention-row sev-${it.severity}`}>
          <span className="att-icon" title={it.kind}>
            {KIND_ICON[it.kind]}
          </span>
          <div className="att-main">
            <div className="att-title">
              {it.title}
              {it.urgent && <span className="att-urgent">urgent</span>}
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
              open
            </a>
          ) : it.task_id != null ? (
            <button className="att-open" onClick={() => onOpenTask(it.task_id!)}>
              open
            </button>
          ) : (
            <span className="att-open" />
          )}
          <button className="att-dismiss" onClick={() => onDismiss(it.id)}>
            dismiss
          </button>
        </div>
      ))}
    </section>
  );
}

/**
 * Inline "what is this agent asking?" panel for a waiting_input card — the
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
            unsubmitted text in prompt: "{pane.unsubmitted_input}"
          </span>
          <div className="pane-banner-actions">
            <button
              className="primary"
              onClick={() =>
                onAction(() => api("POST", `/api/agents/${agentId}/submit-input`, {}))
              }
            >
              submit it
            </button>
            <button
              className="danger"
              onClick={() =>
                onAction(() => api("POST", `/api/agents/${agentId}/clear-input`, {}))
              }
            >
              clear it
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
              resolve the unsubmitted text above before replying
            </span>
          ) : (
            <div className="pane-reply">
              <input
                placeholder="reply…"
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitReply();
                }}
              />
              <button className="primary" disabled={!reply.trim()} onClick={submitReply}>
                send
              </button>
            </div>
          )}
        </div>
      )}

      <button className="pane-terminal-link" onClick={onOpenTerminal}>
        open terminal
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
            <span className="muted">total tokens</span>
          </div>
          <div className="stat-card">
            <b>{fmtTokens(todayTotal)}</b>
            <span className="muted">tasks touched today</span>
          </div>
          <div className="stat-card">
            <b>{tracked.length}</b>
            <span className="muted">tasks tracked</span>
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
                <th>task</th>
                <th>model</th>
                <th>status</th>
                <th className="num">tokens</th>
                <th className="num">share</th>
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
                    <span className={`chip ${t.status}`}>{t.status}</span>
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
            no token data yet — usage is recorded each time a worker finishes a turn
          </span>
        )}
        <p className="muted token-note">
          input + output + cache tokens summed from session transcripts.
          Approximate: a fresh (non-resumed) respawn resets a task's count.
        </p>
      </div>
    </main>
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
        <span className={`chip ${task.status}`}>{task.status}</span>
        <div className="spacer" />
        <button onClick={onClose}>close</button>
      </div>
      <div className="panel-body">
        <pre className="prompt">{task.prompt}</pre>
        <dl>
          <dt>repo</dt>
          <dd>{task.repo}</dd>
          <dt>worker</dt>
          <dd>
            {task.worker_provider}
            {task.model ? ` · ${task.model}` : " · default model"}
          </dd>
          {task.branch && (
            <>
              <dt>branch</dt>
              <dd>{task.branch}</dd>
            </>
          )}
          {task.worktree && (
            <>
              <dt>worktree</dt>
              <dd>{task.worktree}</dd>
            </>
          )}
          {task.verify_cmd && (
            <>
              <dt>verify</dt>
              <dd>{task.verify_cmd}</dd>
            </>
          )}
          {task.tokens_used != null && task.tokens_used > 0 && (
            <>
              <dt>tokens</dt>
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
          {task.result_summary && (
            <>
              <dt>result</dt>
              <dd>{task.result_summary}</dd>
            </>
          )}
        </dl>
        <div className="actions">
          {["queued", "claimed"].includes(task.status) && (
            <button
              className="primary"
              onClick={() =>
                onAction(() => api("POST", "/api/agents", { task_id: task.id }))
              }
            >
              ▶ spawn worker
            </button>
          )}
          {task.agent_id && (
            <button onClick={() => onTerminal(task.agent_id!)}>terminal</button>
          )}
          {task.session_id && (
            <button
              onClick={() =>
                onTranscript(task.session_id!, task.session_provider ?? "claude")
              }
            >
              transcript
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
              ✓ mark done
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
              ↺ requeue
            </button>
          )}
          {!["done", "cancelled"].includes(task.status) && (
            <button
              className="danger"
              onClick={() => {
                if (!confirm(`Cancel task #${task.id}? Live agents are killed; the branch survives.`)) return;
                void onAction(() => api("POST", `/api/tasks/${task.id}/cancel`, {}));
              }}
            >
              ✕ cancel task
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
        <b>crons</b>
        <div className="spacer" />
        <button onClick={onClose}>close</button>
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
                  {c.enabled ? "disable" : "enable"}
                </button>{" "}
                <button
                  onClick={async () => {
                    await api("POST", `/api/crons/${c.id}/run`);
                    load();
                  }}
                >
                  run now
                </button>{" "}
                <button
                  className="danger"
                  onClick={async () => {
                    await api("DELETE", `/api/crons/${c.id}`);
                    load();
                  }}
                >
                  delete
                </button>
              </span>
            </div>
            <div className="muted">
              {c.enabled ? `next ${c.next_run_at?.slice(0, 16) ?? "?"}` : "disabled"}
              {c.last_run_at ? ` · last ${c.last_run_at.slice(0, 16)}` : " · never run"}
              {` · ${c.worker_provider}`}
              {c.model ? ` · ${c.model}` : ""} · {c.repo.split("/").pop()}
            </div>
            <div>{c.title}</div>
          </div>
        ))}
        {crons.length === 0 && (
          <span className="muted">
            no crons — create one with: agp cron add &lt;name&gt; -s "0 3 * * *" -p "..."
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
        <b>memory</b>
        <div className="spacer" />
        <button onClick={onClose}>close</button>
      </div>
      <div className="panel-body">
        <input
          placeholder="search memories…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="memory-add">
          <textarea
            placeholder="store a new memory…"
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
            remember
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
                forget
              </button>
            </div>
            <div>{m.text}</div>
          </div>
        ))}
        {memories.length === 0 && <span className="muted">no memories</span>}
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
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState<"" | "claude" | "codex">("");
  const [verify, setVerify] = useState("");
  const [priority, setPriority] = useState(2);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New task</h2>
        <input
          placeholder="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
        />
        <textarea
          placeholder="prompt — what should the worker do?"
          rows={6}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <input
          placeholder="repo (absolute path)"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
        />
        <div className="row">
          <select
            value={provider}
            onChange={(e) =>
              setProvider(e.target.value as "" | "claude" | "codex")
            }
          >
            <option value="">provider (system default)</option>
            <option value="claude">Claude Code</option>
            <option value="codex">Codex</option>
          </select>
          <input
            list={provider === "codex" ? undefined : "claude-models"}
            placeholder="model (provider default)"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
          <datalist id="claude-models">
            <option value="haiku" />
            <option value="sonnet" />
            <option value="opus" />
          </datalist>
          <select
            value={priority}
            onChange={(e) => setPriority(Number(e.target.value))}
          >
            {[0, 1, 2, 3, 4].map((p) => (
              <option key={p} value={p}>
                priority {p}
              </option>
            ))}
          </select>
        </div>
        <input
          placeholder="verify command (optional, e.g. make test)"
          value={verify}
          onChange={(e) => setVerify(e.target.value)}
        />
        <div className="actions">
          <button
            className="primary"
            disabled={!title || !repo}
            onClick={() =>
              onCreate({
                title,
                prompt: prompt || title,
                repo,
                worker_provider: provider || undefined,
                model: model || undefined,
                priority,
                verify_cmd: verify || undefined,
              })
            }
          >
            create
          </button>
          <button onClick={onClose}>cancel</button>
        </div>
      </div>
    </div>
  );
}
