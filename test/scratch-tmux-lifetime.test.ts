import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { scratchHubCommand } from "./fixtures/scratchtmux.js";

// Behavioural proof that a scratch tmux server ends on its own. The real bound is
// 900s, so it is asserted here on a short one — a string that merely LOOKS right
// is the failure this guards: the pane command reaches tmux through `/bin/sh -c`,
// which is the layer that silently ate a previous fixture's bound.
//
// Every command below names its socket explicitly, so this file needs no
// TMUX_TMPDIR of its own and can never reach the operator's server.
const tmuxAvailable = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

vi.setConfig({ testTimeout: 60_000 });

const HUB_SEC = 10;

let socketDir: string | undefined;

function tmux(socket: string, ...args: string[]): string {
  return execFileSync("tmux", ["-S", socket, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor<T>(
  ready: () => T | undefined,
  what: string,
  timeoutMs = 40_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = ready();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

afterAll(() => {
  if (!socketDir) return;
  // Net for a bound that did NOT fire, so a failure here cannot strand the very
  // thing this file exists to prevent. Kill before removing the directory: the
  // socket is inside it, and an unlinked socket puts the server out of reach.
  spawnSync("tmux", ["-S", path.join(socketDir, "sock"), "kill-server"], {
    stdio: "ignore",
  });
  fs.rmSync(socketDir, { recursive: true, force: true });
});

describe.skipIf(!tmuxAvailable)("a scratch tmux server bounds its own lifetime", () => {
  it("exits on its own while a remain-on-exit corpse holds the session open", async () => {
    socketDir = fs.mkdtempSync("/tmp/cc-hubbound-");
    const socket = path.join(socketDir, "sock");
    const session = "cc-test-hubbound";

    tmux(socket, "new-session", "-d", "-s", session, "-n", "hub",
      scratchHubCommand(HUB_SEC));
    const serverPid = Number(tmux(socket, "display-message", "-p", "#{pid}").trim());
    expect(serverPid).toBeGreaterThan(1);

    // The shape a killed run leaves behind: `newWindow()` sets remain-on-exit on
    // every window the daemon creates, so a window whose command has exited stays
    // as a dead pane. `exit-empty` can therefore never collect this server, which
    // is why the hub kills it outright instead of waiting to be emptied.
    //
    // Set globally BEFORE the window exists: applying it per-window afterwards
    // races the command, and a window that exits first is simply gone.
    tmux(socket, "set-option", "-g", "-w", "remain-on-exit", "on");
    tmux(socket, "new-window", "-d", "-t", session, "true");
    await waitFor(
      () =>
        tmux(socket, "list-windows", "-t", session, "-F", "#{pane_dead}")
          .includes("1") || undefined,
      "the remain-on-exit window to become a dead-pane corpse",
    );

    // Nothing signals the server: the assertion is that it goes by itself.
    await waitFor(() => (alive(serverPid) ? undefined : true),
      "the scratch tmux server to reap itself");
  });

  it("does nothing at all when it cannot tell which socket it belongs to", () => {
    // A pane outside tmux has no $TMUX, so there is no socket to read back and
    // nothing this can show is its own. The default socket is the operator's own
    // server, so the bound must stay inert rather than let tmux pick one.
    const fakeBin = fs.mkdtempSync("/tmp/cc-hubbound-bin-");
    try {
      const marker = path.join(fakeBin, "invoked");
      fs.writeFileSync(
        path.join(fakeBin, "tmux"),
        `#!/bin/sh\necho "$@" >> ${JSON.stringify(marker)}\n`,
        { mode: 0o755 },
      );
      const result = spawnSync("/bin/sh", ["-c", scratchHubCommand(0)], {
        env: { PATH: `${fakeBin}:${process.env.PATH ?? ""}`, TMUX: "" },
        stdio: "ignore",
      });

      expect(result.status).not.toBe(0);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });
});
