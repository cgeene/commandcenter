# Architecture

commandcenter is one long-running daemon plus Claude Code and Codex sessions it
spawns into tmux. State lives in a single SQLite file; agents talk
back through MCP tools (for state changes) and hooks (for lifecycle events). This
document walks the pieces and the lifecycle of a task.

## Processes

| Process | Entry | Role |
|---|---|---|
| **`agentd`** (daemon) | `src/daemon/index.ts` → `dist/daemon/index.js` | Owns the queue, REST API + WebSocket on `127.0.0.1:$CC_PORT`, tmux/worktree lifecycle, scheduler, watchdog, PR sync, and serves the dashboard. |
| **`agp`** (CLI) | `src/cli/index.ts` | Thin REST client for the daemon. |
| **`cc-mcp`** (MCP server) | `src/mcp/index.ts` | stdio MCP server launched per agent via a generated `--mcp-config`; its toolset is scoped by `CC_ROLE`. |
| **Agents** | `claude` or `codex` sessions in tmux windows | Workers and reviewers may use either provider; the main orchestrator remains Claude. |

## Storage

Everything is under `$CC_DATA_DIR` (default `~/.commandcenter`):

- **`state.db`** — SQLite (via `better-sqlite3`). Tables: `tasks`, `agents`,
  `events`, `memories` (+ FTS5), `docs` (+ FTS5), `crons`, `settings`,
  `attention_dismissed`.
- **`worktrees/`** — one git worktree per task.
- **`scratch/`** — mode-`0700`, non-Git investigation workspaces, one per task.
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
  `list_repositories`, `update_task`, `claim_task`, `cancel_task`, `spawn_worker`, `spawn_reviewer`,
  `list_agents`, `peek_worker`, `send_to_worker`, `kill_worker`, `get_task_diff`,
  `confirm_human_publication`, `read_worker_transcript`, `escalate`,
  `recent_events`, `forget`.

**Hooks (lifecycle events).** Claude's generated settings forward
`SessionStart`, `Stop`, and `Notification`. Codex's static bridge forwards
`SessionStart`, `Stop`, `PreToolUse`, and `PermissionRequest` from Command
Center's isolated profile. In the default publication mode, `PreToolUse` denies
publishing outside the exact task branch even after remembered approvals and
`PermissionRequest` auto-approves that one canonical push. Human-publication
workers and all reviewers instead deny commit/push/merge and PR mutations.
Worker identity comes from process environment, keeping the hook hash stable
for one-time trust. A daemon outage never blocks the agent, while the local
publishing policy remains enforced by the hook.
The local `cc` MCP server is role-scoped and explicitly approved so a worker
can record its result without a separate prompt for each platform tool call.

Provider trust prompts occur before lifecycle hooks are available. The
watchdog parses those startup screens and marks the agent `waiting_input` so
the human can answer in the dashboard; it never delegates repository/folder
trust to another model. The Claude main agent starts in the empty
`$CC_DATA_DIR/main-workspace` rather than the user's home directory. After its
`SessionStart` hook arrives, outstanding routine worker approvals are delegated
to it. A tmux window must be missing in two consecutive successful health
snapshots before an agent is reaped, and an unreliable tmux observation causes
no agent/task mutation.

Codex scratch tasks are pre-trusted only at the exact server-created task
directory. The scratch parent and general temporary directories are never
trusted. Repository trust remains a human decision.

## Lifecycle of a task

Explicit dashboard, CLI, and MCP submissions start with Claude-main triage:

```
  add explicit workspace -> queued -> Claude main studies task
                                      | repo       -> claim/spawn one worker
                                      | scratch    -> claim/spawn one non-Git worker
                                      ` portfolio  -> in_progress parent
                                                     `-> scoped repo children -> claim/spawn
```

The portfolio parent is never spawned, and its broad repository root is never a
write-capable worker cwd. Child repositories are canonicalized beneath that
parent root and inherit the selected provider/model/reasoning effort unless main
records a deliberate override. If main stops between child creation and spawn,
the queued child is redelivered on main's next start/idle event. Legacy API tasks
and crons retain the direct scheduler path below for compatibility.

Repository task lifecycle:

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
                            reject (until cap)     |               approve
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

That diagram is the default **Agent publishes** lifecycle. The opt-in **Human
publishes** branch changes only the publication portion:

```
 worker edits + verifies, leaves worktree uncommitted
                         |
             daemon pins full tree snapshot
                         |
       independent reviewer reads snapshot worktree
              | reject                 | approve
              v                        v
     worker fixes uncommitted     awaiting_human
     files; new snapshot               |
                                human reviews in
                                GitHub Desktop,
                                commits + publishes
                                       |
                          daemon verifies clean committed
                          and pushed tree == approved snapshot
                                       |
                               PR sync / completion
```

The mode is a local runtime default stored in SQLite and copied onto each new
task. `agent` is the fallback for old databases and existing behavior; changing
the setting never changes tasks already created.

