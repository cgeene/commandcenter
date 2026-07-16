# Running the daemon

The daemon (`agentd`) is the only long-running process. Everything else — the
CLI, agents, the dashboard — talks to it. It binds to `127.0.0.1` and has no
authentication of its own, so keep it local (see [remote access](#remote-access-tailscale)).

## Foreground (any platform)

Simplest for development, and the only option on Linux:

```sh
agentd                 # if you ran `npm link`
# or, from a clone:
npm run dev:daemon     # tsx src/daemon/index.ts — no build step needed
```

It logs its listen address, data dir, and dashboard path on boot. Stop it with
`Ctrl-c`.

## launchd (macOS, run at login)

On a Mac you'll want the daemon to start at login and restart on crash. Run it
under `launchd` with a user LaunchAgent.

### 1. Build first

launchd should run the compiled daemon, so build it once (and after every source
change, or use `agp upgrade`):

```sh
cd /path/to/commandcenter
npm run build:all
```

### 2. Create the plist

Save this as `~/Library/LaunchAgents/com.commandcenter.agentd.plist`. Replace the
bracketed values:

- `[YOU]` — your macOS username
- `[/ABSOLUTE/PATH/TO/commandcenter]` — the repo checkout
- the `PATH` entry must include the directories holding `node`, `claude`,
  `codex`, `gh`, `tmux`, and `git` — launchd starts with a minimal `PATH`, so
  agents will fail to find these tools unless you spell it out (check with
  `which node claude codex gh tmux git`).

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.commandcenter.agentd</string>

  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>[/ABSOLUTE/PATH/TO/commandcenter]/dist/daemon/index.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>[/ABSOLUTE/PATH/TO/commandcenter]</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/Users/[YOU]/.local/bin:/usr/bin:/bin</string>
    <!-- optional overrides:
    <key>CC_NTFY_URL</key><string>https://ntfy.sh/your-secret-topic</string>
    <key>CC_WORKER_PROVIDER</key><string>codex</string>
    <key>CC_REPO_ROOTS</key><string>/Users/[YOU]/Documents/git</string>
    <key>CC_CODEX_MCP_SOURCE_HOME</key><string>/Users/[YOU]/.codex</string>
    -->
  </dict>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/Users/[YOU]/.commandcenter/agentd.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/[YOU]/.commandcenter/agentd.err.log</string>
</dict>
</plist>
```

> `/usr/local/bin/node` is the Intel-Homebrew / nodejs.org path; on Apple Silicon
> Homebrew it's `/opt/homebrew/bin/node`. Use the output of `which node`.

`CC_CODEX_MCP_SOURCE_HOME` is optional. When set, Codex workers inherit explicit
MCP tables; plugin-provided MCPs are converted to isolated MCP transport entries
without enabling the source plugins. Auth, sessions, history, hooks, plugin
skills/apps, and trust state remain under `$CC_DATA_DIR/codex`. Every
environment variable referenced by an enabled inherited MCP must also be
present in the daemon environment. Supply those through a credential manager
or a protected launcher rather than writing tokens directly into this plist.
Without this setting, Codex workers receive only Command Center's `cc` MCP.

`CC_REPO_ROOTS` enables the dashboard repository picker and constrains explicit
interactive tasks to canonical Git roots beneath the configured directory. For
multiple roots, separate paths with `:` on macOS/Linux. The broad root is used
only for read-only discovery and portfolio planning; write-capable workers
receive one selected repository worktree, never the root itself.

### 3. Load it

```sh
launchctl load  ~/Library/LaunchAgents/com.commandcenter.agentd.plist   # start
launchctl unload ~/Library/LaunchAgents/com.commandcenter.agentd.plist  # stop
```

Confirm it's up:

```sh
curl -s http://127.0.0.1:4711/api/version
agp scheduler status
```

After a source change, rebuild and restart in place with `agp upgrade` (it
respawns the daemon's tmux window and health-checks it).

## Remote access (Tailscale)

The daemon binds to `127.0.0.1` only and has no auth. To reach the dashboard
from your phone, put it behind [Tailscale](https://tailscale.com/) — installed on
both the Mac and the phone — then:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:4711
```

This publishes `https://<mac-name>.<tailnet>.ts.net` with automatic TLS,
reachable **only from your tailnet** (WebSockets included, so live terminals
work).

> **Do not use `tailscale funnel`** or any public tunnel — that would expose an
> unauthenticated daemon, and therefore your machine and repos, to the internet.
