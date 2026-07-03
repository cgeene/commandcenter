# commandcenter

Personal agent platform: an editable task queue + Claude Code workers, each in
its own git worktree and tmux window, managed by a local daemon.

## Architecture (Phase 1)

- **`agentd`** — daemon owning the SQLite queue (`~/.commandcenter/state.db`),
  a localhost REST API (`127.0.0.1:4711`), and the tmux/worktree lifecycle.
- **`agp`** — CLI client for the daemon.
- **Workers** — interactive `claude` sessions launched into tmux windows
  (session `cc`), one git worktree + branch (`agent/task-N`) per task,
  `--permission-mode acceptEdits`.
- **Hooks (Phase 2)** — each agent gets a generated settings file
  (`~/.commandcenter/settings/`) whose `SessionStart`/`Stop`/`Notification`
  hooks POST back to the daemon. `Stop` on an in-progress task runs the
  task's `verify_cmd` in the worktree: pass → `review`; fail → the failure
  output is sent back into the worker's session (max 2 nudges, then
  `blocked`). We never touch `~/.claude/settings.json`.
- **MCP server (Phase 2)** — `cc-mcp` (stdio) exposes the platform to agents
  via a generated `--mcp-config`. Workers get a scoped toolset
  (`get_my_task`, `update_my_task`, `report_blocked`, `add_task`); the main
  agent gets the full orchestration set (spawn/kill/peek/send workers,
  full queue CRUD, events).
- **Main agent (Phase 2)** — `agp main` spawns the orchestrator (default
  model `opus`, override with `-m` or `CC_MAIN_MODEL`): it triages the
  queue, picks models, spawns/monitors/reviews workers. One live main
  agent at a time.

- **Web dashboard (Phase 3)** — React SPA served by the daemon at
  `http://127.0.0.1:4711`: kanban board, agent grid, live terminal
  (xterm.js ↔ WebSocket ↔ PTY ↔ tmux), transcript viewer, new-task form.
  Each browser terminal gets its own *grouped* tmux session so viewers
  don't resize or steal focus from your desktop tmux client.
- **Push (Phase 3)** — set `CC_NTFY_URL` (e.g. `https://ntfy.sh/<topic>`,
  ideally self-hosted or token-protected via `CC_NTFY_TOKEN`) to get pushes
  when an agent needs input, a task hits review, or a task gets blocked.

- **Scheduler (Phase 4)** — off by default; toggle via `agp scheduler on|off`
  or the dashboard's auto button (green = on, click = kill switch). Every
  30s it claims ready tasks up to `max_concurrent` (default 3), bounded by a
  `daily_spawn_limit` budget (default 20 autonomous spawns/day) and an
  optional `active_hours` window (`agp scheduler set --hours 22-6` for
  overnight runs; a summary push is sent when the window closes). The
  watchdog runs every 60s regardless: a worker whose tmux window vanished is
  reaped (its task requeued once, failed on the second vanish), and a worker
  silent for `stall_minutes` (default 15) is flagged stalled + pushed to
  your phone. Autonomous work still lands in `review` — nothing merges
  itself.

## Setup

```sh
npm install
npm run build:all   # backend (dist/) + dashboard (web/dist/)
npm link            # puts `agentd`, `agp`, `cc-mcp` on PATH
```

## Remote access (Tailscale)

The daemon binds to 127.0.0.1 only. To reach the dashboard from your phone,
install Tailscale on the Mac + phone, then:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:4711
```

This gives `https://<mac-name>.<tailnet>.ts.net` with automatic TLS,
reachable only from your tailnet (WebSockets included). Do NOT use
`tailscale funnel` — that would expose the daemon to the public internet
with no auth.

## Usage

```sh
agentd                                  # or: npm run dev:daemon

agp task add "Fix the flaky retry test" \
  --repo ~/projects/foo -m sonnet -v "make test" \
  -p "tests/retry_test.go is flaky because ... fix it properly"

agp task ls                             # queue overview
agp agent spawn --task 1                # worktree + tmux window + claude
agp agent ls
agp agent peek 1                        # see its terminal without attaching
agp agent send 1 "also update the docs" # message a running worker
agp attach 1                            # interact; detach with C-b d
agp task update 1 -s done               # after reviewing the branch
agp agent kill 1 --rm-worktree
agp events

agp main                                # spawn the orchestrator agent
agp attach 2                            # talk to it: "work through the queue"
```

## Environment

| var | default | purpose |
|---|---|---|
| `CC_DATA_DIR` | `~/.commandcenter` | DB, worktrees, prompt/settings files |
| `CC_PORT` | `4711` | daemon port (localhost only) |
| `CC_CLAUDE_BIN` | `claude` | worker binary (override for testing) |
| `CC_TMUX_SESSION` | `cc` | tmux session name |
| `CC_MAIN_MODEL` | `opus` | default model for `agp main` |
| `CC_NTFY_URL` | unset | ntfy topic URL for push notifications |
| `CC_NTFY_TOKEN` | unset | ntfy auth token (self-hosted/protected topics) |
| `CC_CLAUDE_PROJECTS` | `~/.claude/projects` | transcript location |

## Statuses

Tasks: `queued → claimed → in_progress → blocked / review → done / failed`.
Agents: `spawning → working → idle / waiting_input / stalled → dead`.
Claiming is a single SQLite UPDATE — atomic; two agents can never take the
same task.
