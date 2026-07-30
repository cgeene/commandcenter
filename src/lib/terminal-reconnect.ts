/**
 * The reconnect contract between the terminal websocket (src/daemon/termws.ts)
 * and the browser terminal (web/src/Terminal.tsx).
 *
 * The client reconnects on every close, so the server needs a way to say "do
 * not come back" — otherwise a condition that will never clear (the agent's
 * tmux window is gone for good) turns into an endless reconnect cycle that
 * looks, from the phone, like a terminal flickering every few seconds.
 */

/**
 * Close code for "this terminal will not work on a retry". Application close
 * codes are 4000-4999; anything else (including the 1006 a dropped connection
 * produces) is treated as transient and retried.
 */
export const TERM_CLOSE_PERMANENT = 4001;

export function isPermanentClose(code: number): boolean {
  return code === TERM_CLOSE_PERMANENT;
}

/** First retry delay, and the delay a reset backoff goes back to. */
const RECONNECT_BASE_MS = 500;
/** Ceiling on the retry delay. */
const RECONNECT_MAX_MS = 30_000;
/** 500 * 2**6 = 32s, i.e. the first exponent past the ceiling. */
const RECONNECT_MAX_EXPONENT = 6;
/** Fraction of the delay spread randomly around it, i.e. ±25%. */
const RECONNECT_JITTER = 0.5;

/**
 * How long a connection has to stay open before it counts as a real session
 * rather than another turn of a reconnect loop. Below this, the backoff keeps
 * growing: a server that accepts a socket and immediately closes it must not
 * be hammered at the base delay forever.
 */
export const STABLE_CONNECTION_MS = 5_000;

/**
 * Attempt counter for the next connection. `openMs` is how long the connection
 * that just closed was open, or null if it never opened at all.
 */
export function nextReconnectAttempt(
  attempt: number,
  openMs: number | null,
): number {
  if (openMs !== null && openMs >= STABLE_CONNECTION_MS) return 0;
  return attempt + 1;
}

/**
 * Backoff delay for `attempt`, jittered so that several drawers (or several
 * phones) knocked off by one daemon restart do not come back in lockstep.
 */
export function reconnectDelayMs(
  attempt: number,
  jitter: number = Math.random(),
): number {
  const exponent = Math.min(Math.max(attempt, 0), RECONNECT_MAX_EXPONENT);
  const base = Math.min(RECONNECT_BASE_MS * 2 ** exponent, RECONNECT_MAX_MS);
  const spread = 1 - RECONNECT_JITTER / 2 + jitter * RECONNECT_JITTER;
  return Math.round(base * spread);
}
