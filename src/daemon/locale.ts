/**
 * A UTF-8 locale to hand to tmux and the PTYs the daemon spawns.
 *
 * tmux downgrades every non-ASCII glyph to `_` when the attaching client's
 * locale isn't UTF-8 — it decides the client can't display it. The daemon
 * typically runs under launchd/systemd with a near-empty environment (no
 * LANG/LC_*), so each tmux client and PTY it spawns inherits a C locale and
 * mangles ⏺ ❯ ✻ and friends into underscores in the web terminal.
 *
 * `localeEnv()` returns a copy of an environment with a UTF-8 locale forced
 * in when the environment doesn't already resolve to one. We do this in code
 * rather than relying on the launchd plist so the fix also holds for anyone
 * running the daemon some other way (systemd, foreground, etc.). The tmux
 * client is additionally invoked with `-u`, which forces UTF-8 regardless of
 * whether this locale name happens to exist on the host.
 */
const UTF8_LOCALE = "en_US.UTF-8";

function isUtf8(value?: string): boolean {
  return !!value && /utf-?8/i.test(value);
}

/**
 * Copy `base` and ensure the character-type category resolves to UTF-8.
 *
 * tmux consults the ctype category, whose precedence is LC_ALL > LC_CTYPE >
 * LANG. When that already names a UTF-8 locale we leave the environment
 * untouched (so a user's de_DE.UTF-8 etc. is preserved). Otherwise we drop a
 * non-UTF-8 LC_ALL (it would override LC_CTYPE) and pin LC_CTYPE + LANG.
 */
export function localeEnv(
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined) env[k] = v;
  }

  const effective = env.LC_ALL ?? env.LC_CTYPE ?? env.LANG;
  if (!isUtf8(effective)) {
    delete env.LC_ALL;
    env.LC_CTYPE = UTF8_LOCALE;
    if (!isUtf8(env.LANG)) env.LANG = UTF8_LOCALE;
  }
  return env;
}
