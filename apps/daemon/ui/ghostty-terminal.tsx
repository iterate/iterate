import { useEffect, useRef, useState } from "react";

interface GhosttyTerminalProps {
  wsBase?: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type TerminalInstance = any;
type FitAddonInstance = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export function GhosttyTerminal({ wsBase }: GhosttyTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [connectionStatus, setConnectionStatus] = useState<"connecting" | "connected" | "disconnected">("connecting");
  const termRef = useRef<TerminalInstance>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    let term: TerminalInstance;
    let fitAddon: FitAddonInstance;
    let ws: WebSocket;
    let reconnectTimeout: ReturnType<typeof setTimeout>;

    (async () => {
      // Dynamic import for ghostty-web (FitAddon is exported from main module)
      const { init, Terminal, FitAddon } = await import("ghostty-web");

      // Initialize WASM
      await init();

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
      term.open(containerRef.current!);
      fitAddon.fit();
      fitAddon.observeResize();

      termRef.current = term;

      function connectWebSocket() {
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const base = wsBase || `${protocol}//${window.location.host}`;
        const wsUrl = `${base}/ws/pty?cols=${term.cols}&rows=${term.rows}`;

        ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          console.log("[GhosttyTerminal] WebSocket connected");
          setConnectionStatus("connected");
          term.focus();
        };

        ws.onmessage = (event) => {
          term.write(event.data);
        };

        ws.onerror = (error) => {
          console.error("[GhosttyTerminal] WebSocket error:", error);
          setConnectionStatus("disconnected");
        };

        ws.onclose = () => {
          console.log("[GhosttyTerminal] WebSocket disconnected");
          setConnectionStatus("disconnected");

          // Reconnect after 3 seconds
          reconnectTimeout = setTimeout(() => {
            if (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED) {
              setConnectionStatus("connecting");
              connectWebSocket();
            }
          }, 3000);
        };
      }

      // Handle user input
      term.onData((data: string) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });

      // Handle resize
      term.onResize((size: { cols: number; rows: number }) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "resize",
            cols: size.cols,
            rows: size.rows,
          }));
        }
      });

      connectWebSocket();
    })();

    return () => {
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
        className="flex-1 p-4 overflow-hidden"
        onClick={handleContainerClick}
      />
    </div>
  );
}
