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

Later phases add hook-based done-detection, an orchestrator main agent with
MCP tools, a web dashboard (Tailscale-exposed), and an autonomous scheduler.

## Setup

```sh
npm install
npm run build
npm link        # puts `agentd` and `agp` on PATH
```

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
agp attach 1                            # interact; detach with C-b d
agp task update 1 -s review             # after checking the branch
agp agent kill 1 --rm-worktree
agp events
```

## Environment

| var | default | purpose |
|---|---|---|
| `CC_DATA_DIR` | `~/.commandcenter` | DB, worktrees, prompt files |
| `CC_PORT` | `4711` | daemon port (localhost only) |
| `CC_CLAUDE_BIN` | `claude` | worker binary (override for testing) |
| `CC_TMUX_SESSION` | `cc` | tmux session name |

## Statuses

Tasks: `queued → claimed → in_progress → blocked / review → done / failed`.
Agents: `spawning → working → idle / waiting_input / stalled → dead`.
Claiming is a single SQLite UPDATE — atomic; two agents can never take the
same task.
