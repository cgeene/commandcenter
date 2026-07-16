import { resolveNtfyToken, resolveNtfyUrl } from "../db/settings.js";

/**
 * Fire-and-forget push via ntfy (https://docs.ntfy.sh). No-op unless an ntfy
 * URL is configured (Settings tab overrides CC_NTFY_URL). Failures are
 * swallowed — push is best-effort and must never affect platform state.
 */
export function notify(
  title: string,
  message: string,
  opts?: { priority?: "high" | "default" | "low"; tags?: string },
): void {
  const url = resolveNtfyUrl();
  if (!url) return;
  const headers: Record<string, string> = {
    Title: title,
    Priority: opts?.priority ?? "default",
  };
  if (opts?.tags) headers.Tags = opts.tags;
  const token = resolveNtfyToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  fetch(url, { method: "POST", body: message, headers }).catch(() => {});
}
