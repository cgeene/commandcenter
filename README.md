# commandcenter

**A local-first orchestration platform for Claude Code and Codex agents.**

![Node >= 22](https://img.shields.io/badge/node-%3E%3D22-informational)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)
![Local-first](https://img.shields.io/badge/local--first-no%20telemetry-success)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

commandcenter turns a queue of tasks into work done by autonomous Claude Code or
Codex workers. A long-running daemon owns a SQLite task queue. Claude main studies
each interactive request first, then dispatches repository work into an isolated
**git worktree and tmux window** or investigations into a private non-Git scratch
workspace. Finished code is proofed by an **independent adversarial
reviewer** before you ever see it, pushed as a normal GitHub PR, and surfaced on
a **live web dashboard** with a "Needs You" panel that tells you the one thing
only a human can do next. Agents share a **platform memory** of hard-won lessons
and an **internal doc store** for research. The control plane runs on your
machine — there is no hosted Command Center service or Command Center telemetry.
Claude Code and Codex still send model requests and selected working context to
their respective configured services.

<!-- TODO(screenshot): dashboard board view — kanban + agent grid + live terminal -->

---

## Contents

- [What it is](#what-it-is)
- [Architecture](#architecture)
- [Quickstart](#quickstart)
- [Core concepts](#core-concepts)
- [Configuration](#configuration)
- [Security & trust](#security--trust)
- [Contributing](#contributing)
- [License](#license)

---

## What it is

You file tasks (a title, a prompt, a workspace, optionally a `verify_cmd`). New
dashboard, CLI, and MCP submissions go to the Claude main orchestrator before a
worker exists. Main checks the scope and dispatches one repository worker, one
non-Git investigation worker, or a set of isolated per-repository child tasks.
For repository work, the daemon cuts a fresh branch and git worktree from the
repo's origin default branch, opens a tmux window, and launches an interactive
provider session scoped to that worktree with an MCP toolset. The worker does
the work, commits, pushes its branch, and opens a
PR. A separate reviewer agent — a fresh session with **no** access to the
worker's conversation and with file-editing tools denied — tries to *reject* the
work; two rejections block the task for your arbitration. Approved work lands in
`review` and waits for **you** to merge. A scheduler can run this whole loop
autonomously within budgets you set, but nothing ever merges itself.

The primitives:

| Piece | What it is |
|---|---|
| **`agentd`** | The daemon. Owns the SQLite queue, a localhost REST API + WebSocket, the tmux/worktree lifecycle, the scheduler, PR sync, and serves the dashboard. |
| **`agp`** | CLI client for the daemon (`agp task add`, `agp agent spawn`, …). |
| **`cc-mcp`** | MCP server exposing the platform to agents (scoped per role). |
| **Workers** | Claude Code or Codex sessions, one per executable task, in either an `agent/task-N` worktree + branch or a private scratch directory. |
| **Reviewers** | Independent read-only `claude` sessions that adversarially proof a branch. |
| **Main agent** | An orchestrator `claude` session that triages the queue and manages workers. |
| **Dashboard** | React SPA served by the daemon: board, PRs, tokens, live terminals. |

---

## Architecture

```
                                  ┌──────────────────────────────┐
   you ──▶ agp CLI ──────────────▶│           agentd             │
   you ──▶ browser (dashboard) ──▶│  (launchd / npm run dev)     │
                                  │                              │
                                  │  • REST API + WebSocket      │
                                  │    127.0.0.1:4711            │
                                  │  • scheduler (30s)           │
                                  │  • watchdog (60s)            │
                                  │  • PR sync (2m, via gh)      │
                                  │  • serves web/dist           │
                                  └───────┬───────────┬──────────┘
                                          │           │
                        owns / reads      │           │  spawns / reaps
                                          ▼           ▼
                            ┌───────────────────┐   ┌──────────────────────────┐
                            │   SQLite state.db │   │  tmux session "cc"        │
                            │  tasks · agents   │   │  ┌─────────────────────┐  │
                            │  events · memories│   │  │ worker  → worktree A │  │
                            │  docs · crons     │   │  │ worker  → worktree B │  │
                            │  settings         │   │  │ reviewer→ worktree A'│  │
                            └───────────────────┘   │  │ main    → orchestr.  │  │
                                     ▲              │  └─────────────────────┘  │
                                     │              └────────────┬─────────────┘
                                     │ MCP tools                 │ hooks (curl → API)
                                     │ (get_my_task, update_my_  │ SessionStart / Stop /
                                     │  task, spawn_worker, …)   │ Notification
                                     └───────────────┬───────────┘
                                                     │
                                          ┌──────────┴──────────┐
                                          │  cc-mcp (stdio)     │
                                          │  scoped per role:   │
                                          │  worker / reviewer /│
                                          │  main               │
                                          └─────────────────────┘

   Repo task ── git worktree ($CC_DATA_DIR/worktrees) on branch agent/task-N
             └─ pushed to origin ─▶ GitHub PR ─▶ (PR sync) ─▶ task follows the PR
   Investigation task ── private non-Git directory ($CC_DATA_DIR/scratch)
```

**Data flow, end to end:** an interactive task is validated against the configured
workspace catalog and delivered to Claude main → main reads the full task and
either spawns it or decomposes an all-repositories parent into scoped children →
an atomic SQLite `UPDATE` claims each executable task → `spawn` creates the
worktree or validates the private scratch directory, opens a tmux window, writes
generated runtime config, and launches Claude Code or Codex → the worker does the work and
talks back through **MCP tools** (state changes) and **hooks** (lifecycle
events `curl`ed to the API) → on `Stop` the daemon runs `verify_cmd` in the
worktree → pass sends the task to `review`, where the reviewer proofs it → the
worker pushes its branch and opens a PR → **PR sync** polls GitHub and moves the
task as the PR is merged / closed / commented → the dashboard reflects all of
this live over WebSocket, and the **attention panel** surfaces whatever needs
you.

For a deeper walk-through see [`docs/architecture.md`](docs/architecture.md).

---

## Quickstart

### Prerequisites

- **Node.js ≥ 22** (`node --version`)
- **tmux** (`tmux -V`) — workers run inside a tmux session
- **git** with a configured `origin` remote on repos you point tasks at
- **[GitHub CLI](https://cli.github.com/) (`gh`)**, authenticated (`gh auth login`) — used for PR create/sync
- **[Claude Code](https://claude.com/claude-code)** installed and authenticated — the `claude` binary must be on your `PATH` (override with `CC_CLAUDE_BIN`)
- **[Codex CLI](https://developers.openai.com/codex/cli)** installed when using Codex workers — the `codex` binary must be on your `PATH` (override with `CC_CODEX_BIN`)

macOS is the primary target (launchd, tmux); Linux works via `npm run dev:daemon`.

### Install & build

```sh
git clone https://github.com/cgeene/commandcenter.git
cd commandcenter
npm install
npm run build:all   # backend → dist/, dashboard → web/dist/
npm link            # puts `agentd`, `agp`, `cc-mcp` on your PATH
```

Configure the parent folder(s) the new-task repository picker may expose. This
is a daemon setting, so put it in the shell/launchd environment that starts
`agentd`:

```sh
export CC_REPO_ROOTS="$HOME/Documents/git"
# multiple roots use the platform path delimiter (":" on macOS/Linux)
```

Discovery is read-only, bounded, does not follow symlinks, and returns only Git
roots beneath this allow-list. A submitted path is canonicalized and checked
again on the server; the browser is never trusted to enforce the boundary.

That is the complete installation for an all-Claude deployment. Codex is
optional. Only run the following if you want Codex workers:

```sh
# one-time Codex worker setup; follow the printed login + hook-trust steps
agp codex setup
agp codex doctor
```

By default, that dedicated Codex home contains only Command Center's `cc` MCP.
To give Codex workers the same MCP servers and plugin-provided MCPs as a trusted
normal Codex installation, opt in from the daemon environment:

```sh
export CC_CODEX_MCP_SOURCE_HOME="$HOME/.codex"
```

This does **not** switch workers to your normal `CODEX_HOME`. Before each Codex
worker starts, Command Center mirrors only explicit `mcp_servers` tables into
its mode-`0600` isolated base config. MCPs supplied by plugins are flattened
into ordinary MCP transport entries instead of enabling those plugins. Plugin
skills/apps, auth state, sessions, history, hooks, project trust, model defaults,
sandbox settings, and other personal state stay isolated; the Command Center
profile remains the higher-precedence safety layer.

MCP credentials must be supplied as environment variables named by the MCP
configuration. Flattened plugin MCPs prompt for write-capable tools. Command
Center rejects static HTTP authorization headers and inline secret/token fields,
forwards only declared variable names into the individual Codex pane, and
refuses to spawn a worker when a required variable is missing. Because
inherited MCPs may reach GitHub or internal systems, enable
this only for a Codex home and repositories you trust. Unset
`CC_CODEX_MCP_SOURCE_HOME` to retain the original `cc`-only behavior.

On the first Claude-main launch, the dashboard may show a one-time folder-trust
prompt. It applies only to the empty, mode-`0700`
`$CC_DATA_DIR/main-workspace`, not to your home directory. Likewise, the first
Codex task for a repository may ask you to trust that repository before
project-local config, hooks, or exec policies can load. Command Center surfaces
both prompts in the browser, but intentionally does not let one model approve a
provider trust boundary for another. After trust is established, routine worker
approval prompts are delegated to the Claude main agent first.

Codex investigation workspaces are the exception: Command Center creates each
one itself with mode `0700` and adds trust for that exact task directory to its
isolated Codex config before launch. It never trusts the scratch parent or a
general temporary directory. A Claude Code scratch worker may still require its
normal one-time folder-trust decision; no trust or permission bypass is used.

> The MCP server is loaded from `dist/mcp/index.js`, so agents need a build.
> Re-run `npm run build:all` (or `agp upgrade`) after changing source.

### Choose the worker mode

Existing all-Claude installations remain fully supported and require no Codex
configuration. `claude` is still the default worker provider, the main
orchestrator is Claude Opus by default, and independent reviewers are Claude.
Existing tasks, crons, database rows, and legacy Claude sessions continue to
behave as Claude work without migration-time user action.

Command Center now supports three operating patterns:

| Mode | Configuration | Runtime behavior |
|---|---|---|
| **All Claude (default)** | Do nothing, or set `CC_WORKER_PROVIDER=claude` | Claude main, Claude workers, Claude reviewers. This is the original behavior. |
| **Hybrid** | Set `CC_WORKER_PROVIDER=codex` after `agp codex setup` | Claude main dispatches Codex workers; Claude reviewers independently review their branches. |
| **Per-task choice** | Pass `--provider claude` or `--provider codex` to `agp task add` | The selected provider runs that worker, overriding the system default. |

In the dashboard, selecting Codex loads the visible model catalog from the
installed, authenticated Codex CLI and presents it as a dropdown. The provider
default remains the first choice, and `custom model…` accepts a newer, private,
or otherwise unlisted model slug. Hidden internal models are not shown.

Codex tasks also store an explicit reasoning effort. **High** is the default.
After a model is selected, the dashboard offers only the effort levels reported
for that model by the authenticated Codex catalog (for example, Sol and Terra
currently offer Ultra while Luna does not). Low, Medium, Extra High (`xhigh`),
Max, and Ultra remain opt-in. The selected effort survives scheduler dispatch,
crons, requeues, and same-provider session resumes. Ultra may delegate work to
internal Codex subagents, so use it deliberately.

The dashboard has a separate Claude model selector beside **spawn main agent**.
Its default is Opus (`opus`); `CC_MAIN_MODEL` or `agp main --model` can override
it. Fable 5 (`fable`), suited to long-running orchestration and delegation, is
an explicit opt-in (`CC_MAIN_MODEL=fable` / `agp main --model fable`); adopting
it as the orchestrator default is a separate, deliberate change (PR #31) that
carries its own data-retention consideration. The main model is a Claude model
either way, so it is intentionally absent from Codex worker model choices.

Provider, model, and Codex reasoning effort are stored on each task. Model names
are provider-specific, so a Codex model slug or effort is never passed to Claude
and a Claude model name is never passed to Codex. A stopped worker resumes only
with the provider that owns its recorded session; changing provider starts a
fresh provider context while preserving the task branch and worktree. Command
Center rejects provider changes while that task still has a live agent.

Whichever worker provider is selected, repository work keeps the surrounding
workflow: one task branch and worktree, lifecycle hooks, transcript auditing,
verification, commit and push boundaries, an independent Claude review, and a
human-controlled merge. Investigation tasks intentionally have no Git branch,
PR, or branch reviewer; Claude main validates their transcript, evidence, saved
docs, and optional verification command instead.

### Start the daemon

**macOS (launchd, recommended)** — runs at login and restarts on crash. Create a
`launchd` agent that runs `agentd`; a ready-to-edit plist template and install
steps are in [`docs/deployment.md`](docs/deployment.md).

**Any platform (foreground)**:

```sh
agentd                 # if you ran `npm link`
# or, from a clone without linking:
npm run dev:daemon     # tsx src/daemon/index.ts
```

You should see:

```
agentd listening on http://127.0.0.1:4711
data dir: /Users/you/.commandcenter (db: /Users/you/.commandcenter/state.db)
```

### Open the dashboard

Visit **http://127.0.0.1:4711**. Tabs: **board** (kanban + agent grid + live
terminal + new-task form), **PRs** (project-grouped PR board), **tokens** (usage).
To reach it from your phone, see the Tailscale notes in
[`docs/deployment.md`](docs/deployment.md) — never expose the daemon publicly; it
has no auth of its own.

### File your first task and watch it run

```sh
# 1. start Claude main once; it owns interactive task triage
agp main

# 2. file a main-orchestrated repository task
agp task add "Fix the flaky retry test" \
  --workspace repo --repo ~/Documents/git/foo --provider codex -v "npm test" \
  -p "tests/retry.test.ts is flaky because of a real timer. Fix it properly."

agp task ls                       # queue overview

# 3. Claude main studies the request and spawns the worker
agp agent ls
agp agent peek <worker-agent-id>  # see its terminal without attaching
agp attach <worker-agent-id>      # interact; detach with Ctrl-b d

# 4. when it reaches review, proof it and follow the PR
agp review 1                      # spawn an adversarial reviewer
agp task diff 1                   # what actually changed on the branch
```

`agp agent spawn --task N` remains available for legacy/direct tasks and manual
recovery, but it is not the normal path for a newly submitted interactive task.

On the dashboard, the worker appears in the agent grid with a live terminal; when
it needs you (a permission prompt, a question) or finishes, it shows up in the
**Needs You** panel and (once its PR is open) on the **PRs** board. Merge the PR
in GitHub — PR sync marks the task `done`, reaps the agent, and cleans up the
worktree.

Crons and legacy API clients keep their historical direct-scheduler behavior.
The scheduler never bypasses Claude main for a new explicit workspace task:

```sh
agp attach <main-agent-id>        # inspect/steer the orchestrator
agp scheduler on                  # direct legacy/cron tasks only
```

Full CLI reference: [`docs/cli.md`](docs/cli.md).

---

## Core concepts

### Tasks & the queue

A task carries a `title`, `prompt`, `workspace_kind`, canonical `repo`/root,
`dispatch_mode`, optional `parent_task_id`, `priority` (lower runs first; default
`2`), worker provider/model, Codex `reasoning_effort` (default `high`),
an optional `verify_cmd`, and an optional `blocked_by` (another task id — it
won't become ready until its blocker is `done`). `open_pr` (default on) controls
whether a worker opens a PR or leaves the branch as the deliverable.
Statuses:

```
queued → claimed → in_progress → blocked / review → done / failed
```

`cancelled` is reachable from **any** state (`agp task cancel <id>`): live worker
and reviewer are killed, the branch survives (`--rm-worktree` drops uncommitted
work), and an in-flight verify can't resurrect the task. Claiming is a single
atomic SQLite `UPDATE`, so two agents can never take the same task. `open_pr`,
`pr_url`, `review_verdict`, `review_notes`, `review_cycles`, and `tokens_used`
all live on the task record.

Interactive workspace modes:

| Workspace | Main-agent behavior | Worker boundary |
|---|---|---|
| **Repository** | Confirms the selected repository, then spawns one worker. | Dedicated branch and Git worktree. |
| **All repositories** | Inspects the catalog, creates affected-repository child tasks, preserves the selected provider/model/effort, then spawns the children. The parent itself is never spawned. | One independent task/worktree per affected repository; the broad root is never write-enabled. |
| **Investigation** | Spawns one evidence-gathering worker and reviews its transcript/result. | Server-created mode-`0700`, non-Git scratch directory retained for a bounded audit window. |

### Workers, reviewers & the adversarial review loop

A **worker** is an interactive Claude Code or Codex session for one task in a
dedicated worktree. Codex workers use `workspace-write` plus `on-request`
approval routed through Codex auto-review, plus exec rules and a hook policy
that auto-approves only their exact task-branch push while denying other pushes
and PR merges; Claude workers retain the existing generated permission settings.
When a worker moves a
task to `review` with commits on its branch, an independent **reviewer** proofs
it. The reviewer is a *fresh* session in its own detached worktree at the task's
branch with **Edit/Write/commit/push denied** — it gets the same inputs as the
worker (prompt, branch, claimed summary) but **none of its conversation**, and is
prompted to find reasons to **reject**: unmet requirements, weakened tests,
summary/diff mismatches. It calls `submit_review(approve|reject, notes)`.

- **Reject** → notes go straight back into the worker's session (or into the
  respawn prompt if it's gone), task returns to `in_progress`. If the PR had
  already been flipped to ready, it's converted back to a **draft**.
- After **2 rejected cycles** (`MAX_REVIEW_CYCLES`) the task is **blocked** and
  escalated to you with both sides' notes. The PR stays a **draft**.
- **Approve** → the PR is flipped from **draft** to **ready for review** and you
  get pinged; the merge is still yours.

Worker PRs are opened as **drafts** (`gh pr create --draft`) and only flip to
ready-for-review once internal review approves — so on GitHub, **"ready for
review" means "passed internal review — safe for you to merge"**, and a PR still
in draft has not yet been internally approved. (If a repo can't create drafts,
the fallback is a normal PR titled `[UNREVIEWED] …`, which the platform renames
on approval.) The PRs board and **Needs You** panel treat drafts distinctly: a
draft never appears as a merge action, only a ready+approved PR does.

The `Stop` hook re-verifies any task a worker moved to `review` itself, so
`verify_cmd` can't be bypassed. Auto-review is on by default
(`agp scheduler set --auto-review off` to disable).

### Worktree isolation & branch hygiene

Every task gets its own git worktree under `$CC_DATA_DIR/worktrees` on branch
`agent/task-N`, cut from the repo's **origin default branch** (fetched fresh),
not your local `HEAD` — so branches start clean by construction and your main
checkout is never touched. Workers may push **only** their own branch and open a
PR (the canonical `git push … agent/task-N` is pre-approved for both providers);
merges, force-pushes, and every other branch stay yours. Reviewers work in a throwaway
detached worktree that's reaped with the agent.

### Platform memory

A local lessons store (SQLite FTS5, no external services). Every agent gets
`remember(text, tags)` / `recall(query)` MCP tools; the daemon auto-injects the
top relevant memories into a worker's prompt at spawn, so a repo quirk or build
gotcha is learned once and applied by every future worker. Human access:
`agp memory ls|search|add|rm` and the dashboard's memory drawer.

### Internal doc store

A local markdown doc store (`$CC_DOCS_DIR`, default `$CC_DATA_DIR/docs`) with
`save_doc` / `get_doc` / `search_docs` / `list_docs` MCP tools. Research,
investigation, and analysis findings live here — plain `<project>/<slug>.md`
files you can grep directly, FTS5-indexed and versioned on update — instead of
polluting a code repo with non-code artifacts.

### Attention panel ("Needs You")

An ordered, self-healing action queue derived live from tasks/agents/events —
the only thing persisted is your dismissals. Item kinds: `merge_pr` /
`merge_and_apply` (approved work awaiting your merge), `decision` (a task blocked
after the review loop gave up), `escalation` (a live worker still waiting after
you were paged), `stale_waiting` (an agent parked in `waiting_input` past
`attention_stale_minutes`), and `orchestration` (an explicit task is queued while
Claude main is unavailable). A situation that re-triggers gets a new key, so it
resurfaces even if you dismissed the earlier instance.

### Crons & the scheduler

- **Scheduler** — off by default (`agp scheduler on|off`, or the dashboard kill
  switch). Every 30s it claims ready direct/cron tasks up to `max_concurrent`,
  bounded by a
  `daily_spawn_limit` and an optional `active_hours` window. A watchdog runs
  every 60s: a worker whose tmux window vanished is reaped (task requeued once,
  failed on the second vanish); a worker silent past `stall_minutes` is flagged
  and pushed to your phone. Autonomous work still lands in `review`.
- **Crons** — recurring task templates (`agp cron add|ls|enable|disable|run`)
  that file a fresh task on a schedule.
- **Dreaming run** — an optional nightly reflection agent (`agp dream setup`,
  then `agp cron enable dreaming`). It reads the day's activity, stores durable
  lessons into memory, files improvement tasks for recurring friction, and leaves
  a morning report — all with the narrow worker toolset (no code changes, no
  spawning, no merging), everything human-reviewed.

### Permission profiles

Each agent gets a **generated** `--settings` file — commandcenter never touches
your `~/.claude/settings.json`. Workers layer their branch push/PR allowances on
top of a baked-in **read-only profile** (safe read commands + read-only MCP
tools). Reviewers get the read-only profile with editing/commit/push explicitly
denied. New read-only tools can be allowlisted via `read_only_extra_allow` in
scheduler config without a code change (never put state-changing patterns there).

---

## Configuration

All config is either an environment variable read at call time or a value in the
`settings` table (via `agp scheduler set …`). See
[`docs/configuration.md`](docs/configuration.md) for the complete reference.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CC_DATA_DIR` | `~/.commandcenter` | DB, worktrees, prompts, generated settings/mcp files |
| `CC_DOCS_DIR` | `$CC_DATA_DIR/docs` | Internal doc store root |
| `CC_REPO_ROOTS` | unset | Path-delimited allow-list used by the repository picker and main-agent catalog |
| `CC_SCRATCH_DIR` | `$CC_DATA_DIR/scratch` | Command Center-owned investigation workspaces |
| `CC_SCRATCH_RETENTION_DAYS` | `7` | Retain terminal/orphaned scratch workspaces for 1–90 days before daily cleanup |
| `CC_PORT` | `4711` | Daemon port (localhost only) |
| `CC_URL` | `http://127.0.0.1:$CC_PORT` | Base URL agents/hooks use to reach the daemon |
| `CC_CLAUDE_BIN` | `claude` | Worker/reviewer/main binary (override for testing) |
| `CC_CODEX_BIN` | `codex` | Codex worker binary |
| `CC_CODEX_HOME` | `$CC_DATA_DIR/codex` | Isolated Codex profile, login, trust, and sessions |
| `CC_CODEX_PROFILE` | `commandcenter` | Generated Codex profile name |
| `CC_CODEX_MCP_SOURCE_HOME` | unset | Trusted normal Codex home whose MCP transports may be mirrored into the isolated worker home |
| `CC_WORKER_PROVIDER` | `claude` | Default provider for new tasks/crons |
| `CC_TMUX_SESSION` | `cc` | tmux session name |
| `CC_MAIN_MODEL` | `opus` | Default Claude model for the main orchestrator (`agp main`); Fable is an opt-in (`CC_MAIN_MODEL=fable`, see PR #31) |
| `CC_REVIEWER_MODEL` | unset | Claude reviewer override; otherwise preserve a Claude task model or use `opus` for a Codex-worker review |
| `CC_NTFY_URL` | unset | ntfy topic URL for push notifications (disabled if unset) |
| `CC_NTFY_TOKEN` | unset | ntfy auth token (self-hosted / protected topics) |
| `CC_CLAUDE_PROJECTS` | `~/.claude/projects` | Where Claude Code transcripts live (for token accounting & resume) |

### Scheduler config (`agp scheduler set …`)

| Key | Default | Purpose |
|---|---|---|
| `enabled` | `false` | Master switch (the dashboard kill switch flips this) |
| `max_concurrent` | `3` | Max live workers the scheduler maintains |
| `daily_spawn_limit` | `20` | Autonomous spawns allowed per UTC day |
| `stall_minutes` | `15` | Silence before a working agent is marked stalled |
| `active_hours` | `null` | Only auto-spawn in this hour window (e.g. `22-6` wraps overnight) |
| `auto_review` | `true` | Auto-spawn a reviewer when a task reaches `review` |
| `escalate_minutes` | `5` | Minutes in `waiting_input` (after the main agent was asked) before paging you |
| `attention_stale_minutes` | `10` | Minutes in `waiting_input` before the Needs-You panel flags it stale |
| `read_only_extra_allow` | `[]` | Extra **read-only** permission patterns appended to the baked-in profile |

---

## Security & trust

commandcenter is built to run agents you don't fully trust on code you care
about, on your own machine.

- **Everything is local.** The daemon binds to `127.0.0.1` only. State is a local
  SQLite file; the doc store and memory are local markdown/SQLite. There is **no
  telemetry**, no hosted control plane, and no outbound calls except the ones the
  tools you configure make (`gh` to your GitHub, `claude` to Anthropic, `codex`
  to OpenAI, and an optional ntfy push).
- **Workers are sandboxed to a worktree.** Each runs in its own `agent/task-N`
  worktree; your main checkout and every other branch are untouched. A worker
  that discovers its work belongs in a different repo is instructed to *report
  blocked*, not to edit it.
- **Least-privilege permissions.** Claude agents run against a **generated** settings
  file, never your `~/.claude/settings.json`. Workers may push only their own
  branch and open a PR; everything else falls to a normal permission prompt.
  Reviewers additionally deny Edit/Write/commit/push. Codex workers use an
  isolated profile with `workspace-write`, network disabled in the sandbox, and
  `on-request` escalation reviewed automatically by a separate Codex reviewer,
  plus a fail-closed push policy. Auto-review does not expand the sandbox, and no
  approval or hook-trust bypass is used. The read-only allowlist is
  an explicit, auditable list in [`src/daemon/permissions.ts`](src/daemon/permissions.ts).
- **Trust stays human; routine approval is orchestrated.** Provider
  repository/folder trust enables project-local hooks and policy, so it is
  surfaced in the browser for an explicit one-time human choice. Once the
  provider lifecycle hook is active, safe routine worker prompts go to the
  Claude main agent before Command Center pages you. The main agent itself runs
  in `$CC_DATA_DIR/main-workspace`, not your home directory.
- **Humans hold the merge.** Nothing merges itself — not the scheduler, not the
  main agent, not an approved reviewer. Merges, force-pushes, and secrets are
  yours.
- **Don't expose it.** The daemon has no auth. If you need remote access, front
  it with Tailscale (`tailscale serve`, tailnet-only) — never `tailscale funnel`
  or a public tunnel. See [`docs/deployment.md`](docs/deployment.md).

---

## Contributing

Contributions welcome. The platform dogfoods itself — tasks that modify
commandcenter are dispatched *through* commandcenter, run in an isolated
worktree, and go through the same adversarial review + PR flow as any other task.

### Dev setup

```sh
npm install
npm run dev:daemon      # daemon with tsx (no build step)
npm run build:all       # backend + dashboard when you need dist/
```

### Checks (run before opening a PR)

```sh
npm run typecheck       # tsc --noEmit (strict)
npm test                # vitest (unit + worktree integration)
```

The web bundle and daemon are two separate TypeScript builds; shared,
dependency-free logic lives under `src/lib/` so it can be both unit-tested in
Node and imported by the Vite bundle.

### PR conventions

- Branch from `main`; **never push directly to `main`**.
- Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, …).
- Open PRs with `gh pr create`; describe what changed, why, and how you verified.
- Keep functions small and match existing patterns in the file you're editing.

---

## License

[MIT](LICENSE) © 2026 Caleb Geene.
