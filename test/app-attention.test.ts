import { describe, expect, it, vi } from "vitest";
import {
  syncAppBadge,
  newlyArrivedIds,
  browserAlertsEnabled,
  setBrowserAlerts,
  BROWSER_ALERTS_KEY,
  type BadgeNavigator,
} from "../src/lib/app-attention.js";

function fakeStore(initial?: string): Pick<Storage, "getItem" | "setItem"> & {
  value: string | null;
} {
  return {
    value: initial ?? null,
    getItem(k: string) {
      return k === BROWSER_ALERTS_KEY ? this.value : null;
    },
    setItem(k: string, v: string) {
      if (k === BROWSER_ALERTS_KEY) this.value = v;
    },
  };
}

function fakeNav(): { setAppBadge: ReturnType<typeof vi.fn> } {
  return { setAppBadge: vi.fn(() => Promise.resolve()) };
}

describe("syncAppBadge", () => {
  it("shows the count when something needs attention", () => {
    const nav = fakeNav();
    syncAppBadge(nav, 3);
    expect(nav.setAppBadge).toHaveBeenCalledWith(3);
  });

  it("clears the badge at zero (setAppBadge(0)) so a drained queue leaves no stale count", () => {
    const nav = fakeNav();
    syncAppBadge(nav, 0);
    expect(nav.setAppBadge).toHaveBeenCalledWith(0);
  });

  it("no-ops on browsers without the Badging API instead of throwing", () => {
    const nav: BadgeNavigator = {};
    expect(() => syncAppBadge(nav, 5)).not.toThrow();
    expect(syncAppBadge(nav, 5)).toBeUndefined();
  });
});

describe("newlyArrivedIds", () => {
  it("returns nothing on first load so the backlog doesn't all alert at once", () => {
    expect(newlyArrivedIds(null, ["a", "b", "c"])).toEqual([]);
  });

  it("returns only ids not previously seen", () => {
    expect(newlyArrivedIds(new Set(["a", "b"]), ["a", "b", "c"])).toEqual(["c"]);
  });

  it("alerts when an item is swapped even though the count is unchanged", () => {
    // 'a' resolved, 'c' appeared: same length, but 'c' is genuinely new.
    expect(newlyArrivedIds(new Set(["a", "b"]), ["b", "c"])).toEqual(["c"]);
  });

  it("returns nothing when the set is unchanged", () => {
    expect(newlyArrivedIds(new Set(["a", "b"]), ["a", "b"])).toEqual([]);
  });
});

describe("browserAlertsEnabled / setBrowserAlerts", () => {
  it("defaults to the browser permission when never toggled", () => {
    expect(browserAlertsEnabled(fakeStore(), true)).toBe(true);
    expect(browserAlertsEnabled(fakeStore(), false)).toBe(false);
  });

  it("an explicit stored preference overrides the permission default", () => {
    expect(browserAlertsEnabled(fakeStore("0"), true)).toBe(false); // off despite permission
    expect(browserAlertsEnabled(fakeStore("1"), false)).toBe(true); // on regardless
  });

  it("round-trips the on/off preference", () => {
    const store = fakeStore();
    setBrowserAlerts(store, true);
    expect(browserAlertsEnabled(store, false)).toBe(true);
    setBrowserAlerts(store, false);
    expect(browserAlertsEnabled(store, true)).toBe(false);
  });
});
