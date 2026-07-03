import { baseUrl } from "../config.js";

export async function api<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    console.error(
      `error: cannot reach agentd at ${baseUrl()} — is it running? (npm run dev:daemon, or \`agentd\`)`,
    );
    process.exit(1);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    console.error(`error: ${data.error ?? `${res.status} ${res.statusText}`}`);
    process.exit(1);
  }
  return data;
}
