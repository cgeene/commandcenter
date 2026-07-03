import fs from "node:fs";
import path from "node:path";
import type { Hono } from "hono";
import { webDistDir } from "../config.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

/** Serve the built dashboard (web/dist) with SPA index.html fallback.
 *  Registered after the API routes so /api and /ws stay untouched. */
export function registerStatic(app: Hono): void {
  app.get("*", (c) => {
    const dist = webDistDir();
    if (!fs.existsSync(path.join(dist, "index.html"))) {
      return c.text(
        "dashboard not built — run: npm run build:web\n(API is up; agp works.)",
        503,
      );
    }
    const urlPath = new URL(c.req.url).pathname;
    // resolve + prefix check prevents path traversal
    const resolved = path.resolve(dist, "." + urlPath);
    const file =
      resolved.startsWith(dist) &&
      fs.existsSync(resolved) &&
      fs.statSync(resolved).isFile()
        ? resolved
        : path.join(dist, "index.html");
    const type = MIME[path.extname(file)] ?? "application/octet-stream";
    return c.body(fs.readFileSync(file), 200, { "content-type": type });
  });
}
