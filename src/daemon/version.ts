import fs from "node:fs";
import path from "node:path";
import { pkgRoot } from "../config.js";

/**
 * Stale-daemon detection. The daemon snapshots the newest mtime under dist/
 * at boot; if dist/ later grows a newer file (someone rebuilt), the running
 * process is stale and every feature since the rebuild silently doesn't run
 * — which has bitten twice. /api/version exposes it; the watchdog pushes it.
 */

const startedAt = new Date().toISOString();
let buildMtimeAtBoot = 0;

/** Newest mtime (ms) of any .js file under dist/. 0 when dist/ is absent (dev via tsx). */
export function distMtime(): number {
  let max = 0;
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) {
        const m = fs.statSync(p).mtimeMs;
        if (m > max) max = m;
      }
    }
  };
  walk(path.join(pkgRoot(), "dist"));
  return max;
}

export function initVersion(): void {
  buildMtimeAtBoot = distMtime();
}

export function versionInfo(): {
  started_at: string;
  build_mtime: string | null;
  dist_mtime: string | null;
  stale: boolean;
} {
  const cur = distMtime();
  return {
    started_at: startedAt,
    build_mtime: buildMtimeAtBoot ? new Date(buildMtimeAtBoot).toISOString() : null,
    dist_mtime: cur ? new Date(cur).toISOString() : null,
    // 2s slack: build:all writes files over a short window
    stale: buildMtimeAtBoot > 0 && cur > buildMtimeAtBoot + 2000,
  };
}
