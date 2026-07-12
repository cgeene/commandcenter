# CLI reference (`agp`)

`agp` is the command-line client for the daemon. It talks to `agentd` over the
localhost REST API, so the daemon must be running. Everything here is also
doable from the dashboard.

```
agp <group> <command> [options]
```

## `agp task` — the queue

| Command | Description |
|---|---|
| `task add <title>` | Add a task. `--provider <claude\|codex>`, `-p/--prompt`, `-f/--prompt-file`, `-r/--repo` (default: current git repo), `-m/--model`, `-P/--priority <0-4>` (default 2), `-b/--blocked-by <id>`, `-v/--verify <cmd>`. |
| `task ls` | List tasks. `-s/--status <status>`, `--ready` (only queued tasks with no open blockers). |
| `task show <id>` | Full task detail as JSON. |
| `task update <id>` | Update fields: `-s/--status`, `-P/--priority`, `--provider <claude\|codex>`, `-m/--model`, `--result <summary>`. Provider changes are rejected while the task has a live agent. |
| `task claim <id>` | Atomically claim a queued task. |
| `task cancel <id>` | Close a task from any state (kills its live worker/reviewer). `--rm-worktree` also removes the worktree (uncommitted work is lost). Reports any tasks left dangling by `blocked_by`. |
| `task diff <id>` | Show the diff on the task's branch. `--stat` for stat + commits only. |

## `agp review <taskId>`

Spawn an independent adversarial reviewer for a task in `review`. `-m/--model`
overrides the Claude reviewer model (defaults to `CC_REVIEWER_MODEL`, then the
task model for an existing Claude workflow, otherwise `opus`; a Codex model is
never passed to Claude). Watch it with
`agp agent peek <id>`.

## `agp agent` — workers

| Command | Description |
|---|---|
| `agent spawn -t <id>` | Spawn a Claude Code or Codex worker. `--provider` and `-m/--model` override the task; `--fresh` forces a clean session. Resume is same-provider only. |
| `agent ls` | List agents. `-a/--all` includes dead agents. |
| `agent kill <id>` | Kill an agent's tmux window. `--requeue` puts its task back in the queue; `--rm-worktree` removes the worktree. |
| `agent peek <id>` | Print the agent's visible terminal output. `-n/--lines <n>` (default 50). |
| `agent send <id> <text…>` | Send a message into an agent's interactive session. |
| `agent session <id>` | Show provider, session ID, transcript path (when available), working directory, and a copyable provider-specific resume command. |

## `agp attach <agentId>`

Attach to an agent's tmux window interactively (detach with `Ctrl-b d`). Uses
`switch-client` when you're already inside tmux, otherwise `attach`.

## `agp main`

Spawn the orchestrator main agent. `-m/--model` (default `opus`, or
`CC_MAIN_MODEL`). One live main agent at a time.

## `agp scheduler` — autonomous control

| Command | Description |
|---|---|
| `scheduler status` | Show scheduler state (default subcommand). |
| `scheduler on` / `scheduler off` | Enable / disable autonomous spawning (the kill switch). |
| `scheduler set` | `--max <n>`, `--limit <n>` (daily spawn budget), `--stall <minutes>`, `--hours <"22-6"\|"always">`, `--auto-review <on\|off>`, `--escalate <minutes>`. |

See [`configuration.md`](configuration.md) for what each knob does and its default.

## `agp cron` — recurring task templates

| Command | Description |
|---|---|
| `cron add <name> -s <cron>` | Create a template. `--provider <claude\|codex>`, `-p/--prompt` or `-f/--prompt-file` (required), `-r/--repo`, `--title`, `-m/--model`, `-P/--priority`, `-v/--verify`. |
| `cron ls` | List crons with enabled state, schedule, and next/last run. |
| `cron enable <idOrName>` / `cron disable <idOrName>` | Toggle a cron. |
| `cron run <idOrName>` | Enqueue this cron's task immediately. |
| `cron rm <idOrName>` | Delete a cron. |

## `agp dream` — nightly reflection

`dream setup` creates the `dreaming` cron **disabled** (`-s/--schedule` default
`0 4 * * *`, `-m/--model` default `opus`, `-r/--repo` default commandcenter).
Test it with `agp cron run dreaming`; enable it with `agp cron enable dreaming`.

## `agp memory` — platform memory

| Command | Description |
|---|---|
| `memory ls` | Recent memories. `-n/--limit` (default 20). |
| `memory search <query…>` | Full-text search. |
| `memory add <text>` | Store a memory. `-t/--tags <comma,separated>`. |
| `memory rm <id>` | Delete a memory. |

## `agp events`

Recent platform events. `-n/--limit <n>` (default 30).

## `agp upgrade`

Rebuild (`npm run build:all`) and restart the daemon's tmux window in place, then
health-check it — fixes the stale-daemon warning after a source change.
`--main` also respawns the main agent so it picks up new MCP tools.

## `agp codex`

`agp codex setup` generates the isolated Command Center Codex profile and
static lifecycle hooks, then prints the one-time login and `/hooks` trust steps.
`agp codex doctor` checks the CLI, profile parse, isolated login, MCP build,
hook bridge build, and the hook policy/JSON contract. It never bypasses hook
trust or the Codex sandbox; a missing runtime `SessionStart` is surfaced by the
watchdog instead of being reported as a healthy worker.
