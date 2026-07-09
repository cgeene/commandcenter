# Architecture

commandcenter is one long-running daemon plus a set of short-lived Claude Code
sessions it spawns into tmux. State lives in a single SQLite file; agents talk
back through MCP tools (for state changes) and hooks (for lifecycle events). This
document walks the pieces and the lifecycle of a task.

## Processes

| Process | Entry | Role |
|---|---|---|
| **`agentd`** (daemon) | `src/daemon/index.ts` → `dist/daemon/index.js` | Owns the queue, REST API + WebSocket on `127.0.0.1:$CC_PORT`, tmux/worktree lifecycle, scheduler, watchdog, PR sync, and serves the dashboard. |
| **`agp`** (CLI) | `src/cli/index.ts` | Thin REST client for the daemon. |
| **`cc-mcp`** (MCP server) | `src/mcp/index.ts` | stdio MCP server launched per agent via a generated `--mcp-config`; its toolset is scoped by `CC_ROLE`. |
| **Agents** | `claude` sessions in tmux windows | Workers, reviewers, and the main orchestrator. |

## Storage

Everything is under `$CC_DATA_DIR` (default `~/.commandcenter`):

- **`state.db`** — SQLite (via `better-sqlite3`). Tables: `tasks`, `agents`,
  `events`, `memories` (+ FTS5), `docs` (+ FTS5), `crons`, `settings`,
  `attention_dismissed`.
- **`worktrees/`** — one git worktree per task.
- **`prompts/`, `settings/`, `mcp/`** — generated per-agent files.
- **`docs/`** (or `$CC_DOCS_DIR`) — the internal doc store, as plain markdown.

## How agents talk to the platform

**MCP tools (state changes).** Each agent gets a generated `--mcp-config`
pointing at `cc-mcp` with a `CC_ROLE` env var. The toolset is scoped by role
(see [`src/mcp/index.ts`](../src/mcp/index.ts)):

- **All roles:** `add_task`, `remember`, `recall`, `activity_summary`,
  `save_doc`, `get_doc`, `list_docs`, `search_docs`.
- **Worker:** `get_my_task`, `update_my_task`, `report_blocked`.
- **Reviewer:** `get_my_task`, `get_task_diff`, `submit_review`.
- **Main (orchestrator):** the full set — `list_tasks`, `get_task`,
  `update_task`, `claim_task`, `cancel_task`, `spawn_worker`, `spawn_reviewer`,
  `list_agents`, `peek_worker`, `send_to_worker`, `kill_worker`, `get_task_diff`,
  `read_worker_transcript`, `escalate`, `recent_events`, `forget`.

**Hooks (lifecycle events).** Each agent's generated `--settings` wires
`SessionStart`, `Stop`, and `Notification` hooks to a `curl` that POSTs the
hook's JSON to `/api/hooks/agent/<id>`. The hook always exits 0, so a daemon
outage can never block an agent's own work. Hooks are the daemon's signal that an
agent started, went idle, needs input, or stopped.

## Lifecycle of a task

```
  add
   |
   v
 queued --(claim)--> claimed --(spawn)--> in_progress
                                               |
                                    worker commits, Stop hook fires
                                               |
                                         verify_cmd runs
                              fail (<=2 nudges) |         pass
                       (output fed back into    |          |
                        the worker session) <----+          v
                                                         review
                                                            |
                                                 reviewer proofs branch
                              reject (<=2 cycles)  |               approve
                       (back to in_progress/queued) <---+            |
                                                            worker opens PR
                                                                 |
                                                          PR sync polls gh
                            merged            closed             new comments
                              |                 |                     |
                              v                 v                     v
                            done            blocked             in_progress

  done  ->  agent reaped, worktree removed, local branch pruned
  (cancelled is reachable from ANY state via `agp task cancel`)
```

1. **Claim** — the scheduler (or `agp task claim`) claims a `queued` task whose
   `blocked_by` is satisfied, with a single atomic SQLite `UPDATE` — two agents
   can never take the same task.
