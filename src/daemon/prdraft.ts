import { execFile } from "node:child_process";

/**
 * Draft-state mechanics for worker PRs. A worker PR is created as a DRAFT so
 * GitHub's native draft state doubles as the "internal adversarial review is
 * still pending/rejecting" signal; the platform flips it to ready-for-review
 * only once the reviewer approves. These helpers are thin wrappers over `gh`
 * that THROW on failure so callers (review.ts) can surface it loudly — an
 * approved-but-still-draft PR (or a rejected-but-still-ready one) is a state
 * that would mislead the human, so it must never fail silently.
 */

/** The prefix a worker prepends when the draft-create fallback path fires. */
export const UNREVIEWED_PREFIX = "[UNREVIEWED] ";

/**
 * PR-title prefix ownership (two independent daemon writers touch a PR title):
 *
 *   [KEY-N] [UNREVIEWED] <base title>
 *   └──┬──┘ └────┬─────┘
 *   ticket-    markPrReady
 *   retitle    (this file)
 *   (enforcePrTitle)
 *
 * They operate on DISJOINT prefixes and must never fight:
 *  - `enforcePrTitle` owns the `[KEY-N]` prefix. It re-normalizes the title to
 *    the canonical order above, re-adding `[KEY-N]` and PRESERVING any
 *    `[UNREVIEWED]` marker it finds — it never removes `[UNREVIEWED]`.
 *  - `markPrReady` owns the `[UNREVIEWED]` prefix. It removes `[UNREVIEWED]`
 *    (wherever it sits, even after a `[KEY-N]`) and PRESERVES any `[KEY-N]`.
 *
 * Because each writer only ever adds/removes its own prefix and leaves the
 * other's intact, the two compose in either order and converge on the same
 * final title.
 */

/** Matches an optional leading `[KEY-N]` bracket then an optional `[UNREVIEWED]`
 *  bracket. Every group is optional, so `.exec` always matches (possibly empty)
 *  — the doc's canonical strip regex (§3.3). */
const TITLE_PREFIX_RE = /^(\[[A-Z][A-Z0-9]+-\d+\]\s*)?(\[UNREVIEWED\]\s*)?/;

/** Strip a leading `[UNREVIEWED]` even when a `[KEY-N]` precedes it, keeping the
 *  `[KEY-N]` (captured as $1). markPrReady's half of the disjoint ownership. */
const UNREVIEWED_STRIP_RE = /^(\[[A-Z][A-Z0-9]+-\d+\]\s*)?\[UNREVIEWED\]\s*/;

export type GhRunner = (args: string[]) => Promise<string>;

function execGh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout),
    );
  });
}

let runGh: GhRunner = execGh;

/** Test seam: swap the gh runner (pass null to restore the real one). */
export function _setGhRunner(fn: GhRunner | null): void {
  runGh = fn ?? execGh;
}

/**
 * Flip a PR from draft to ready-for-review and strip any "[UNREVIEWED]" title
 * prefix left by the worker's no-draft fallback path. Called when internal
 * review approves — after this, "ready for review" on GitHub literally means
 * "passed internal review, safe to merge".
 */
export async function markPrReady(prUrl: string): Promise<void> {
  await runGh(["pr", "ready", prUrl]);
  const title = (
    await runGh(["pr", "view", prUrl, "--json", "title", "-q", ".title"])
  ).trim();
  // Remove only the [UNREVIEWED] token; preserve a leading [KEY-N] ($1) that
  // enforcePrTitle may have added, so the two writers don't clobber each other.
  const stripped = title.replace(UNREVIEWED_STRIP_RE, "$1").trim();
  if (stripped !== title) {
    await runGh(["pr", "edit", prUrl, "--title", stripped]);
  }
}

/**
 * Enforce the Nylas bracketed `[KEY-N]` PR-title convention from the daemon,
 * once a ticket exists for the task (§3.3 step 4). Idempotent: it strips any
 * existing `[KEY-N]` prefix (and locates a following `[UNREVIEWED]` marker),
 * then re-prepends `[KEY-N]`, keeping the `[UNREVIEWED]` marker in place. So:
 *  - running it twice is a no-op,
 *  - a wrong/stale `[KEY-N]` is corrected to the current key (the reconciler
 *    heals stale titles on later passes),
 *  - it never strips `[UNREVIEWED]` — that belongs to markPrReady.
 *
 * Only ever called for commandcenter-originated PRs (the daemon passes the
 * task's own pr_url); it never touches other PRs in the repo. THROWS on gh
 * failure so the caller records it against the jira sync-failure streak — a
 * retitle failure is recoverable (the key is already persisted), so the sync
 * pass retries on a later pass and never re-creates a ticket.
 */
export async function enforcePrTitle(prUrl: string, key: string): Promise<void> {
  const current = (
    await runGh(["pr", "view", prUrl, "--json", "title", "-q", ".title"])
  ).trim();
  const m = TITLE_PREFIX_RE.exec(current)!; // always matches (all groups optional)
  const hadUnreviewed = Boolean(m[2]);
  const base = current.slice(m[0].length);
  const desired = `[${key}] ${hadUnreviewed ? UNREVIEWED_PREFIX : ""}${base}`;
  if (desired !== current) {
    await runGh(["pr", "edit", prUrl, "--title", desired]);
  }
}

/**
 * Convert a PR back to draft — used when a previously-ready PR is rejected on
 * re-review (or has otherwise drifted to ready while internal review is not
 * approving), so the GitHub-visible draft state keeps meaning "not yet
 * internally approved".
 */
export async function markPrDraft(prUrl: string): Promise<void> {
  await runGh(["pr", "ready", "--undo", prUrl]);
}
