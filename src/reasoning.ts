import type { AgentProvider } from "./providers.js";

export const REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const DEFAULT_CODEX_REASONING_EFFORT: ReasoningEffort = "high";

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return REASONING_EFFORTS.includes(value as ReasoningEffort);
}

/** Persist an explicit Codex effort while keeping Claude rows provider-clean. */
export function reasoningEffortForProvider(
  provider: AgentProvider,
  value?: ReasoningEffort | null,
): ReasoningEffort | null {
  if (provider === "claude") {
    if (value !== undefined && value !== null) {
      throw new Error("reasoning effort is only supported for Codex workers");
    }
    return null;
  }
  if (value !== undefined && value !== null && !isReasoningEffort(value)) {
    throw new Error(`invalid reasoning effort: ${String(value)}`);
  }
  return value ?? DEFAULT_CODEX_REASONING_EFFORT;
}
