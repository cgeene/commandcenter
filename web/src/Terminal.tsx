import { useEffect, useRef } from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export function Terminal({ agentId }: { agentId: number }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;

    const term = new Xterm({
      fontSize: 12,
      fontFamily: "SF Mono, Menlo, monospace",
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

    ws.onmessage = (e) => term.write(typeof e.data === "string" ? e.data : "");
    ws.onclose = () => term.write("\r\n[disconnected]\r\n");

    const dataSub = term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: "i", d }));
      }
    });

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
    const onTouchStart = (e: TouchEvent) => {
      touchY = e.touches[0].clientY;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (touchY === null || ws.readyState !== WebSocket.OPEN) return;
      e.preventDefault(); // keep the page from rubber-banding
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
    const onTouchEnd = () => {
      touchY = null;
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
    };
  }, [agentId]);

  return <div className="terminal" ref={ref} />;
}
