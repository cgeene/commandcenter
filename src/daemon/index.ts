#!/usr/bin/env node
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import {
  configuredRepoRoots,
  dataDir,
  dbPath,
  port,
  webDistDir,
} from "../config.js";
import { getDb } from "../db/db.js";
import { migrateDocsToFrontmatter } from "../db/docs.js";
import { buildApp } from "./api.js";
import { startJiraSync } from "./jirasync.js";
import { startPrSync } from "./prsync.js";
import { startScheduler } from "./scheduler.js";
import { registerStatic } from "./static.js";
import { attachTerminal } from "./termws.js";
import { initVersion } from "./version.js";

getDb(); // open + migrate up front so failures are loud at startup
// Bring the on-disk doc store up to the current layout (frontmatter + version
// sidecars + per-project index). Idempotent; never blocks boot on failure.
try {
  const m = migrateDocsToFrontmatter();
  if (m.updated || m.relocated) {
    console.log(
      `doc store: ${m.updated} file(s) got frontmatter, ${m.relocated} sidecar(s) relocated`,
    );
  }
} catch (err) {
  console.error("doc frontmatter migration failed (continuing):", err);
}
initVersion(); // snapshot dist/ mtime for stale-daemon detection

const app = buildApp();
registerStatic(app); // catch-all — must come after API routes

const server = serve(
  { fetch: app.fetch, port: port(), hostname: "127.0.0.1" },
  (info) => {
    console.log(`agentd listening on http://127.0.0.1:${info.port}`);
    console.log(`data dir: ${dataDir()} (db: ${dbPath()})`);
    console.log(`dashboard: ${webDistDir()}`);
    if (configuredRepoRoots().length === 0) {
      console.warn(
        "warning: CC_REPO_ROOTS is not set — the repository picker will be empty. " +
          "Set it to the parent folder(s) of your git repos, e.g. " +
          'export CC_REPO_ROOTS="$HOME/projects" (":"-separate multiple roots).',
      );
    }
  },
) as Server;

// A second `agentd` on a port that's already bound (leftover process, `agp
// upgrade` already respawned it, launchd + a manual run, etc.) used to crash
// with a raw EADDRINUSE stack trace. Tell the difference between "another
// agentd already has this" (fine, just exit) and "something else owns the
// port" (loud failure, since that's a real misconfiguration).
server.on("error", async (err) => {
  if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
  const url = `http://127.0.0.1:${port()}`;
  try {
    const res = await fetch(`${url}/api/version`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const v = (await res.json()) as { started_at: string; stale: boolean };
      console.log(
        `agentd is already running at ${url} (started ${v.started_at}, stale: ${v.stale}).`,
      );
      console.log(
        "Nothing to do — this process is exiting. Use `agp doctor` to confirm, `agp upgrade` to rebuild+restart it in place.",
      );
      process.exit(0);
    }
  } catch {
    /* not agentd (or unreachable) — fall through to the loud failure below */
  }
  console.error(
    `port ${port()} is already in use by something that isn't agentd (no response from ${url}/api/version).\n` +
      `Find it with \`lsof -i :${port()}\` and stop it, or run agentd on another port: CC_PORT=<port> agentd`,
  );
  process.exit(1);
});

startScheduler();
startPrSync();
// JIRA sync: inert unless CC_JIRA_TOKEN is set AND the master switch is on
// (per-repo opt-in on top). Fail-closed — a token-less install logs one line.
startJiraSync();

// Live terminal: /ws/term/<agentId> bridges xterm.js <-> tmux via a PTY.
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const match = url.pathname.match(/^\/ws\/term\/(\d+)$/);
  if (!match) {
    socket.destroy();
    return;
  }
  const agentId = Number(match[1]);
  const cols = Number(url.searchParams.get("cols")) || undefined;
  const rows = Number(url.searchParams.get("rows")) || undefined;
  wss.handleUpgrade(req, socket, head, (ws) => {
    const size = cols && rows ? { cols, rows } : undefined;
    attachTerminal(ws, agentId, size).catch((err) => {
      console.error(`terminal attach failed for a${agentId}:`, err);
      ws.close();
    });
  });
});
