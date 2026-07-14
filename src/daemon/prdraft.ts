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
  const stripped = title.replace(/^\[UNREVIEWED\]\s*/, "");
  if (stripped !== title) {
    await runGh(["pr", "edit", prUrl, "--title", stripped]);
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
