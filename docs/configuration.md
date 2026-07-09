# Configuration reference

commandcenter has two kinds of configuration:

1. **Environment variables** — read at call time (defined in
   [`src/config.ts`](../src/config.ts)). Set them in the environment the daemon
   runs under (your shell, or the launchd plist's `EnvironmentVariables`).
2. **Scheduler config** — a JSON blob in the SQLite `settings` table, edited via
   `agp scheduler set …` or the dashboard (defaults in
   [`src/db/settings.ts`](../src/db/settings.ts)).

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CC_DATA_DIR` | `~/.commandcenter` | Root for the DB, worktrees, prompts, and generated per-agent settings/mcp files. |
| `CC_DOCS_DIR` | `$CC_DATA_DIR/docs` | Root of the internal doc store — plain `<project>/<slug>.md` files, grep-able directly. |
| `CC_PORT` | `4711` | Daemon HTTP/WebSocket port. Bound to `127.0.0.1` only. |
| `CC_URL` | `http://127.0.0.1:$CC_PORT` | Base URL agents and hooks use to reach the daemon. Override if you front the daemon differently. |
| `CC_CLAUDE_BIN` | `claude` | The binary launched for workers/reviewers/main. Override to a stub for testing. |
| `CC_TMUX_SESSION` | `cc` | tmux session name that hosts agent windows. |
| `CC_MAIN_MODEL` | `opus` | Default model for `agp main`. |
| `CC_NTFY_URL` | unset | ntfy topic URL (e.g. `https://ntfy.sh/<topic>`). Unset disables push notifications. |
| `CC_NTFY_TOKEN` | unset | ntfy auth token for a self-hosted or access-protected topic. |
| `CC_CLAUDE_PROJECTS` | `~/.claude/projects` | Where Claude Code stores session transcripts — read for token accounting and `--resume`. |

### Derived paths (under `CC_DATA_DIR`)

- `state.db` — the SQLite database (tasks, agents, events, memories, docs, crons, settings)
- `worktrees/` — per-task git worktrees
- `prompts/` — generated worker/reviewer/main prompt files
- `settings/` — generated per-agent `--settings` JSON (never your `~/.claude/settings.json`)
- `mcp/` — generated per-agent `--mcp-config` JSON

## Scheduler config

Edit with `agp scheduler set …` (see [`cli.md`](cli.md)) or the dashboard's auto
button. Unknown keys fall back to the defaults below.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master switch for autonomous spawning. The dashboard kill switch flips this. |
| `max_concurrent` | `3` | Max live workers the scheduler maintains. Manual spawns aren't counted against it but occupy slots. |
| `daily_spawn_limit` | `20` | Autonomous spawns allowed per UTC day — a budget backstop. Manual spawns still work after the limit. |
| `stall_minutes` | `15` | Minutes without any hook event before a working agent is marked stalled and pushed to your phone. |
| `active_hours` | `null` | Only auto-spawn within this hour window (local time). `null` = always. `start > end` wraps overnight (e.g. `22-6`). |
| `auto_review` | `true` | Auto-spawn an adversarial reviewer when a task reaches `review`. Report-only tasks (e.g. the dreamer) are skipped. |
| `escalate_minutes` | `5` | Minutes a worker may sit in `waiting_input` (after the main agent was asked to unblock it) before the human is paged. |
| `attention_stale_minutes` | `10` | Minutes an agent may sit in `waiting_input` before the "Needs You" panel flags it as stale. |
| `read_only_extra_allow` | `[]` | Extra **read-only** permission patterns appended to the baked-in read-only profile for worker/reviewer settings. |

### `read_only_extra_allow` — a safety note

This list is applied **unconditionally** to every generated worker and reviewer
settings file, on top of the baked-in `READ_ONLY_PROFILE` in
[`src/daemon/permissions.ts`](../src/daemon/permissions.ts). Use it to allowlist a
newly added **read-only** MCP tool or command without a code change — for
example `mcp__some_server__get_*` or `Bash(some-cli status*)`.

**Never** put a state-changing pattern here. Anything that could mutate state
should fall through to a normal permission prompt instead. If in doubt, leave it
out.
