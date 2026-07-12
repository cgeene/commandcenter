# commandcenter

**A local-first orchestration platform for Claude Code and Codex agents.**

![Node >= 22](https://img.shields.io/badge/node-%3E%3D22-informational)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)
![Local-first](https://img.shields.io/badge/local--first-no%20telemetry-success)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

commandcenter turns a queue of tasks into work done by autonomous Claude Code or
Codex workers. A long-running daemon owns a SQLite task queue and spawns each task into
its **own git worktree and tmux window**, so agents run in parallel without
stepping on each other. Finished work is proofed by an **independent adversarial
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

You file tasks (a title, a prompt, a target repo, optionally a `verify_cmd`).
The daemon claims a ready task, cuts a fresh branch and git worktree from the
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
| **Workers** | Claude Code or Codex sessions, one per task, each in `agent/task-N` worktree + branch. |
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

   Each task ── git worktree ($CC_DATA_DIR/worktrees) on branch agent/task-N
             └─ pushed to origin ─▶ GitHub PR ─▶ (PR sync) ─▶ task follows the PR
```

**Data flow, end to end:** the scheduler (or you) claims a `queued` task with an
atomic SQLite `UPDATE` → `spawn` creates the worktree + tmux window + generated
`--settings`/`--mcp-config` and launches `claude` → the worker does the work and
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

That is the complete installation for an all-Claude deployment. Codex is
optional. Only run the following if you want Codex workers:

```sh
# one-time Codex worker setup; follow the printed login + hook-trust steps
agp codex setup
agp codex doctor
```

> The MCP server is loaded from `dist/mcp/index.js`, so agents need a build.
> Re-run `npm run build:all` (or `agp upgrade`) after changing source.

### Choose the worker mode

Existing all-Claude installations remain fully supported and require no Codex
configuration. `claude` is still the default worker provider, the main
orchestrator is Claude Fable 5 by default, and independent reviewers are Claude.
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
Its configured default is Fable 5 (`fable`), which is suited to long-running
orchestration and delegation; `CC_MAIN_MODEL` or `agp main --model` can override
it. Fable is a Claude model, so it is intentionally absent from Codex worker
model choices. Anthropic currently requires 30-day data retention for Fable;
see [Anthropic's Fable documentation](https://www.anthropic.com/claude/fable).

Provider, model, and Codex reasoning effort are stored on each task. Model names
are provider-specific, so a Codex model slug or effort is never passed to Claude
and a Claude model name is never passed to Codex. A stopped worker resumes only
with the provider that owns its recorded session; changing provider starts a
fresh provider context while preserving the task branch and worktree. Command
Center rejects provider changes while that task still has a live agent.

Whichever worker provider is selected, the surrounding workflow is unchanged:
one task branch and worktree, lifecycle hooks, transcript auditing, verification,
commit and push boundaries, an independent Claude review, and a human-controlled
merge.

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
# 1. file a task
agp task add "Fix the flaky retry test" \
  --repo ~/projects/foo --provider codex -v "npm test" \
  -p "tests/retry.test.ts is flaky because of a real timer. Fix it properly."

agp task ls                       # queue overview

# 2. spawn a worker (omit --provider to use the task/provider default)
agp agent spawn --task 1
agp agent ls
agp agent peek 1                  # see its terminal without attaching
agp attach 1                      # interact; detach with Ctrl-b d

# 3. when it reaches review, proof it and follow the PR
agp review 1                      # spawn an adversarial reviewer
agp task diff 1                   # what actually changed on the branch
```

On the dashboard, the worker appears in the agent grid with a live terminal; when
it needs you (a permission prompt, a question) or finishes, it shows up in the
**Needs You** panel and (once its PR is open) on the **PRs** board. Merge the PR
in GitHub — PR sync marks the task `done`, reaps the agent, and cleans up the
worktree.

Prefer autonomy? Spawn the orchestrator and turn on the scheduler:

```sh
agp main                          # spawn the orchestrator agent
agp attach 2                      # "work through the queue"
agp scheduler on                  # claim & spawn ready tasks automatically
```

Full CLI reference: [`docs/cli.md`](docs/cli.md).

---

## Core concepts

### Tasks & the queue

A task carries a `title`, `prompt`, `repo`, `priority` (lower runs first;
default `2`), worker provider/model, Codex `reasoning_effort` (default `high`),
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

### Workers, reviewers & the adversarial review loop

A **worker** is an interactive Claude Code or Codex session for one task in a
dedicated worktree. Codex workers use `workspace-write` plus `on-request`
approval plus exec rules and a hook policy that auto-approves only their exact
task-branch push while denying other pushes and PR merges; Claude workers retain the existing
generated permission settings.
When a worker moves a
task to `review` with commits on its branch, an independent **reviewer** proofs
it. The reviewer is a *fresh* session in its own detached worktree at the task's
branch with **Edit/Write/commit/push denied** — it gets the same inputs as the
worker (prompt, branch, claimed summary) but **none of its conversation**, and is
prompted to find reasons to **reject**: unmet requirements, weakened tests,
summary/diff mismatches. It calls `submit_review(approve|reject, notes)`.

- **Reject** → notes go straight back into the worker's session (or into the
  respawn prompt if it's gone), task returns to `in_progress`.
- After **2 rejected cycles** (`MAX_REVIEW_CYCLES`) the task is **blocked** and
  escalated to you with both sides' notes.
- **Approve** → pings you; the merge is still yours.

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
you were paged), and `stale_waiting` (an agent parked in `waiting_input` past
`attention_stale_minutes`). A situation that re-triggers gets a new key, so it
resurfaces even if you dismissed the earlier instance.

### Crons & the scheduler

- **Scheduler** — off by default (`agp scheduler on|off`, or the dashboard kill
  switch). Every 30s it claims ready tasks up to `max_concurrent`, bounded by a
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
| `CC_PORT` | `4711` | Daemon port (localhost only) |
| `CC_URL` | `http://127.0.0.1:$CC_PORT` | Base URL agents/hooks use to reach the daemon |
| `CC_CLAUDE_BIN` | `claude` | Worker/reviewer/main binary (override for testing) |
| `CC_CODEX_BIN` | `codex` | Codex worker binary |
| `CC_CODEX_HOME` | `$CC_DATA_DIR/codex` | Isolated Codex profile, login, trust, and sessions |
| `CC_CODEX_PROFILE` | `commandcenter` | Generated Codex profile name |
| `CC_WORKER_PROVIDER` | `claude` | Default provider for new tasks/crons |
| `CC_TMUX_SESSION` | `cc` | tmux session name |
| `CC_MAIN_MODEL` | `fable` | Default Claude model for the main orchestrator (`agp main`) |
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
  `on-request` escalation plus a fail-closed push policy; no approval or hook-trust bypass is used. The read-only allowlist is
  an explicit, auditable list in [`src/daemon/permissions.ts`](src/daemon/permissions.ts).
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
