// Derive installed-app signals from the live "Needs You" attention list: the
// icon badge count (Badging API) and which items just arrived (to raise a
// notification that bounces the dock icon). Both are pure/DOM-thin so the node
// test suite can cover them; the effects that call them live in web/src/App.tsx.

/** The slice of the Web Badging API the dashboard depends on. `setAppBadge` is
 *  optional: browsers without the API (or a non-installed context) don't expose
 *  it, and syncing must degrade to a no-op rather than throw. Clearing goes
 *  through `setAppBadge(0)` too (spec-equivalent to `clearAppBadge()`), so we
 *  depend on exactly one method — no asymmetric-support edge case. */
export interface BadgeNavigator {
  setAppBadge?: (count?: number) => Promise<void>;
}

/**
 * Mirror an attention count onto the installed app's icon badge: show the count
 * when something needs the operator, clear it at zero (setAppBadge(0)) so a
 * drained "Needs You" queue never leaves a stale badge behind. No-op (returns
 * undefined) when the Badging API is unavailable. Best-effort — the caller
 * swallows rejections.
 */
export function syncAppBadge(
  nav: BadgeNavigator,
  count: number,
): Promise<void> | undefined {
  if (!nav.setAppBadge) return undefined;
  return nav.setAppBadge(count); // count 0 clears the badge per the spec
}

/**
 * Attention-item ids present now but not in the previously-seen set — the
 * "just arrived" items that warrant a fresh notification (which bounces the
 * installed app's dock icon). `seen === null` means we haven't loaded yet, so
 * nothing counts as new: the caller seeds the set from the first real poll
 * (never the empty pre-load render) so the existing backlog doesn't all alert
 * at once. Diffing by id (not count) still fires when one item resolves and
 * another appears in the same poll.
 */
export function newlyArrivedIds(
  seen: ReadonlySet<string> | null,
  current: readonly string[],
): string[] {
  if (seen === null) return [];
  return current.filter((id) => !seen.has(id));
}

/** localStorage key for the per-browser "fire notifications" preference. The
 *  browser permission is one-way (a page can request it but never revoke it),
 *  so an explicit on/off toggle lives here and gates whether we notify at all. */
export const BROWSER_ALERTS_KEY = "cc:browser-alerts";

/**
 * Whether to fire browser notifications, per the stored on/off preference.
 * Unset (never toggled) defaults to `permissionGranted` — so a browser that
 * already has permission keeps notifying without an extra opt-in, while one
 * that doesn't stays quiet until the user turns it on. An explicit "0"/"1"
 * always wins.
 */
export function browserAlertsEnabled(
  store: Pick<Storage, "getItem">,
  permissionGranted: boolean,
): boolean {
  const stored = store.getItem(BROWSER_ALERTS_KEY);
  return stored === null ? permissionGranted : stored === "1";
}

/** Persist the on/off preference read by {@link browserAlertsEnabled}. */
export function setBrowserAlerts(store: Pick<Storage, "setItem">, on: boolean): void {
  store.setItem(BROWSER_ALERTS_KEY, on ? "1" : "0");
}
