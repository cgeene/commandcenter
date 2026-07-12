#!/usr/bin/env node
/** Forward Codex lifecycle JSON to agentd while preserving each hook's output contract. */

import { codexPermissionDecision } from "../codex-policy.js";

interface Payload {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { command?: unknown; [key: string]: unknown };
  [key: string]: unknown;
}

async function readStdin(): Promise<string> {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

function safeAgentId(): string | undefined {
  const value = process.env.CC_AGENT_ID;
  return value && /^\d+$/.test(value) ? value : undefined;
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let payload: Payload = {};
  try {
    payload = JSON.parse(raw) as Payload;
  } catch {
    // Forward an empty object; malformed hook input must not break Codex.
  }

  const agentId = safeAgentId();
  const base = process.env.CC_URL ?? "http://127.0.0.1:4711";
  const decision = codexPermissionDecision(payload, process.env.CC_TASK_ID);
  if (agentId) {
    try {
      await fetch(`${base}/api/hooks/agent/${agentId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // A daemon outage must not block or alter the worker turn.
    }
  }

  if (payload.hook_event_name === "PermissionRequest") {
    // An empty object declines to decide and leaves the normal prompt intact.
    process.stdout.write(
      decision
        ? `${JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PermissionRequest",
              decision,
            },
          })}\n`
        : "{}\n",
    );
    return;
  }
  if (payload.hook_event_name === "PreToolUse") {
    // Deny forbidden publishing commands before execution even if Codex has
    // remembered an approval. The exact own-branch push stays neutral here
    // and is allowed later by PermissionRequest, preserving the sandbox gate.
    process.stdout.write(
      decision?.behavior === "deny"
        ? `${JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: decision.message,
            },
          })}\n`
        : "{}\n",
    );
    return;
  }
  process.stdout.write('{"continue":true}\n');
}

// `{}` is valid neutral output for every configured event, including
// PermissionRequest (whose contract rejects common `continue` fields).
void main().catch(() => process.stdout.write("{}\n"));