1. **Triage** — an explicit workspace task is delivered to a live Claude main.
   If main is unavailable, it remains queued and the Needs You panel surfaces
   the ownership gap; it never falls through to direct scheduler dispatch.
2. **Claim** — Claude main, the scheduler for direct/cron work, or
   `agp task claim` claims a `queued` task whose
   `blocked_by` is satisfied, with a single atomic SQLite `UPDATE` — two agents
   can never take the same task.
3. **Spawn** — for repository work, `src/daemon/spawn.ts` cuts branch
   `agent/task-N` and a worktree from the repo's **origin default branch**
   (fetched fresh, not local `HEAD`). For scratch work it validates the
   server-created directory and creates no Git state. It then writes provider
   runtime config, opens a tmux window, and launches Claude or
   Codex. Codex uses `workspace-write`, `on-request` approval routed to an
   automatic Codex reviewer, and no sandbox network unless an escalation is
   approved. Codex reasoning effort is persisted
   per task, defaults to `high`, and is reapplied to fresh and resumed workers.
   A session resumes only through the provider that created it (override with
   `--fresh`).
4. **Work** — the worker uses its MCP tools inside its isolated worktree or
   scratch directory. Scratch prompts prohibit Git initialization, commits,
   pushes, and PRs and direct durable findings to the internal doc store. In
   Human publishes mode, repository workers may edit and verify but commit,
   push, merge, and PR mutations are denied.
5. **Verify** — on the `Stop` hook the daemon runs the task's `verify_cmd` in the
   task workspace. Pass → `review`. Fail → the failure output is fed back into the
   session (up to 2 nudges, then `blocked`). The `Stop` hook re-verifies even a
   task the worker moved to `review` itself, so `verify_cmd` can't be bypassed.
6. **Review** — an independent reviewer proofs a repository branch (details
   below). In Human publishes mode, the daemon builds a tree object from the
   complete non-ignored working tree using a temporary Git index, pins that
   object under an internal ref, and materializes it in the disposable reviewer
   worktree. The real branch, index, and working files are not changed. Scratch
   work has no branch reviewer; main checks its transcript, result summary,
   saved docs, and external read-only evidence.
7. **PR** — the repository worker pushes its own branch and opens a PR **as a
   draft** (`gh pr create --draft`), recording it via `update_my_task(pr_url)`.
   The draft is the GitHub-native signal that internal review has not yet
   approved: the platform flips it to ready-for-review only on approval (below),
   so on GitHub "ready for review" literally means "passed internal review —
   safe to merge". If a repo can't create drafts the worker falls back to a
   normal PR titled `[UNREVIEWED] …`; the platform strips that prefix when it
   approves.
8. **PR sync** — every ~2 minutes the daemon polls GitHub via `gh` for tasks in
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
  task returns to `in_progress`. If the PR had already been flipped to ready
  (a fix round on a previously-approved PR), it is sent back to draft
  (`gh pr ready --undo`) so its GitHub state keeps meaning "not yet approved".
- after the configured review-round cap (default **4**) → `blocked`, escalated
  to the human with both sides' notes. The PR stays a draft — the GitHub-visible
  "still not approved" signal.
- **approve** → the platform flips the draft PR to ready-for-review
  (`gh pr ready`, emitting `pr.marked_ready`) and pings the human; the merge
  stays human. A failed flip is surfaced loudly (event + push) so an approved PR
  is never silently stuck as a draft.

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

- **Token accounting** — for both providers, on each `Stop` the daemon reads the
  session transcript's usage (per-turn Claude totals or the latest cumulative
  Codex total; approximate) into `tasks.tokens_used`.
- **Session resume** — respawning a task uses provider-aware `claude --resume`
  or `codex resume`, so requeued / rejected work keeps its context; outstanding
  review/PR feedback rides along in the resume message.
- **Optional Codex MCP inheritance** — `CC_CODEX_MCP_SOURCE_HOME` mirrors only
  explicit `mcp_servers` into the isolated Codex base config. Plugin-provided
  MCPs are flattened into transport entries instead of enabling the plugin or
  its skills/apps. Effective server names, enabled states, transport types, and
  credential-variable names must match before a worker can spawn. Declared
  credential variables are passed pane-by-pane; normal auth, sessions, history,
  hooks, trust, model, and sandbox state are not inherited.
- **Stale-daemon detection** — the daemon snapshots `dist/`'s newest mtime at
  boot; if a rebuild lands while it runs, it warns (dashboard banner +
  `GET /api/version` `stale: true`). `agp upgrade` rebuilds and respawns it.
- **Watchdog** — every 60s: a worker whose tmux window vanished or whose retained
  pane process exited is reaped (task
  requeued once, failed on the second vanish); a worker silent past
  `stall_minutes` is flagged and pushed.
- **Push notifications** — set `CC_NTFY_URL` (and optionally `CC_NTFY_TOKEN`) to
  get pushes when an agent needs input, a task hits review, or a task is blocked.
