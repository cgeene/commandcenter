import { describe, expect, it } from "vitest";
import { classifyGhStatus } from "../src/cli/doctor.js";

describe("classifyGhStatus", () => {
  it("reports authenticated when gh exits 0", () => {
    const [ok, detail] = classifyGhStatus({ status: 0 });
    expect(ok).toBe(true);
    expect(detail).toBe("authenticated");
  });

  it("reports not authenticated when gh exits non-zero", () => {
    const [ok, detail] = classifyGhStatus({ status: 1 });
    expect(ok).toBe(false);
    expect(detail).toMatch(/gh auth login/);
  });

  it("reports not installed when the binary cannot be spawned", () => {
    const spawnError = classifyGhStatus({
      error: new Error("spawn gh ENOENT"),
      status: null,
    });
    expect(spawnError[0]).toBe(false);
    expect(spawnError[1]).toMatch(/not installed/);

    // A null status without an error object (killed/failed spawn) is also
    // treated as "not installed" rather than not-authenticated.
    const nullStatus = classifyGhStatus({ status: null });
    expect(nullStatus[0]).toBe(false);
    expect(nullStatus[1]).toMatch(/not installed/);
  });
});
