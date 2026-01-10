import { useEffect, useRef, useState } from "react";

interface GhosttyTerminalProps {
  wsBase?: string;
}

type TerminalInstance = any;
type FitAddonInstance = any;

export function GhosttyTerminal({ wsBase }: GhosttyTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [connectionStatus, setConnectionStatus] = useState<
    "connecting" | "connected" | "disconnected"
  >("connecting");
  const termRef = useRef<TerminalInstance>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    let cancelled = false;
    let term: TerminalInstance;
    let fitAddon: FitAddonInstance;
    let ws: WebSocket;
    let reconnectTimeout: ReturnType<typeof setTimeout>;

    (async () => {
      const { init, Terminal, FitAddon } = await import("ghostty-web");
      if (cancelled) return;

      await init();
      if (cancelled) return;

      if (!containerRef.current) return;

      term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: 'Monaco, Menlo, "Courier New", monospace',
        theme: {
          background: "#1e1e1e",
          foreground: "#d4d4d4",
        },
        scrollback: 10000,
      });

      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(containerRef.current);
      fitAddon.fit();
      fitAddon.observeResize();

      termRef.current = term;

      function connectWebSocket() {
        if (cancelled) return;

        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const base = wsBase || `${protocol}//${window.location.host}`;
        const wsUrl = `${base}/ws/pty?cols=${term.cols}&rows=${term.rows}`;

        ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          if (cancelled) return;
          setConnectionStatus("connected");
          term.focus();
        };

        ws.onmessage = (event) => {
          if (cancelled) return;
          term.write(event.data);
        };

        ws.onerror = () => {
          if (cancelled) return;
          setConnectionStatus("disconnected");
        };

        ws.onclose = () => {
          if (cancelled) return;
          setConnectionStatus("disconnected");

          reconnectTimeout = setTimeout(() => {
            if (cancelled) return;
            if (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED) {
              setConnectionStatus("connecting");
              connectWebSocket();
            }
          }, 3000);
        };
      }

      term.onData((data: string) => {
        if (cancelled) return;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });

      term.onResize((size: { cols: number; rows: number }) => {
        if (cancelled) return;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "resize",
              cols: size.cols,
              rows: size.rows,
            }),
          );
        }
      });

      connectWebSocket();
    })();

    return () => {
      cancelled = true;
      clearTimeout(reconnectTimeout);
      wsRef.current?.close();
      if (termRef.current && typeof termRef.current.dispose === "function") {
        termRef.current.dispose();
      }
    };
  }, [wsBase]);

  const handleContainerClick = () => {
    termRef.current?.focus();
  };

  return (
    <div className="flex flex-col h-full bg-[#1e1e1e]">
      <div
        ref={containerRef}
        data-testid="terminal-container"
        data-connection-status={connectionStatus}
        className="relative flex-1 p-4 overflow-hidden"
        onClick={handleContainerClick}
      />
    </div>
  );
}
