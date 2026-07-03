import { ntfyToken, ntfyUrl } from "../config.js";

/**
 * Fire-and-forget push via ntfy (https://docs.ntfy.sh). No-op unless
 * CC_NTFY_URL is set. Failures are swallowed — push is best-effort and must
 * never affect platform state.
 */
export function notify(
  title: string,
  message: string,
  opts?: { priority?: "high" | "default" | "low"; tags?: string },
): void {
  const url = ntfyUrl();
  if (!url) return;
  const headers: Record<string, string> = {
    Title: title,
    Priority: opts?.priority ?? "default",
  };
  if (opts?.tags) headers.Tags = opts.tags;
  const token = ntfyToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  fetch(url, { method: "POST", body: message, headers }).catch(() => {});
}
