import { describe, expect, it } from "vitest";
import {
  isPermanentClose,
  nextReconnectAttempt,
  reconnectDelayMs,
  STABLE_CONNECTION_MS,
  TERM_CLOSE_PERMANENT,
} from "../src/lib/terminal-reconnect.js";

describe("isPermanentClose", () => {
  it("retries everything except the daemon's explicit permanent code", () => {
    expect(isPermanentClose(TERM_CLOSE_PERMANENT)).toBe(true);
    for (const code of [1000, 1001, 1006, 1011, 1012, 4000, 4002]) {
      expect(isPermanentClose(code), `code ${code}`).toBe(false);
    }
  });
});

describe("nextReconnectAttempt", () => {
  it("resets the backoff after a connection that lasted", () => {
    expect(nextReconnectAttempt(6, STABLE_CONNECTION_MS)).toBe(0);
    expect(nextReconnectAttempt(6, 10 * 60_000)).toBe(0);
  });

  it("keeps backing off while closes come faster than a real session", () => {
    // The reconnect loop this exists for: open, closed within milliseconds,
    // over and over. Resetting on any successful open would pin it to the base
    // delay indefinitely.
    expect(nextReconnectAttempt(0, 30)).toBe(1);
    expect(nextReconnectAttempt(1, STABLE_CONNECTION_MS - 1)).toBe(2);
  });

  it("keeps backing off when the socket never opened at all", () => {
    expect(nextReconnectAttempt(2, null)).toBe(3);
  });
});

describe("reconnectDelayMs", () => {
  it("grows exponentially from 500ms and caps at 30s", () => {
    const mid = (attempt: number) => reconnectDelayMs(attempt, 0.5);
    expect(mid(0)).toBe(500);
    expect(mid(1)).toBe(1000);
    expect(mid(3)).toBe(4000);
    expect(mid(6)).toBe(30_000);
    expect(mid(50)).toBe(30_000);
  });

  it("jitters within ±25% and never returns a negative delay", () => {
    for (const attempt of [0, 1, 4, 9]) {
      const mid = reconnectDelayMs(attempt, 0.5);
      expect(reconnectDelayMs(attempt, 0)).toBe(Math.round(mid * 0.75));
      expect(reconnectDelayMs(attempt, 1)).toBe(Math.round(mid * 1.25));
      expect(reconnectDelayMs(attempt, 0)).toBeGreaterThan(0);
    }
  });

  it("treats a negative attempt as the first one", () => {
    expect(reconnectDelayMs(-3, 0.5)).toBe(500);
  });
});