2. **Spawn** — `src/daemon/spawn.ts` cuts branch `agent/task-N` and a worktree
   from the repo's **origin default branch** (fetched fresh, not local `HEAD`),
   writes the generated settings + mcp config, opens a tmux window, and launches
   `claude --permission-mode acceptEdits`. The top relevant memories are injected
   into the prompt. If a previous transcript exists, it resumes with `--resume`
   (override with `--fresh`).
3. **Work** — the worker uses its MCP tools and does the work in the worktree.
4. **Verify** — on the `Stop` hook the daemon runs the task's `verify_cmd` in the
   worktree. Pass → `review`. Fail → the failure output is fed back into the
   session (up to 2 nudges, then `blocked`). The `Stop` hook re-verifies even a
   task the worker moved to `review` itself, so `verify_cmd` can't be bypassed.
5. **Review** — an independent reviewer proofs the branch (details below).
6. **PR** — the worker pushes its own branch and opens a PR, recording it via
   `update_my_task(pr_url)`.
7. **PR sync** — every ~2 minutes the daemon polls GitHub via `gh` for tasks in
   `review` with a `pr_url`. Merged → `done` (agents reaped, worktree removed,
   local branch pruned). Closed without merge → `blocked`. New comments or a
   CHANGES_REQUESTED verdict → piped into the live worker (or baked into a
   respawn prompt), task back to `in_progress`.

## The adversarial review loop

When a task reaches `review` with commits, an independent reviewer is spawned
(auto, if `auto_review` is on; or `agp review <id>` / the main agent's
`spawn_reviewer`). It is a **fresh** `claude` session in its own detached
worktree at the task's branch, with `Edit`, `Write`, `NotebookEdit`,
`git commit`, and `git push` **denied**. It gets the same *inputs* as the worker
(task prompt, branch, claimed summary) but **none of its conversation** —
independence is the point — and is prompted to find reasons to **reject**. It
calls `submit_review(approve|reject, notes)`:

- **reject** → notes go back into the worker's session (or a respawn prompt);
  task returns to `in_progress`.
- after **2** rejected cycles (`MAX_REVIEW_CYCLES`) → `blocked`, escalated to the
  human with both sides' notes.
- **approve** → pings the human; the merge stays human.

The main agent also gets `get_task_diff` and `read_worker_transcript`, so it can
proof workers with evidence rather than terminal peeks.

## The web dashboard

A React SPA (`web/`) built by Vite and served by the daemon at
`http://127.0.0.1:$CC_PORT`. It is hash-routed with three tabs — **board**
(kanban + agent grid + live terminal + new-task form), **PRs** (project-grouped
PR board), and **tokens** (per-model / per-task usage). Live terminals are
xterm.js over a WebSocket to a PTY attached to the agent's tmux window; each
browser terminal gets its own *grouped* tmux session so a viewer never resizes or
steals focus from your desktop tmux client. The **Needs You** panel is derived
live from tasks/agents/events on every request.

## Operational details

- **Token accounting** — on each worker `Stop` the daemon sums the session
  transcript's per-turn usage (input + output + cache; approximate) into
  `tasks.tokens_used`.
- **Session resume** — respawning a task with an existing transcript uses
  `claude --resume`, so requeued / rejected work keeps its context; outstanding
  review/PR feedback rides along in the resume message.
- **Stale-daemon detection** — the daemon snapshots `dist/`'s newest mtime at
  boot; if a rebuild lands while it runs, it warns (dashboard banner +
  `GET /api/version` `stale: true`). `agp upgrade` rebuilds and respawns it.
- **Watchdog** — every 60s: a worker whose tmux window vanished is reaped (task
  requeued once, failed on the second vanish); a worker silent past
  `stall_minutes` is flagged and pushed.
- **Push notifications** — set `CC_NTFY_URL` (and optionally `CC_NTFY_TOKEN`) to
  get pushes when an agent needs input, a task hits review, or a task is blocked.
