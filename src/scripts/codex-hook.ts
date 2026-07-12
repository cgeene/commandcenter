#!/usr/bin/env node
/** Forward Codex lifecycle JSON to agentd while preserving each hook's output contract. */

interface Payload {
  hook_event_name?: string;
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

  // Stop requires JSON on stdout. PermissionRequest must not receive common
  // output fields, so an empty decision object lets the normal prompt proceed.
  process.stdout.write(
    payload.hook_event_name === "PermissionRequest"
      ? "{}\n"
      : '{"continue":true}\n',
  );
}

void main().catch(() => process.stdout.write('{"continue":true}\n'));
