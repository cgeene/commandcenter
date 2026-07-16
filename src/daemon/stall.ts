// Anchored on the bullet immediately followed by "API Error:" (only
// whitespace in between) — this is the harness's own rendering of a
// mid-response transport failure, never how an agent quotes an error while
// narrating in prose (which always has other words between the bullet and
// the phrase).
const ANCHOR_RE = /^\s*⏺\s*API Error:/i;
const SIGNATURE_RE =
  /(Server error|Overloaded|overloaded_error|rate.?limit|Internal server error)/i;
const BLOCK_START_RE = /^\s*⏺/;
const CODEX_ERROR_RE =
  /^\s*(?:■|⚠)\s*(?:stream disconnected|connection (?:closed|failed)|unexpected status|error sending request|server error|internal server error|rate.?limit)/i;

/**
 * Look for a transient-API-error line sitting at the very end of an agent's
 * tmux pane — the empty-prompt stall this module exists to auto-recover
 * from. Returns the matched error text, or null if nothing matched or if
 * any further ⏺ block appears after it (the agent kept working past it, so
 * whatever mentioned "API Error" was not the harness stalling the turn).
 */
export function detectTransientApiError(paneText: string): string | null {
  const lines = paneText.split("\n");

  let anchorIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (ANCHOR_RE.test(lines[i])) {
      anchorIdx = i;
      break;
    }
  }
  if (anchorIdx === -1) {
    // Codex uses a square/warning marker rather than Claude's ⏺ API Error
    // prefix. Require that marker at the start of the last visible non-empty
    // block so quoted error prose cannot trigger an automatic continuation.
    let end = lines.length - 1;
    while (end >= 0 && !lines[end].trim()) end--;
    if (end < 0) return null;
    let start = end;
    while (start > 0 && lines[start - 1].trim()) start--;
    if (!CODEX_ERROR_RE.test(lines[start])) return null;
    return lines
      .slice(start, end + 1)
      .map((line) => line.trim())
      .join(" ");
  }

  for (let i = anchorIdx + 1; i < lines.length; i++) {
    if (BLOCK_START_RE.test(lines[i])) return null;
  }

  // Fold in wrapped continuation lines — the status keyword (e.g.
  // "Overloaded") can land on the next physical line when tmux wraps a long
  // error payload.
  let block = lines[anchorIdx];
  for (let i = anchorIdx + 1; i < lines.length && lines[i].trim() !== ""; i++) {
    block += " " + lines[i];
  }
  block = block.trim();
  return SIGNATURE_RE.test(block) ? block : null;
}
