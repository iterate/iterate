import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

interface GhosttyTerminalProps {
  wsBase?: string;
  tmuxSessionName?: string;
}

export interface GhosttyTerminalHandle {
  sendText: (text: string) => void;
  focus: () => void;
}

interface TerminalLike {
  cols: number;
  rows: number;
  focus: () => void;
  dispose: () => void;
  scrollLines: (amount: number) => void;
  attachCustomWheelEventHandler: (handler: (event: WheelEvent) => boolean) => void;
}

export const GhosttyTerminal = forwardRef<GhosttyTerminalHandle, GhosttyTerminalProps>(
  function GhosttyTerminal({ wsBase, tmuxSessionName }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [connectionStatus, setConnectionStatus] = useState<
      "connecting" | "connected" | "disconnected"
    >("connecting");
    const termRef = useRef<TerminalLike | null>(null);
    const wsRef = useRef<WebSocket | null>(null);

    useImperativeHandle(ref, () => ({
      sendText: (text: string) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(text);
        }
      },
      focus: () => {
        termRef.current?.focus();
      },
    }));

    useEffect(() => {
      if (!containerRef.current) return;

      let cancelled = false;
      let term: TerminalLike | undefined;
      let ws: WebSocket | undefined;
      let reconnectTimeout: ReturnType<typeof setTimeout> | undefined;

      (async () => {
        const { init, Terminal, FitAddon } = await import("ghostty-web");
        if (cancelled) return;

        await init();
        if (cancelled) return;

        if (!containerRef.current) return;

        const terminal = new Terminal({
          cursorBlink: true,
          fontSize: 14,
          fontFamily: 'Monaco, Menlo, "Courier New", monospace',
          theme: {
            background: "#1e1e1e",
            foreground: "#d4d4d4",
          },
          scrollback: 10000,
        });
        term = terminal;

        const fit = new FitAddon();
        terminal.loadAddon(fit);
        terminal.open(containerRef.current);
        fit.fit();
        fit.observeResize();

        // For tmux sessions: let tmux handle scrolling (tmux mouse mode will be enabled)
        // For plain shells: use local scrollback buffer via custom wheel handler
        if (!tmuxSessionName) {
          terminal.attachCustomWheelEventHandler((event: WheelEvent) => {
            const linesToScroll = Math.sign(event.deltaY) * Math.ceil(Math.abs(event.deltaY) / 50);
            terminal.scrollLines(linesToScroll);
            return true;
          });
        }

        termRef.current = term;

        function connectWebSocket() {
          if (cancelled) return;

          // Use document.baseURI to respect the <base> tag injected by the proxy
          // This ensures WebSocket URLs work when the app is served through a proxy path
          const baseUri = new URL(document.baseURI);
          const protocol = baseUri.protocol === "https:" ? "wss:" : "ws:";
          const base =
            wsBase || `${protocol}//${baseUri.host}${baseUri.pathname.replace(/\/$/, "")}`;

          const params = new URLSearchParams({
            cols: String(terminal.cols),
            rows: String(terminal.rows),
          });
          if (tmuxSessionName) {
            params.set("tmuxSession", tmuxSessionName);
          }

          const wsUrl = `${base}/api/pty/ws?${params.toString()}`;

          ws = new WebSocket(wsUrl);
          wsRef.current = ws;

          ws.onopen = () => {
            if (cancelled) return;
            setConnectionStatus("connected");
            terminal.focus();
          };

          ws.onmessage = (event) => {
            if (cancelled) return;
            terminal.write(event.data);
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

        terminal.onData((data: string) => {
          if (cancelled) return;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(data);
          }
        });

        terminal.onResize((size: { cols: number; rows: number }) => {
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
    }, [wsBase, tmuxSessionName]);

    useEffect(() => {
      const handleSendCommand = (event: CustomEvent<string>) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(event.detail);
        }
      };

      window.addEventListener("terminal:send", handleSendCommand as EventListener);
      return () => {
        window.removeEventListener("terminal:send", handleSendCommand as EventListener);
      };
    }, []);

    const handleContainerClick = () => {
      termRef.current?.focus();
    };

    return (
      <div className="flex flex-col h-full bg-[#1e1e1e]">
        <div
          ref={containerRef}
          data-testid="terminal-container"
          data-connection-status={connectionStatus}
          data-tmux-session={tmuxSessionName}
          className="relative flex-1 p-4 overflow-hidden"
          onClick={handleContainerClick}
        />
      </div>
    );
  },
);
