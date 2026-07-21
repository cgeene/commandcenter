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
  it("ignores a blank CC_WEB_DIST — an empty dist would satisfy startsWith('') and disable the traversal guard", () => {
    process.env.CC_WEB_DIST = "  ";
    const dir = webDistDir();
    expect(path.isAbsolute(dir)).toBe(true);
    expect(dir.endsWith(path.join("web", "dist"))).toBe(true);
  });

  it("ignores a filesystem-root CC_WEB_DIST — a root dist would let the guard serve any file on the machine", () => {
    process.env.CC_WEB_DIST = "/";
    expect(webDistDir().endsWith(path.join("web", "dist"))).toBe(true);
  });

  it("resolves a relative CC_WEB_DIST to absolute — the guard compares against absolute resolved paths", () => {
    process.env.CC_WEB_DIST = "./some/dist";
    expect(webDistDir()).toBe(path.resolve("./some/dist"));
  });
});
