import { useEffect, useRef } from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { handleTerminalKeyEvent } from "../../src/lib/terminal-keys";

const BAR_KEYS: { label: string; seq: string }[] = [
  { label: "esc", seq: "\x1b" },
  { label: "tab", seq: "\t" },
  { label: "↑", seq: "\x1b[A" },
  { label: "↓", seq: "\x1b[B" },
  { label: "⏎", seq: "\r" },
  { label: "^C", seq: "\x03" },
];

/** A line that looks like a numbered menu option, e.g. "❯ 1. Yes" or "  2. No". */
const OPTION_RE = /^\s*(?:❯\s*)?(\d{1,2})[.)]\s+\S/;
/** The selection marker Claude Code menus render on the highlighted row. */
const MARKER_RE = /^\s*❯/;

export function Terminal({ agentId }: { agentId: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const send = (d: string) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "i", d }));
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
    fit.fit();

    // fit ran above, so cols/rows are the real dimensions — the server
    // starts the PTY at this size and the first paint is clean.
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(
      `${proto}//${location.host}/ws/term/${agentId}?cols=${term.cols}&rows=${term.rows}`,
    );
    wsRef.current = ws;

    ws.onmessage = (e) => term.write(typeof e.data === "string" ? e.data : "");
    ws.onclose = () => term.write("\r\n[disconnected]\r\n");

    const dataSub = term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: "i", d }));
      }
    });

    // Shift+Enter inserts a newline instead of submitting. handleTerminalKeyEvent
    // sends the newline sequence, calls preventDefault()/stopPropagation() so the
    // browser keypress can't make xterm ALSO emit "\r", and returns false. Every
    // other key (including plain Enter) returns true and is handled by xterm as
    // usual. See src/lib/terminal-keys.ts for why preventDefault is required.
    term.attachCustomKeyEventHandler((e) =>
      handleTerminalKeyEvent(e, (d) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ t: "i", d }));
        }
      }),
    );

    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: "r", cols: term.cols, rows: term.rows }));
      }
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
      if (touchY === null || ws.readyState !== WebSocket.OPEN) return;
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
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      resizeObserver.disconnect();
      dataSub.dispose();
      ws.close();
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
      </div>
      <div className="terminal" ref={ref} />
    </div>
  );
}
