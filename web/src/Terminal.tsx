import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { handleTerminalKeyEvent } from "../../src/lib/terminal-keys";
import {
  composeBarEnabled,
  composePayload,
  isTouchLike,
  setComposeBarEnabled,
} from "../../src/lib/terminal-compose";

const BAR_KEYS: { label: string; seq: string }[] = [
  { label: "esc", seq: "\x1b" },
  { label: "tab", seq: "\t" },
  { label: "↑", seq: "\x1b[A" },
  { label: "↓", seq: "\x1b[B" },
  { label: "⏎", seq: "\r" },
  { label: "^C", seq: "\x03" },
];

/** Tallest the compose field grows before it scrolls internally — roughly three
 *  lines at the 16px font below, which is as much as can sit above a phone
 *  keyboard without eating the terminal. */
const COMPOSE_MAX_HEIGHT_PX = 84;

/** True when the browser reports a virtual keyboard (phone/tablet), which is
 *  the only place the compose bar shows up unless it's been toggled on.
 *  A browser that doesn't know the pointer feature serializes the query as
 *  "not all" — that, and only that, falls back to counting touch points. */
function touchDevice(): boolean {
  const query = window.matchMedia?.("(pointer: coarse)");
  const supported = !!query && query.media !== "not all";
  return isTouchLike(supported ? query.matches : null, navigator.maxTouchPoints ?? 0);
}

/** A line that looks like a numbered menu option, e.g. "❯ 1. Yes" or "  2. No". */
const OPTION_RE = /^\s*(?:❯\s*)?(\d{1,2})[.)]\s+\S/;
/** The selection marker Claude Code menus render on the highlighted row. */
const MARKER_RE = /^\s*❯/;

/**
 * A native text field docked under the terminal, for phones.
 *
 * Everything typed here goes through the browser's ordinary text input — so
 * autocorrect, double-space-for-a-period, predictive text and dictation all
 * work, none of which survive xterm's hidden textarea (see
 * src/lib/terminal-compose.ts). The finished buffer reaches the pty as a single
 * write when the operator sends it.
 */
function ComposeBar({
  send,
  connected,
}: {
  /** Writes to the pty. Returns false if the socket wasn't open, i.e. nothing
   *  was written — the buffer must survive that. */
  send: (data: string) => boolean;
  connected: boolean;
}) {
  const [text, setText] = useState("");
  // Whether a send also presses Enter. On by default (the common case: say
  // something to a worker and submit it); off for typing into a prompt you
  // don't want to answer yet, e.g. filling a worker's composer.
  const [submitOnSend, setSubmitOnSend] = useState(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Grow with the content up to ~3 lines, then scroll. scrollHeight is the
  // CONTENT height, but box-sizing is border-box app-wide, so the border has to
  // be added back — otherwise even a single line sits 2px short and scrolls
  // from the first character.
  const autosize = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const border = el.offsetHeight - el.clientHeight; // measured while unset
    el.style.height = `${Math.min(el.scrollHeight + border, COMPOSE_MAX_HEIGHT_PX)}px`;
  }, []);

  useLayoutEffect(autosize, [text, autosize]);

  // A width change reflows wrapped text to a different number of lines, so the
  // height has to be recomputed on rotation and whenever the drawer resizes
  // (which it does when the virtual keyboard opens). Only width is acted on:
  // reacting to our own height writes would loop.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    // Seeded from the observer's own first delivery (which costs one harmless
    // re-measure) so it's compared against the same box every time — clientWidth
    // would include padding that contentRect.width doesn't.
    let lastWidth = -1;
    const ro = new ResizeObserver((entries) => {
      const width = entries[0].contentRect.width;
      if (width === lastWidth) return;
      lastWidth = width;
      autosize();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [autosize]);

  const payload = composePayload(text, submitOnSend);
  const sendable = payload !== null && connected;

  /** Clear the field ONLY once the bytes are actually on the wire. The socket
   *  can be reconnecting after a phone locks, a tab sleeps, or the daemon
   *  restarts, so clearing on a failed write would destroy a message the
   *  operator just spent a minute dictating, with "sent" looking identical to
   *  "dropped". */
  const flush = () => {
    if (payload === null || !send(payload)) return;
    setText("");
    inputRef.current?.focus(); // keep the virtual keyboard up for the next line
  };

  /** Buttons must not steal focus from the field, or the keyboard drops and
   *  (on iOS) the page scrolls back. Same trick as the key bar above. */
  const keepFocus = (e: { preventDefault: () => void }) => e.preventDefault();

  return (
    <div className={`compose${connected ? "" : " offline"}`}>
      <textarea
        ref={inputRef}
        className="compose-input"
        aria-label="Compose message"
        rows={1}
        value={text}
        placeholder={
          connected ? (submitOnSend ? "Message…" : "Message… (⏎ = newline)") : "Disconnected"
        }
        // Deliberately NOT disabling any of these: they are the whole point of
        // the compose bar. autoCorrect/autoCapitalize are non-standard but are
        // what iOS Safari reads.
        autoCorrect="on"
        autoCapitalize="sentences"
        spellCheck
        enterKeyHint={submitOnSend ? "send" : "enter"}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Mid-composition Enter belongs to the IME/autocorrect candidate,
          // never to us.
          if (e.nativeEvent.isComposing) return;
          // With the ⏎ toggle OFF, Enter inserts a literal newline and only the
          // Send button ships the buffer. That's the only way to type a newline
          // on a phone, whose keyboard can't produce Shift+Enter — and it makes
          // enterKeyHint="enter" tell the truth.
          if (e.key === "Enter" && !e.shiftKey && submitOnSend) {
            e.preventDefault();
            flush();
          }
        }}
      />
      <button
        className={`compose-newline${submitOnSend ? " on" : ""}`}
        aria-pressed={submitOnSend}
        title={submitOnSend ? "Enter sends and submits" : "Enter inserts a newline; Send sends"}
        onMouseDown={keepFocus}
        onClick={() => setSubmitOnSend((v) => !v)}
      >
        ⏎
      </button>
      <button
        className="primary"
        disabled={!sendable}
        title={connected ? undefined : "Terminal disconnected — reconnecting"}
        onMouseDown={keepFocus}
        onClick={flush}
      >
        Send
      </button>
    </div>
  );
}

