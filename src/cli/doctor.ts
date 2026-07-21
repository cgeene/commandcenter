// Pure classification helpers for `agp doctor`, factored out of the command
// action so they can be unit-tested without invoking the CLI.

export interface SpawnResultLike {
  error?: Error;
  status: number | null;
}

/**
 * Classify a `gh auth status` spawn result into a doctor check. A spawn failure
 * (binary missing, non-executable) surfaces as "not installed" rather than being
 * conflated with an authenticated-but-not-logged-in state.
 */
export function classifyGhStatus(r: SpawnResultLike): [boolean, string] {
  if (r.error || r.status === null) {
    return [false, "not installed — install GitHub CLI (https://cli.github.com)"];
  }
  if (r.status === 0) {
    return [true, "authenticated"];
  }
  return [false, "not authenticated — run `gh auth login`"];
}
