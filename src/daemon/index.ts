#!/usr/bin/env node
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import { dataDir, dbPath, port, webDistDir } from "../config.js";
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
  },
) as Server;

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