export function Terminal({ agentId }: { agentId: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // Compose bar on by default on touch devices only; an explicit toggle is
  // remembered per browser.
  const [compose, setCompose] = useState(() => composeBarEnabled(localStorage, touchDevice()));
  // Whether the pty socket is up. The socket can disappear underneath a still
  // mounted drawer when the tab sleeps, Vite reloads, or the daemon restarts;
  // keep reconnecting instead of making the operator refresh the whole page.
  const [connected, setConnected] = useState(false);

  /** Write to the pty. Returns whether the bytes actually went out. */
  const send = (d: string): boolean => {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ t: "i", d }));
    return true;
  };

  useEffect(() => {
    if (!ref.current) return;

    const term = new Xterm({
      fontSize: 12,
      // Multiple monospace fallbacks so glyphs like ⏺ ❯ ✻ resolve to a font
      // that carries them even if the first choice doesn't. (The primary
      // unicode fix is server-side — see src/daemon/locale.ts.)
      fontFamily: "'SF Mono', Menlo, Monaco, 'Courier New', monospace",
      theme: { background: "#0d1117", foreground: "#c9d1d9" },
      cursorBlink: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current);
    const fitTerminal = () => {
      try {
        fit.fit();
      } catch {
        // During drawer open/keyboard resize the element can briefly report
        // unusable dimensions. The ResizeObserver below will retry.
      }
    };
    fitTerminal();

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    let disposed = false;
    let reconnectTimer: number | null = null;

    const sendResize = () => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: "r", cols: term.cols, rows: term.rows }));
      }
    };

    const connect = (attempt = 0) => {
      if (disposed) return;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const ws = new WebSocket(
        `${proto}//${location.host}/ws/term/${agentId}?cols=${term.cols}&rows=${term.rows}`,
      );
      wsRef.current = ws;
      setConnected(false);

      ws.onmessage = (e) => term.write(typeof e.data === "string" ? e.data : "");
      ws.onopen = () => {
        if (disposed) return;
        setConnected(true);
        sendResize();
      };
      ws.onerror = () => {
        // The close event schedules the retry; this handler only prevents an
        // unobserved websocket error from surfacing in the console.
      };
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        if (disposed) return;
        setConnected(false);
        term.write("\r\n[disconnected; reconnecting]\r\n");
        const delay = Math.min(4000, 500 * 2 ** Math.min(attempt, 3));
        reconnectTimer = window.setTimeout(() => connect(attempt + 1), delay);
      };
    };

    connect();

    const dataSub = term.onData((d) => {
      send(d);
    });

    // Shift+Enter inserts a newline instead of submitting. handleTerminalKeyEvent
    // sends the newline sequence, calls preventDefault()/stopPropagation() so the
    // browser keypress can't make xterm ALSO emit "\r", and returns false. Every
    // other key (including plain Enter) returns true and is handled by xterm as
    // usual. See src/lib/terminal-keys.ts for why preventDefault is required.
    term.attachCustomKeyEventHandler((e) =>
      handleTerminalKeyEvent(e, (d) => {
        send(d);
      }),
    );

    const resizeObserver = new ResizeObserver(() => {
      fitTerminal();
      sendResize();
    });
    resizeObserver.observe(ref.current);

    // Touch scrolling: tmux owns the scrollback (copy-mode), so translate
    // vertical drags into SGR mouse-wheel sequences — the viewer session has
    // mouse mode on. Drag down = older content = wheel up (button 64).
    const el = ref.current;
    let touchY: number | null = null;
    let touchStartY = 0;
    let moved = false;

    const onTouchStart = (e: TouchEvent) => {
      touchY = e.touches[0].clientY;
      touchStartY = touchY;
      moved = false;
    };
    const onTouchMove = (e: TouchEvent) => {
      const ws = wsRef.current;
      if (touchY === null || ws?.readyState !== WebSocket.OPEN) return;
      e.preventDefault(); // keep the page from rubber-banding
      if (Math.abs(e.touches[0].clientY - touchStartY) > 10) moved = true;
      const lineHeight = el.clientHeight / term.rows;
      const dy = e.touches[0].clientY - touchY;
      const lines = Math.trunc(dy / lineHeight);
      if (lines === 0) return;
      touchY += lines * lineHeight;
      const button = lines > 0 ? 64 : 65;
      const cell = `${Math.max(1, Math.floor(term.cols / 2))};${Math.max(1, Math.floor(term.rows / 2))}`;
      ws.send(
        JSON.stringify({
          t: "i",
          d: `\x1b[<${button};${cell}M`.repeat(Math.min(Math.abs(lines), 10)),
        }),
      );
    };
    const onTouchEnd = (e: TouchEvent) => {
      // a still touch is a tap — if it landed on a menu option, select it
      if (!moved && touchY !== null) handleTap(e.changedTouches[0].clientY);
      touchY = null;
    };

    /** Tap-to-select: if the tapped row is a numbered option AND a ❯ menu
     *  marker is visible nearby, send the option's number (Claude Code
     *  menus select directly on digit press). The marker guard stops taps
     *  on ordinary numbered lists in output from typing stray digits. */
    const handleTap = (clientY: number) => {
      const rect = el.getBoundingClientRect();
      const lineHeight = rect.height / term.rows;
      const viewportRow = Math.floor((clientY - rect.top) / lineHeight);
      if (viewportRow < 0 || viewportRow >= term.rows) return;
      const buf = term.buffer.active;
      const bufRow = buf.viewportY + viewportRow;
      const line = buf.getLine(bufRow)?.translateToString(true) ?? "";
      const match = OPTION_RE.exec(line);
      if (!match) return;
      let menuNearby = false;
      for (let r = bufRow - 6; r <= bufRow + 6; r++) {
        const l = buf.getLine(r)?.translateToString(true);
        if (l && MARKER_RE.test(l)) {
          menuNearby = true;
          break;
        }
      }
      if (menuNearby) send(match[1]);
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });

    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      resizeObserver.disconnect();
      dataSub.dispose();
      wsRef.current?.close();
      term.dispose();
      wsRef.current = null;
    };
  }, [agentId]);

  return (
    <div className="terminal-wrap">
      <div className="termbar">
        {BAR_KEYS.map((k) => (
          <button
            key={k.label}
            onMouseDown={(e) => e.preventDefault()} // don't steal terminal focus
            onClick={() => send(k.seq)}
          >
            {k.label}
          </button>
        ))}
        <div className="spacer" />
        {/* The key bar stays put in compose mode: single keys (menu digits,
            ^C, arrows) still need to go through raw, as does tapping the
            terminal itself. */}
        <button
          className={`compose-toggle${compose ? " on" : ""}`}
          aria-label="Toggle compose bar"
          aria-pressed={compose}
          title={compose ? "Hide compose bar" : "Show compose bar"}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const next = !compose;
            setComposeBarEnabled(localStorage, next);
            setCompose(next);
          }}
        >
          abc
        </button>
      </div>
      <div className="terminal" ref={ref} />
      {/* The key is load-bearing. Switching to another agent's terminal keeps
          this component mounted at the same tree position (openPanel swaps
          agentId in place, deliberately, so the effect above tears the old
          websocket down) — without a key React would reuse the ComposeBar and
          an unsent draft for agent A would be sent into agent B's pty. */}
      {compose && <ComposeBar key={agentId} send={send} connected={connected} />}
    </div>
  );
}
