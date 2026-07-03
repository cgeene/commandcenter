#!/usr/bin/env node
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import { dataDir, dbPath, port, webDistDir } from "../config.js";
import { getDb } from "../db/db.js";
import { buildApp } from "./api.js";
import { registerStatic } from "./static.js";
import { attachTerminal } from "./termws.js";

getDb(); // open + migrate up front so failures are loud at startup

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
