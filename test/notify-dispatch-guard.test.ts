import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The daemon is the only process allowed to put an ntfy push on the wire.
 *
 * A test run, a script driving the built dist, the MCP server and `node -e` all
 * import the same notify module, and CC_NTFY_URL can be present in their
 * environment (the daemon execs verify commands as children of itself), so
 * without this guard fixture rows reach the operator's phone.
 */

let tmpDir: string;
let fetchMock: ReturnType<typeof vi.fn>;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-dispatch-"));
  process.env.CC_DATA_DIR = tmpDir;
  process.env.CC_NTFY_URL = "https://ntfy.test/cc-guard";
  process.env.CC_NTFY_TOKEN = "tk-guard";
  fetchMock = vi.fn(async () => new Response("ok"));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  const { clearRecordedPushes } = await import("../src/daemon/notify.js");
  clearRecordedPushes();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db/db.js");
  closeDb();
  globalThis.fetch = realFetch;
  delete process.env.CC_NTFY_URL;
  delete process.env.CC_NTFY_TOKEN;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ORDER MATTERS: marking the daemon is irreversible for this process, so the
// unmarked case must be asserted first. The isDaemonProcess() assertion below
// fails loudly if that ever stops holding.
describe("ntfy dispatch is daemon-only", () => {
  it("records the push and touches no network outside the daemon", async () => {
    const { notify, notifyEvent, recordedPushes } = await import(
      "../src/daemon/notify.js"
    );
    const { isDaemonProcess } = await import("../src/process-role.js");
    const { listEvents } = await import("../src/db/events.js");
    expect(isDaemonProcess()).toBe(false);

    expect(notify("raw", "body", { priority: "high", tags: "warning" })).toBe(true);
    expect(
      notifyEvent("task_blocked", "task #1 is blocked", "fixture row", {
        once: "guard:1",
      }),
    ).toBe(true);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(recordedPushes()).toEqual([
      { title: "raw", message: "body", priority: "high", tags: "warning" },
      { title: "task #1 is blocked", message: "fixture row", priority: "default" },
    ]);

    // Everything downstream of the transport still behaves as in the daemon, so
    // latch and event-log assertions keep working outside it.
    const pushed = listEvents(20).filter((e) => e.kind === "notify.pushed");
    expect(pushed).toHaveLength(1);
    expect(JSON.parse(pushed[0].payload!).recorded_only).toBe(true);
    expect(
      notifyEvent("task_blocked", "again", "m", { once: "guard:1" }),
    ).toBe(false);
  });

  it("dispatches for real once the process has been marked as the daemon", async () => {
    const { markDaemonProcess } = await import("../src/process-role.js");
    markDaemonProcess(); // exactly what src/daemon/index.ts does at boot
    const { notify, recordedPushes } = await import("../src/daemon/notify.js");

    expect(notify("live", "body", { tags: "rocket" })).toBe(true);
    expect(recordedPushes()).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { method: string; body: string; headers: Record<string, string> },
    ];
    expect(url).toBe("https://ntfy.test/cc-guard");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("body");
    expect(init.headers.Title).toBe("live");
    expect(init.headers.Priority).toBe("default");
    expect(init.headers.Tags).toBe("rocket");
    expect(init.headers.Authorization).toBe("Bearer tk-guard");
  });
});
