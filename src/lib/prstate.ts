/**
 * The ONE casing boundary for a PR's lifecycle state.
 *
 * `gh pr view --json state` reports it UPPERCASE ("OPEN"/"MERGED"/"CLOSED");
 * the tasks.pr_state column — and every consumer of it, including the web PR
 * board — stores and compares it lowercase. Both sides go through this helper,
 * so a casing mismatch can only ever be wrong in one place.
 */

export type PrLifecycle = "open" | "merged" | "closed";

/** Canonical lowercase lifecycle, or null when it isn't one we recognize
 *  (never synced, or a value from a future/broken `gh`). Callers must treat
 *  null as unknown, never as open. */
export function normalizePrState(raw: string | null | undefined): PrLifecycle | null {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "open":
      return "open";
    case "merged":
      return "merged";
    case "closed":
      return "closed";
    default:
      return null;
  }
}
