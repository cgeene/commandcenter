import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerStatic } from "../src/daemon/static.js";
import { webDistDir } from "../src/config.js";

let tmpDir: string;
let app: Hono;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-static-"));
  tmpDir = fs.realpathSync(tmpDir);
  fs.writeFileSync(path.join(tmpDir, "index.html"), "<!doctype html>app");
  fs.writeFileSync(path.join(tmpDir, "manifest.webmanifest"), '{"name":"x"}');
  process.env.CC_WEB_DIST = tmpDir;
  app = new Hono();
  registerStatic(app);
});

afterEach(() => {
  delete process.env.CC_WEB_DIST;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("static serving", () => {
  it("serves the manifest as application/manifest+json — Chrome rejects the PWA install otherwise", async () => {
    const response = await app.request("/manifest.webmanifest");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/manifest+json",
    );
    expect(await response.json()).toEqual({ name: "x" });
  });

  it("falls back to index.html for unknown SPA routes", async () => {
    const response = await app.request("/board/some/deep/link");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("app");
  });
});

describe("webDistDir override", () => {
  // One table: every row hands webDistDir a different CC_WEB_DIST and asserts
  // where it lands. The two unsafe values must be IGNORED (falling back to the
  // bundled web/dist) rather than honoured, because the traversal guard in
  // registerStatic compares resolved paths with startsWith — a blank or
  // filesystem-root dist would make that comparison vacuously true.
  const DIST_CASES = [
    {
      why: "a blank CC_WEB_DIST is ignored — an empty dist would satisfy startsWith('') and disable the guard",
      env: "  ",
      suffix: () => path.join("web", "dist"),
    },
    {
      why: "a filesystem-root CC_WEB_DIST is ignored — a root dist would let the guard serve any file on the machine",
      env: "/",
      suffix: () => path.join("web", "dist"),
    },
    {
      why: "a relative CC_WEB_DIST is resolved to absolute — the guard compares absolute resolved paths",
      env: "./some/dist",
      suffix: () => path.join("some", "dist"),
      exact: () => path.resolve("./some/dist"),
    },
  ] as const;

  it("ignores an unsafe CC_WEB_DIST and always returns an absolute dist path", () => {
    for (const c of DIST_CASES) {
      process.env.CC_WEB_DIST = c.env;
      const dir = webDistDir();
      expect(path.isAbsolute(dir), c.why).toBe(true);
      expect(dir.endsWith(c.suffix()), c.why).toBe(true);
      if ("exact" in c) expect(dir, c.why).toBe(c.exact());
    }
  });
});
