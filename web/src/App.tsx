import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { api } from "./api";
import { Terminal } from "./Terminal";
import type {
  Agent,
  CronJob,
  Event,
  Memory,
  SchedulerInfo,
  Task,
  TaskStatus,
  TranscriptEntry,
} from "./types";

const COLUMNS: { title: string; statuses: TaskStatus[] }[] = [
  { title: "Queued", statuses: ["queued", "claimed"] },
  { title: "In progress", statuses: ["in_progress"] },
  { title: "Blocked", statuses: ["blocked"] },
  { title: "Review", statuses: ["review"] },
  { title: "Done", statuses: ["done", "failed", "cancelled"] },
];

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
  const [events, setEvents] = useState<Event[]>([]);
  const [selTask, setSelTask] = useState<Task | null>(null);
  const [termAgent, setTermAgent] = useState<number | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[] | null>(null);
  const [showNewTask, setShowNewTask] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [showCrons, setShowCrons] = useState(false);
  const [scheduler, setScheduler] = useState<SchedulerInfo | null>(null);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyboardStyle = useKeyboardAwareStyle();

  const refresh = useCallback(async () => {
    try {
      const [t, a, e, s] = await Promise.all([
        api<Task[]>("GET", "/api/tasks"),
        api<Agent[]>("GET", "/api/agents?live=true"),
        api<Event[]>("GET", "/api/events?limit=25"),
        api<SchedulerInfo>("GET", "/api/scheduler"),
      ]);
      setTasks(t);
      setAgents(a);
      setEvents(e);
      setScheduler(s);
      setSelTask((cur) => (cur ? (t.find((x) => x.id === cur.id) ?? null) : null));
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

  const liveMain = agents.find((a) => a.kind === "main" && a.state !== "dead");
  const agentFor = (t: Task) => agents.find((a) => a.id === t.agent_id);

  return (
    <div className="app">
      {stale && (
        <div className="error">
          daemon is running stale code — run <code>agp upgrade</code>
        </div>
      )}
      <header>
        <h1>commandcenter</h1>
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

      <section className="agents">
        {agents.map((a) => (
          <div key={a.id} className="agent-card">
            <span
              className="dot"
              style={{ background: STATE_COLORS[a.state] ?? "#8b949e" }}
            />
            <b>
              a{a.id} {a.kind === "main" ? "· main" : a.task_id ? `· #${a.task_id}` : ""}
            </b>
            <span className="muted">
              {a.state} · {a.model ?? "?"}
            </span>
            <button onClick={() => setTermAgent(a.id)}>terminal</button>
            <button
              className="danger"
              onClick={() =>
                act(() => api("POST", `/api/agents/${a.id}/kill`, { requeue: a.kind === "worker" }))
              }
            >
              kill
            </button>
          </div>
        ))}
        {agents.length === 0 && <span className="muted">no live agents</span>}
      </section>

      <main>
        <div className="board">
          {COLUMNS.map((col) => {
            const colTasks = tasks.filter((t) => col.statuses.includes(t.status));
            return (
              <div key={col.title} className="column">
                <h2>
                  {col.title} <span className="muted">{colTasks.length}</span>
                </h2>
                {colTasks.map((t) => (
                  <div
                    key={t.id}
                    className={`card ${t.status}`}
                    onClick={() => setSelTask(t)}
                  >
                    <div className="card-title">
                      #{t.id} {t.title}
                    </div>
                    <div className="chips">
                      {t.model && <span className="chip">{t.model}</span>}
                      <span className="chip">p{t.priority}</span>
                      {t.agent_id && agentFor(t) && (
                        <span className="chip agent-chip">a{t.agent_id}</span>
                      )}
                      {t.status === "failed" && <span className="chip bad">failed</span>}
                      {t.status === "cancelled" && <span className="chip">cancelled</span>}
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>

        <aside className="events">
          <h2>Events</h2>
          {events.map((e) => (
            <div key={e.id} className="event">
              <span className="muted">{e.ts.slice(11, 19)}</span> {e.kind}
              {e.task_id ? ` #${e.task_id}` : ""}
              {e.agent_id ? ` a${e.agent_id}` : ""}
            </div>
          ))}
        </aside>
      </main>

      {selTask && (
        <TaskPanel
          task={selTask}
          onClose={() => setSelTask(null)}
          onAction={act}
          onTerminal={(agentId) => setTermAgent(agentId)}
          onTranscript={async (sid) => {
            const r = await api<{ entries: TranscriptEntry[] }>(
              "GET",
              `/api/transcript/${sid}`,
            );
            setTranscript(r.entries);
          }}
        />
      )}

      {termAgent !== null && (
        <div className="drawer terminal-drawer" style={keyboardStyle}>
          <div className="drawer-head">
            <b>terminal — a{termAgent}</b>
            <div className="spacer" />
            <button onClick={() => setTermAgent(null)}>close</button>
          </div>
          <Terminal agentId={termAgent} />
        </div>
      )}

      {transcript && (
        <div className="drawer">
          <div className="drawer-head">
            <b>transcript</b>
            <div className="spacer" />
            <button onClick={() => setTranscript(null)}>close</button>
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
  onTranscript: (sessionId: string) => Promise<void>;
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
              <dd>
                {task.tokens_used >= 1_000_000
                  ? `${(task.tokens_used / 1_000_000).toFixed(1)}M`
                  : `${Math.round(task.tokens_used / 1000)}k`}
              </dd>
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
            <button onClick={() => onTranscript(task.session_id!)}>
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
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">model (worker default)</option>
            <option value="haiku">haiku</option>
            <option value="sonnet">sonnet</option>
            <option value="opus">opus</option>
          </select>
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
