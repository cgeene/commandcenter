# commandcenter

**A local-first orchestration platform for Claude Code and Codex agents.**

![Node >= 22](https://img.shields.io/badge/node-%3E%3D22-informational)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)
![Local-first](https://img.shields.io/badge/local--first-no%20telemetry-success)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

commandcenter turns a queue of tasks into work done by autonomous Claude Code or
Codex workers. A long-running daemon owns a SQLite task queue. Claude main studies
each interactive request first, then dispatches repository work into an isolated
**git worktree + tmux window** or investigations into a private non-Git scratch
workspace. Finished code is proofed by an **independent adversarial reviewer**
before you ever see it, pushed as a **draft** GitHub PR that flips to
ready-for-review only once that review approves, and surfaced on a **live web
dashboard** with a "Needs You" panel that tells you the one thing only a human
can do next. Agents share a **platform memory** of hard-won lessons and an
**internal doc store** for research. The control plane runs on your machine —
there is no hosted service and no telemetry. Claude Code and Codex still send
model requests and selected working context to their respective services.

> **Adopting this for your team?** Jump to [Setup](#setup) (there's an
> [agent-executable checklist](#agent-executable-setup-checklist) for
> "set up commandcenter locally"), then read
> [Known limitations for adoption](#known-limitations-for-adoption) — the
> platform is single-user-per-machine today and this section is honest about
> what that means.

---

## Contents

- [What it is](#what-it-is)
- [Core concepts](#core-concepts)
- [Setup](#setup)
  - [Prerequisites](#prerequisites)
  - [Agent-executable setup checklist](#agent-executable-setup-checklist)
  - [Enabling Codex workers (optional)](#enabling-codex-workers-optional)
  - [Running the daemon for real (launchd)](#running-the-daemon-for-real-launchd)
- [Daily operation](#daily-operation)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Known limitations for adoption](#known-limitations-for-adoption)
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
the work, commits, pushes its branch, and opens a **draft** PR. A separate
reviewer agent — a fresh session with **no** access to the worker's conversation
and with file-editing tools denied — tries to *reject* the work; two rejections
block the task for your arbitration. Approved work flips its PR to ready and
lands in `review`, waiting for **you** to merge. A scheduler can run this whole
loop autonomously within budgets you set, but nothing ever merges itself.

The primitives:

| Piece | What it is |
|---|---|
| **`agentd`** | The daemon. Owns the SQLite queue, a localhost REST API + WebSocket, the tmux/worktree lifecycle, the scheduler, PR sync, and serves the dashboard. |
| **`agp`** | CLI client for the daemon (`agp task add`, `agp agent spawn`, …). |
| **`cc-mcp`** | MCP server exposing the platform to agents (scoped per role). |
| **Workers** | Claude Code or Codex sessions, one per executable task, in either an `agent/task-N` worktree + branch or a private scratch directory. |
| **Reviewers** | Independent read-only `claude`/`codex` sessions that adversarially proof a branch. |
| **Main agent** | An orchestrator `claude` session that triages the queue and manages workers. |
| **Dashboard** | React SPA served by the daemon: board, PRs, tokens, live terminals. |

---

## Core concepts

### Task lifecycle

```
 file task ─▶ queue ─▶ Claude main triages ─▶ claim (atomic SQLite UPDATE)
                                                        │
                                                        ▼
                              git worktree + tmux window on branch agent/task-N
                                        (cut from origin's default branch)
                                                        │
                              worker works ─▶ commits ─▶ pushes ─▶ opens DRAFT PR
                                                        │
                                    moves task to "review" ─▶ Stop hook runs verify_cmd
                                                        │
                            independent reviewer (no worker context; Edit/Write/push denied)
                                            tries to REJECT the work
                                       ┌────────────────┴────────────────┐
                                    reject                             approve
                            (2 cycles ⇒ task blocked,          DRAFT PR flips ready
                             both sides' notes to you)         + you get pinged
                            notes ─▶ worker reworks                    │
                                                              you merge in GitHub
                                                                       │
                                                    PR sync ─▶ task auto-completes:
                                                    done · worker reaped · worktree cleaned
```

For the full component diagram and data-flow walk-through, see
[`docs/architecture.md`](docs/architecture.md).

### Tasks & the queue

A task carries a `title`, `prompt`, `workspace_kind`, canonical `repo`/root,
`dispatch_mode`, optional `parent_task_id`, `priority` (lower runs first; default
`2`), worker provider/model, Codex `reasoning_effort` (default `high`), an
optional `verify_cmd`, and an optional `blocked_by` (another task id — it won't
become ready until its blocker is `done`). `open_pr` (default on) controls whether
a worker opens a PR or leaves the branch as the deliverable. Statuses:

```
queued → claimed → in_progress → blocked / review → done / failed
```

`cancelled` is reachable from **any** state (`agp task cancel <id>`). Claiming is
a single atomic SQLite `UPDATE`, so two agents can never take the same task.

Interactive workspace modes:

| Workspace | Main-agent behavior | Worker boundary |
|---|---|---|
| **Repository** | Confirms the selected repository, then spawns one worker. | Dedicated branch and git worktree. |
| **All repositories** | Inspects the catalog, creates affected-repository child tasks, then spawns the children. The parent is never spawned. | One independent task/worktree per repo; the broad root is never write-enabled. |
| **Investigation** | Spawns one evidence-gathering worker and reviews its transcript/result. | Server-created mode-`0700`, non-Git scratch directory retained for a bounded audit window. |

### Workers, reviewers & the adversarial review loop

A **worker** is an interactive Claude Code or Codex session for one task in a
dedicated worktree. When a worker moves a task to `review` with commits on its
branch, an independent **reviewer** proofs it: a *fresh* session in its own
detached worktree at the task's branch with **Edit/Write/commit/push denied** —
it gets the same inputs as the worker (prompt, branch, claimed summary) but
**none of its conversation**, and is prompted to find reasons to **reject**. It
calls `submit_review(approve|reject, notes)`.

- **Reject** → notes go back into the worker's session (or the respawn prompt if
  it's gone), task returns to `in_progress`. A ready PR is converted back to a
  **draft**.
- After **2 rejected cycles** (`MAX_REVIEW_CYCLES`) the task is **blocked** and
  escalated to you with both sides' notes.
- **Approve** → the PR flips from **draft** to **ready for review** and you get
  pinged; the merge is still yours.

Worker PRs are opened as **drafts** (`gh pr create --draft`), so on GitHub
**"ready for review" means "passed internal review — safe for you to merge"**.
(If a repo can't create drafts, the fallback is a normal PR titled
`[UNREVIEWED] …`, renamed on approval.) The `Stop` hook re-verifies any task a
worker moved to `review` itself, so `verify_cmd` can't be bypassed.

### Worktree isolation & branch hygiene

Every task gets its own git worktree under `$CC_DATA_DIR/worktrees` on branch
`agent/task-N`, cut from the repo's **origin default branch** (fetched fresh),
not your local `HEAD` — so branches start clean and your main checkout is never
touched. Workers may push **only** their own branch and open a PR; merges,
force-pushes, and every other branch stay yours.

### Platform memory & doc store

- **Memory** — a local lessons store (SQLite FTS5). Every agent gets
  `remember(text, tags)` / `recall(query)` MCP tools; the daemon auto-injects the
  top relevant memories into a worker's prompt at spawn, so a repo quirk is
  learned once and applied by every future worker. Human access:
  `agp memory ls|search|add|rm`.
- **Doc store** — a local markdown store (`$CC_DOCS_DIR`, default
  `$CC_DATA_DIR/docs`) with `save_doc` / `get_doc` / `search_docs` / `list_docs`
  MCP tools. Research and investigation findings live here as plain
  `<project>/<slug>.md` files (FTS5-indexed, versioned) instead of polluting a
  code repo.

### Workspace context injection

When a worker's worktree is created, the daemon imports the relevant
`CLAUDE.md` / `AGENTS.md` context so a worker inherits the same house rules you'd
get in that repo. It merges what's inferred from the repo's ancestor directories
with any explicit mapping you set in `CC_CONTEXT_ROOTS` (see
[Configuration](#configuration)). Claude workers get a live `@import`+symlink;
Codex workers get a materialized worktree-root `AGENTS.md` (git-excluded, never
clobbering a repo's own `AGENTS.md`).

### Attention panel ("Needs You")

An ordered, self-healing action queue derived live from tasks/agents/events.
Item kinds: `merge_pr` / `merge_and_apply` (approved work awaiting your merge),
`decision` (a task blocked after the review loop gave up), `escalation` (a live
worker still waiting after you were paged), `stale_waiting` (an agent parked in
`waiting_input`), and `orchestration` (an explicit task is queued while Claude
main is unavailable).

---

## Setup

### Prerequisites

Verify each with the command shown; all must succeed before continuing.

| Requirement | Check | Notes |
|---|---|---|
| **Node.js ≥ 22** | `node --version` | Runtime + build. |
| **tmux** | `tmux -V` | Workers run inside a tmux session. Install with `brew install tmux` (macOS) or `apt install tmux` (Debian/Ubuntu) if missing. |
| **git** | `git --version` | Repos you target need a configured `origin` remote. |
| **GitHub CLI** | `gh auth status` | Must be **authenticated** — used for PR create/sync. Run `gh auth login` if not. |
| **Claude Code** | `claude --version` | The `claude` binary must be on `PATH` (override with `CC_CLAUDE_BIN`). Must be logged in. |
| **Codex CLI** (optional) | `codex --version` | Only if you want Codex workers (see [below](#enabling-codex-workers-optional)). Override binary with `CC_CODEX_BIN`. |

Once the CLI is on your `PATH` (checklist step 4), **`agp doctor`** re-runs all of
the above in one shot — plus checks that `CC_REPO_ROOTS` points at real
directories with git repos and that the daemon is reachable. Required items show
`ok`/`FAIL`; optional ones (Codex, a not-yet-started daemon) show `warn`.

**Platform:** macOS is the primary target (launchd, tmux). Linux works via the
foreground daemon (`npm run dev:daemon` / `agentd`); there is no bundled Linux
service unit — wrap it in your own `systemd` unit if you want run-at-boot.

### Agent-executable setup checklist

> This section is a literal checklist for an AI agent (or a human) with shell
> access. Run each step in order; each has a **verify** whose stated outcome must
> hold before moving on. Commands are idempotent or safe to re-run.

**1. Clone and enter the repo.**

```sh
git clone https://github.com/cgeene/commandcenter.git
cd commandcenter
```

Verify: `git rev-parse --show-toplevel` prints the `commandcenter` checkout path.

**2 + 3. Install dependencies and build — one command.** `npm run setup`
installs the root deps **and** the `web/` deps (a *separate* npm package with its
own `package.json`; `web/node_modules` is git-ignored) and then builds both, so
you can't hit the classic gotcha of forgetting `npm install --prefix web` and
having the build fail.

```sh
npm run setup    # = npm install && npm install --prefix web && npm run build:all
```

Verify: `test -f dist/daemon/index.js && test -f web/dist/index.html && echo OK`
prints `OK`.

<details><summary>Prefer to run the steps individually?</summary>

```sh
npm install                 # root: daemon, CLI, MCP deps
npm install --prefix web    # dashboard deps — REQUIRED, easy to forget
npm run build:all           # backend → dist/, dashboard → web/dist/
```

</details>

**4. Put `agentd`, `agp`, and `cc-mcp` on your `PATH`.**

```sh
npm link
```

Verify: `command -v agentd agp cc-mcp` prints three paths. Now that the CLI is
linked, `agp doctor` gives you a one-shot recheck of every prerequisite (it will
flag `CC_REPO_ROOTS` as `FAIL` until you set it in the next step).

**5. Configure the repository-picker allow-list.** Point it at the parent
folder(s) holding the git repos you want to target — use wherever *your* repos
actually live (find candidates with `ls -d ~/**/.git 2>/dev/null` or e.g.
`~/projects`, `~/src`, `~/Documents/git`). This is a *daemon* setting, so it must
be in the environment that starts `agentd` (your shell profile now, the launchd
plist later). Discovery is read-only, bounded, ignores symlinks, and returns only
git roots beneath the allow-list.

```sh
export CC_REPO_ROOTS="$HOME/projects"   # ":"-separate multiple roots
```

Verify: `agp doctor` now reports `ok  CC_REPO_ROOTS: … (N git repos found)` with
`N > 0`. A valid root with no repos reports `warn` instead (the picker would be
empty), so make sure the count is non-zero. (The DB and data dir at
`~/.commandcenter` are created automatically on first daemon boot — no manual DB
setup.)

**6. Start the daemon in the foreground** (to try it out — see
[launchd](#running-the-daemon-for-real-launchd) for real use). Run this in a
dedicated terminal; it stays attached.

```sh
agentd                      # or: npm run dev:daemon  (tsx, no build needed)
```

Expected stdout (the scheduler/JIRA lines are informational — the scheduler is
off and JIRA sync is inert unless you configure them):

```
scheduler: disabled (toggle: agp scheduler on|off)
JIRA sync disabled: no CC_JIRA_TOKEN
agentd listening on http://127.0.0.1:4711
data dir: /Users/you/.commandcenter (db: /Users/you/.commandcenter/state.db)
dashboard: /Users/you/.../commandcenter/web/dist
```

If you forgot step 5, you'll also see a one-line `warning: CC_REPO_ROOTS is not
set …` here — the daemon still boots, but the repository picker will be empty.

**7. Verify the daemon is healthy** (from a second terminal):

```sh
curl -s http://127.0.0.1:4711/healthz      # → {"ok":true}
curl -s http://127.0.0.1:4711/api/version  # → {"started_at":…,"stale":false,…}
agp scheduler status                        # prints scheduler state (off by default)
```

Verify: the first curl returns exactly `{"ok":true}`.

**8. Open the dashboard.** Visit **http://127.0.0.1:4711**. You should see the
board (kanban + agent grid + live terminal + new-task form). Never expose this
port publicly — the daemon has no auth (see [Security](#security--trust)).

**9. Start the Claude main orchestrator once.** It owns interactive task triage.

```sh
agp main
```

Verify: `agp agent ls` lists a `main` agent.

Setup is complete. File your first task from the dashboard's new-task form, or:

```sh
agp task add "Fix the flaky retry test" \
  --workspace repo --repo ~/projects/foo -v "npm test" \
  -p "tests/retry.test.ts is flaky because of a real timer. Fix it properly."
agp task ls
```

Claude main studies it and spawns a worker; watch it in the dashboard's agent
grid, or `agp agent peek <id>`. When it reaches `review`, its PR opens as a draft
and the internal reviewer runs; on approval the PR flips to ready and appears in
**Needs You**. Merge it in GitHub — PR sync then marks the task `done` and cleans
up the worktree.

> **After changing source**, re-run `npm run build:all` (or `agp upgrade`) — the
> MCP server and daemon run from `dist/`, so agents need a build.

### Enabling Codex workers (optional)

All-Claude installs need nothing here; `claude` is the default worker provider.
To add Codex workers:

```sh
agp codex setup     # generates the isolated Codex profile + hooks; prints login + /hooks trust steps
agp codex doctor    # checks CLI, profile, isolated login, MCP/hook builds, and hook policy
```

commandcenter keeps a dedicated Codex home at `$CC_CODEX_HOME` (default
`$CC_DATA_DIR/codex`) and **never** touches your `~/.codex` auth, sessions, or
history. By default that home contains only commandcenter's `cc` MCP. To mirror
the explicit MCP servers from a trusted normal Codex home into the isolated
worker home (plugin MCPs are flattened to transport entries; no plugins, auth,
or trust are inherited), opt in from the daemon environment:

```sh
export CC_CODEX_MCP_SOURCE_HOME="$HOME/.codex"
```

Then choose how workers run:

| Mode | Configuration | Runtime behavior |
|---|---|---|
| **All Claude (default)** | nothing, or `CC_WORKER_PROVIDER=claude` | Claude main, Claude workers, Claude reviewers. |
| **Hybrid** | `CC_WORKER_PROVIDER=codex` | Claude main dispatches Codex workers; reviewers default to Claude. |
| **Per-task** | `--provider claude\|codex` on `agp task add` | Overrides the default for that worker. |

Codex tasks also carry a reasoning effort (default **high**); cross-model
adversarial review (a Codex diff judged by Claude and vice-versa) is opt-in via
`CC_REVIEWER_VARIETY`. See [Configuration](#configuration) and
[`docs/cli.md`](docs/cli.md).

> **Data egress:** a Codex worker's code/diffs/prompts go to OpenAI (as Claude
> workers' go to Anthropic). Decide which repos may be worked by Codex before
> enabling it on anything sensitive. Codex workers also run with the sandbox's
> network disabled, so tasks needing `npm install`/network fetches can stall on
> approval walls.

### Running the daemon for real (launchd)

For day-to-day use on macOS, run `agentd` under a launchd LaunchAgent so it
starts at login and restarts on crash. A ready-to-edit, path-parameterized plist
template and the load/unload steps are in
[`docs/deployment.md`](docs/deployment.md#launchd-macos-run-at-login) — it covers
the `PATH` gotcha (launchd starts with a minimal `PATH`, so you must spell out
where `node`, `claude`, `codex`, `gh`, `tmux`, and `git` live) and where to put
`CC_*` overrides.

To reach the dashboard from your phone, front the daemon with Tailscale
(`tailscale serve`, tailnet-only) — never `tailscale funnel` or a public tunnel.
See [`docs/deployment.md`](docs/deployment.md#remote-access-tailscale).

---

## Daily operation

### CLI at a glance

`agp` talks to the daemon over the localhost REST API, so the daemon must be
running. Full reference: [`docs/cli.md`](docs/cli.md).

| Command | What it does |
|---|---|
| `agp task add <title> …` | File a main-orchestrated task (`-w` workspace, `-r` repo, `-p` prompt, `-v` verify, `--provider`, `-m` model, `-P` priority, `-b` blocked-by). |
| `agp task ls` / `task show <id>` / `task diff <id>` | List / inspect a task / show its branch diff. |
| `agp task cancel <id>` | Close a task from any state; kills its live agents. |
| `agp main` | Spawn the Claude orchestrator (one at a time). |
| `agp agent ls` / `agent peek <id>` / `agent send <id> …` | List agents / view a terminal without attaching / send text into a session. |
| `agp attach <id>` | Attach to an agent's tmux window (detach with `Ctrl-b d`). |
| `agp review <id>` | Spawn an adversarial reviewer for a task in `review`. |
| `agp scheduler on\|off\|status\|set …` | Control autonomous spawning (see [Configuration](#scheduler-config)). |
| `agp cron add\|ls\|enable\|disable\|run\|rm` | Recurring task templates. |
| `agp memory ls\|search\|add\|rm` | Platform memory. |
| `agp upgrade` | Rebuild + restart the daemon in place; fixes the stale-daemon warning after a source change. |
| `agp codex setup\|doctor` | Codex worker setup / health check. |

`agp agent spawn --task N` remains for legacy/direct spawns and manual recovery,
but the normal path for a new interactive task is `agp task add` → Claude main.

### Dashboard tabs

- **board** — kanban queue + agent grid + live terminal + new-task form. The
  **Needs You** panel here surfaces the single next human action.
- **PRs** — project-grouped PR board; only ready+approved PRs offer a merge
  action, drafts don't.
- **tokens** — usage accounting per agent/task.

### Filing good tasks

A task prompt is the worker's entire brief — it starts fresh with no memory of
your intent. Good tasks state the *goal and the definition of done*, point at the
concrete files/symbols, and give a `verify_cmd` the worker (and the `Stop` hook)
can run to prove success. Prefer one repository per task; use **all
repositories** for a genuinely cross-repo change and let main decompose it. The
worker also inherits your repo's `CLAUDE.md`/`AGENTS.md` context automatically
(see [Workspace context injection](#workspace-context-injection)).

### PR sync & notifications

PR sync polls GitHub (via `gh`, ~every 2 min) and moves each task as its PR is
merged / closed / commented: a merged approved PR auto-completes the task, reaps
the worker, and removes the worktree; review comments can re-queue feedback to
the worker. Set `CC_NTFY_URL` to get pushes (escalations, approvals, stalls) to
your phone via [ntfy](https://ntfy.sh/).

---

## Configuration

Two kinds of configuration:

1. **Environment variables** — read at call time (from
   [`src/config.ts`](src/config.ts)); set them in the environment the daemon runs
   under (your shell, or the launchd plist's `EnvironmentVariables`).
2. **Scheduler config** — a JSON blob in the SQLite `settings` table, edited at
   **runtime** via `agp scheduler set …` / the API / the dashboard (**not** env
   vars); defaults in [`src/db/settings.ts`](src/db/settings.ts).

Full reference: [`docs/configuration.md`](docs/configuration.md).

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CC_DATA_DIR` | `~/.commandcenter` | Root for the DB, worktrees, prompts, generated settings/mcp files |
| `CC_DOCS_DIR` | `$CC_DATA_DIR/docs` | Internal doc store root |
| `CC_REPO_ROOTS` | unset | Path-delimited allow-list for the repository picker and main-agent catalog (`CC_REPO_ROOT` is a single-root alias) |
| `CC_SCRATCH_DIR` | `$CC_DATA_DIR/scratch` | Command Center-owned investigation workspaces |
| `CC_SCRATCH_RETENTION_DAYS` | `7` | Retain terminal/orphaned scratch workspaces for 1–90 days before daily cleanup |
| `CC_CONTEXT_ROOTS` | `{}` | JSON map of `dir-prefix → CLAUDE.md path(s)` injected into worktrees under that prefix (on top of inferred ancestor context). Malformed JSON is ignored. E.g. `{"/Users/me/projects/nylas":"/Users/me/notes/nylas.md"}` |
| `CC_PORT` | `4711` | Daemon port (localhost only) |
| `CC_URL` | `http://127.0.0.1:$CC_PORT` | Base URL agents/hooks use to reach the daemon |
| `CC_CLAUDE_BIN` | `claude` | Worker/reviewer/main binary (override for testing) |
| `CC_CODEX_BIN` | `codex` | Codex worker binary |
| `CC_CODEX_HOME` | `$CC_DATA_DIR/codex` | Isolated Codex profile, login, trust, and sessions |
| `CC_CODEX_PROFILE` | `commandcenter` | Generated Codex profile name |
| `CC_CODEX_MCP_SOURCE_HOME` | unset | Trusted normal Codex home whose MCP transports may be mirrored into the isolated worker home |
| `CC_WORKER_PROVIDER` | `claude` | Default provider for new tasks/crons |
| `CC_TMUX_SESSION` | `cc` | tmux session name |
| `CC_MAIN_MODEL` | `fable` | Default Claude model for the main orchestrator (`agp main`); override with `CC_MAIN_MODEL=opus` |
| `CC_REVIEWER_PROVIDER` | unset | Pin the reviewer provider (`claude`/`codex`); overrides the variety policy, invalid values fall back to `claude` |
| `CC_REVIEWER_VARIETY` | unset | When truthy, auto-review picks the *opposite* provider from the worker (cross-model review). Opt-in — asserts Codex is configured |
| `CC_REVIEWER_MODEL` | unset | Claude reviewer model override; else the Claude task model, or `opus` for a Codex-worker review. Never applied to a Codex reviewer |
| `CC_NTFY_URL` | unset | ntfy topic URL for push notifications (disabled if unset) |
| `CC_NTFY_TOKEN` | unset | ntfy auth token (self-hosted / protected topics) |
| `CC_CLAUDE_PROJECTS` | `~/.claude/projects` | Where Claude Code transcripts live (token accounting & resume) |

### Scheduler config

Runtime-configurable — **not** environment variables. Edit with
`agp scheduler set …` or the dashboard.

| Key | Default | Purpose |
|---|---|---|
| `enabled` | `false` | Master switch (the dashboard kill switch flips this) |
| `max_concurrent` | `3` | Max live workers the scheduler maintains |
| `daily_spawn_limit` | `20` | Autonomous spawns allowed per UTC day |
| `stall_minutes` | `15` | Silence before a working agent is marked stalled |
| `active_hours` | `null` | Only auto-spawn in this hour window (e.g. `22-6` wraps overnight) |
| `auto_review` | `true` | Auto-spawn a reviewer when a task reaches `review` |
| `escalate_minutes` | `5` | Minutes in `waiting_input` (after main was asked) before paging you |
| `attention_stale_minutes` | `10` | Minutes in `waiting_input` before **Needs You** flags it stale |
| `reap_after_minutes` | `10` | Minutes a worker on a terminal task may idle before the watchdog auto-reaps it |
| `read_only_extra_allow` | `[]` | Extra **read-only** permission patterns appended to the baked-in profile (never state-changing) |

---

## Troubleshooting

> First stop for any setup issue: run **`agp doctor`** — it checks every
> prerequisite, `CC_REPO_ROOTS`, and daemon reachability in one shot.

| Symptom | Cause & fix |
|---|---|
| Setup fails and you're not sure which prerequisite | Run `agp doctor`. Anything marked `FAIL` is a required item to install/configure; `warn` is optional (Codex, or a daemon you haven't started yet). |
| `tmux: command not found`, or workers never start | tmux isn't installed. `brew install tmux` (macOS) or `apt install tmux` (Debian/Ubuntu). (A harmless `error connecting to …/default` on the *first* boot just means no tmux server existed yet — the daemon starts one.) |
| Repository picker / new-task form shows no repos | `CC_REPO_ROOTS` is unset or points at the wrong place. The daemon logs a `warning: CC_REPO_ROOTS is not set …` line at boot when it's missing. Set it in the environment that starts `agentd` and confirm with `agp doctor`. |
| `agp` warns the daemon is **stale**, or agents lack new MCP tools | The daemon/MCP run from `dist/`. After any source change, run `agp upgrade` (rebuild + restart in place; `--main` also respawns main). `curl /api/version` shows `"stale":true` when `dist/` is older than the source. |
| `npm run build:all` fails in `web/` (`vite`/`tsc` not found, or missing React types) | You skipped `npm install --prefix web`. `web/` is a separate package; install it, then rebuild. |
| A worker fails immediately with `npm`/dependency errors in its worktree | Each worktree is a fresh checkout — its `node_modules` isn't shared. A worker that needs deps must run the repo's install step itself; make sure your `verify_cmd`/task prompt accounts for that. Codex workers additionally have the sandbox network disabled, so installs can stall on approval. |
| Live terminal shows `_` where glyphs (`⏺ ❯ ✻`) should be | A locale/unicode issue on the tmux attach path. commandcenter forces a UTF-8 locale and `tmux -u`; if you attach manually, use `tmux -u attach`. |
| Daemon under launchd can't find `claude`/`codex`/`gh`/`tmux` | launchd starts with a minimal `PATH`. Spell out the tool directories in the plist's `PATH` (`which node claude codex gh tmux git`). See [`docs/deployment.md`](docs/deployment.md). |
| PR won't open, or PR sync doesn't move a task | `gh` isn't authenticated or the repo lacks an `origin` remote. Check `gh auth status` and `git remote -v` in the target repo. |
| Dashboard unreachable | Confirm the daemon is up: `curl -s http://127.0.0.1:4711/healthz` → `{"ok":true}`. Check `CC_PORT` if you changed it. |

**Where logs & transcripts live:**

- Daemon (launchd): `$CC_DATA_DIR/agentd.out.log` and `agentd.err.log` (paths set
  in the plist). Foreground: stdout/stderr of the terminal running `agentd`.
- Claude Code transcripts: `$CC_CLAUDE_PROJECTS` (default `~/.claude/projects`).
- Codex sessions/logs: under `$CC_CODEX_HOME` (default `$CC_DATA_DIR/codex`).
- Platform events: `agp events` (recent) or the `events` table in
  `$CC_DATA_DIR/state.db`.
- Generated per-agent prompts/settings/mcp: `$CC_DATA_DIR/{prompts,settings,mcp}/`.

---

## Known limitations for adoption

commandcenter is production-quality **for a single engineer on a single
machine**. These are the honest constraints an org adopter should know; they are
tracked as future work (e.g. a settings tab and multi-user hardening), **not**
fixed here.

- **Single-user, no auth.** The daemon binds `127.0.0.1` and has no
  authentication or accounts. There is one implicit human — the person at the
  machine — who owns the attention panel, merges, and secrets. It is not a
  shared/multi-tenant service; run one per engineer.
- **Per-user home paths.** State defaults under the running OS user's home
  (`~/.commandcenter`, `~/.claude/projects`). Everything is overridable via
  `CC_*`, but the design assumes one OS user owns the daemon and its agents.
- **macOS-first.** launchd is the only bundled run-at-boot path; Linux runs the
  daemon in the foreground (bring your own `systemd` unit).
- **Notifications are single-channel.** Push goes to one `CC_NTFY_URL` topic —
  there's no per-user routing.
- **The clone URL is a personal repo** (`github.com/cgeene/commandcenter`).
  Adopters will typically fork/mirror it into their own org and point `origin`
  there; nothing in the platform depends on that specific remote.
- **A few defaults assume the author's setup.** For example `agp dream setup`
  defaults its repo to `commandcenter`; the `seed-cogs-docs` helper script
  hardcodes a `~/projects/nylas/...` path. These are optional extras, not on the
  core path — override or ignore them.

---

## Security & trust

commandcenter is built to run agents you don't fully trust on code you care
about, on your own machine.

- **Everything is local.** The daemon binds `127.0.0.1` only. State is local
  SQLite; the doc store and memory are local. There is **no telemetry** and no
  hosted control plane — the only outbound calls are the ones your configured
  tools make (`gh` → GitHub, `claude` → Anthropic, `codex` → OpenAI, optional
  ntfy push).
- **Workers are sandboxed to a worktree.** Each runs in its own `agent/task-N`
  worktree; your main checkout and other branches are untouched. A worker whose
  work belongs in a different repo is instructed to *report blocked*, not edit it.
- **Least-privilege permissions.** Agents run against a **generated** settings
  file — commandcenter never touches your `~/.claude/settings.json`. Workers may
  push only their own branch and open a PR; reviewers deny Edit/Write/commit/push.
  Codex workers use an isolated profile with `workspace-write`, network disabled
  in the sandbox, and a fail-closed push policy. The read-only allowlist is an
  explicit, auditable list in
  [`src/daemon/permissions.ts`](src/daemon/permissions.ts).
- **Trust stays human.** Provider repository/folder trust (which enables
  project-local hooks and policy) is surfaced in the browser for an explicit
  one-time human choice; one model never approves a trust boundary for another.
  The main agent runs in `$CC_DATA_DIR/main-workspace`, not your home directory.
- **Humans hold the merge.** Nothing merges itself — not the scheduler, not the
  main agent, not an approved reviewer.
- **Don't expose it.** The daemon has no auth. For remote access use Tailscale
  (`tailscale serve`, tailnet-only) — never `tailscale funnel` or a public
  tunnel. See [`docs/deployment.md`](docs/deployment.md).

---

## Contributing

Contributions welcome. The platform dogfoods itself — tasks that modify
commandcenter are dispatched *through* commandcenter, run in an isolated
worktree, and go through the same adversarial review + PR flow as any other task.

```sh
npm install && npm install --prefix web   # both packages
npm run dev:daemon                         # daemon with tsx (no build step)
npm run build:all                          # backend + dashboard when you need dist/
npm run typecheck                          # tsc --noEmit (strict)
npm test                                   # vitest (unit + worktree integration)
```

The web bundle and daemon are two separate TypeScript builds; shared,
dependency-free logic lives under `src/lib/` so it can be both unit-tested in
Node and imported by the Vite bundle.

**PR conventions:** branch from `main` (never push directly to `main`);
conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, …); open PRs with
`gh pr create`, describing what changed, why, and how you verified.

---

## License

[MIT](LICENSE) © 2026 Caleb Geene.
