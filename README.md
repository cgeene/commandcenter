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

- **Adversarial review (Phase 5)** — an independent reviewer agent proofs
  work before the human sees it. Every task that reaches `review` with
  commits on its branch is auto-reviewed (toggle `agp scheduler set
  --auto-review on|off`; report-only tasks like the dreamer are skipped);
  `agp review <id>` and the main agent's `spawn_reviewer` trigger one
  manually. The reviewer is a fresh Claude session in its own detached
  worktree at the task's branch, with file-editing tools denied. It gets the same *inputs* as the
  worker (task prompt, branch, claimed summary) but none of its conversation
  — independence is the point — and is prompted to find reasons to REJECT:
  unmet requirements, weakened tests, summary/diff mismatches. It submits
  `submit_review(approve|reject, notes)`. Rejection notes go straight back
  into the worker's session (or into the respawn prompt if it's gone) and the
  task returns to `in_progress`; after 2 rejected cycles the task is blocked
  and escalated to you with both sides' notes. Approval pings you — the merge
  is still yours. Auto-reviews draw from the scheduler's daily spawn budget.
  The main agent also gets `get_task_diff` and `read_worker_transcript` to
  proof workers with evidence instead of terminal peeks, and the `Stop` hook
  now re-verifies tasks a worker moved to `review` itself, so `verify_cmd`
  can't be bypassed.

- **Worker PRs** — review happens in GitHub, not transcripts. Workers with
  commits push their own `agent/task-N` branch and open a PR (`git push` on
  their branch + `gh pr create` are pre-allowed in their generated settings,
  so no permission stall), record it via `update_my_task(pr_url)`, and the
  PR link rides along on review pushes, the task record, and the dashboard.
  Merging, force-pushes, and any other branch remain the human's.

- **Main-agent triage of stuck workers** — when a worker hits
  `waiting_input`, the daemon first hands it to a live main agent (a
  "[commandcenter] aN is waiting for input" message lands in its session):
  it peeks, answers questions or approves safe/expected permission prompts
  itself (e.g. a worker pushing its own branch), and pages you via its
  `escalate` tool only for what's genuinely yours — credentials, judgment
  calls, destructive actions. If nothing resolves the wait within
  `escalate_minutes` (default 5, `agp scheduler set --escalate <m>`), the
  watchdog pages you anyway — once per wait, not once per minute. No live
  main agent = you're paged immediately, as before.

- **PR lifecycle sync** — every 2 minutes the daemon polls GitHub (via `gh`)
  for tasks in `review` with a `pr_url`. Merged → task `done`, agents
  reaped, worktree removed, local branch pruned. Closed without merge →
  `blocked`. New PR comments or a CHANGES_REQUESTED verdict → piped into
  the live worker (or baked into the respawn prompt), task back to
  `in_progress`. Review entirely in GitHub; the board follows.

- **Stale-daemon detection + `agp upgrade`** — the daemon snapshots
  `dist/`'s newest mtime at boot; if a rebuild lands while it runs, the
  watchdog pushes a warning, the dashboard shows a banner, and
  `GET /api/version` reports `stale: true`. `agp upgrade` = build →
  respawn the `agentd` tmux window → health-check; `--main` also respawns
  the main agent so it picks up new MCP tools.

- **Token accounting** — on every worker `Stop` the daemon sums the
  session transcript's per-turn usage into `tasks.tokens_used` (input +
  output + cache; approximate, resets on a fresh —non-resumed— respawn).
  Shown on the dashboard task panel and in `agp task show`.

- **Session resume** — respawning a task whose previous session transcript
  still exists uses `claude --resume`, so requeued/vanished/rejected work
  continues with full context instead of starting over; outstanding
  review/PR feedback rides along in the resume message. Force a clean
  start with `agp agent spawn --task N --fresh`.

- **Web dashboard (Phase 3)** — React SPA served by the daemon at
  `http://127.0.0.1:4711`: kanban board, agent grid, live terminal
  (xterm.js ↔ WebSocket ↔ PTY ↔ tmux), transcript viewer, new-task form.
  Each browser terminal gets its own *grouped* tmux session so viewers
  don't resize or steal focus from your desktop tmux client.
- **Push (Phase 3)** — set `CC_NTFY_URL` (e.g. `https://ntfy.sh/<topic>`,
  ideally self-hosted or token-protected via `CC_NTFY_TOKEN`) to get pushes
  when an agent needs input, a task hits review, or a task gets blocked.

- **Memory** — a local lessons store (SQLite FTS5, no external services).
  All agents get `remember(text, tags)` / `recall(query)` MCP tools (main
  also gets `forget`); the daemon auto-injects the top 5 relevant memories
  into every worker's prompt at spawn, so repo quirks and build gotchas get
  learned once and applied forever. Human access: `agp memory
  ls|search|add|rm` and the dashboard's memory drawer.
- **Dreaming run** — a nightly reflection agent (created disabled by
  `agp dream setup`; enable with `agp cron enable dreaming`). It reads the
  day's activity via `activity_summary`, stores durable lessons into memory
  (max 5/night), files improvement tasks for recurring friction (max
  3/night, duplicate-checked against the open queue), and leaves a morning
  report in its task's result summary — which lands in `review`, so the
  report ping is your normal review push. Guardrails: it's an ordinary
  worker with the narrow worker toolset — no code changes, no spawning, no
  merging; everything it produces is human-reviewed.
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
agp task diff 1                         # what actually changed on the branch
agp review 1                            # adversarial reviewer for a task in review
agp task update 1 -s done               # after reviewing the branch
agp task cancel 3 --rm-worktree         # close a task from ANY state (kills its agents)
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
`cancelled` is reachable from ANY state via `agp task cancel <id>` (or the
main agent's `cancel_task`, or the dashboard's ✕): live worker + reviewer
are killed, the branch survives (`--rm-worktree` to drop uncommitted work),
and an in-flight verify result can't resurrect the task. Cancelled tasks can
be requeued. A task `blocked_by` a cancelled one never becomes ready — the
cancel reports these so you can re-point or cancel them.
A reviewer rejection sends `review → in_progress` (live worker) or
`review → queued` (worker gone, notes baked into the respawn prompt);
`review_verdict`/`review_notes`/`review_cycles` on the task record who said
what.
Agents: `spawning → working → idle / waiting_input / stalled → dead`
(kinds: `main`, `worker`, `reviewer`).
Claiming is a single SQLite UPDATE — atomic; two agents can never take the
same task.
