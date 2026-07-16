export const AGENT_PROVIDERS = ["claude", "codex"] as const;

export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

export function isAgentProvider(value: unknown): value is AgentProvider {
  return typeof value === "string" && AGENT_PROVIDERS.includes(value as AgentProvider);
}

export function parseAgentProvider(
  value: unknown,
  fallback: AgentProvider = "claude",
): AgentProvider {
  if (value === undefined || value === null || value === "") return fallback;
  if (!isAgentProvider(value)) {
    throw new Error(`invalid agent provider: ${String(value)}`);
  }
  return value;
}
