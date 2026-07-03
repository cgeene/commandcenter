#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { dataDir, dbPath, port } from "../config.js";
import { getDb } from "../db/db.js";
import { buildApp } from "./api.js";

getDb(); // open + migrate up front so failures are loud at startup

const app = buildApp();

serve({ fetch: app.fetch, port: port(), hostname: "127.0.0.1" }, (info) => {
  console.log(`agentd listening on http://127.0.0.1:${info.port}`);
  console.log(`data dir: ${dataDir()} (db: ${dbPath()})`);
});
