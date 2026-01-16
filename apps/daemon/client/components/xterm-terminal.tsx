import "@xterm/xterm/css/xterm.css";
import { forwardRef, useEffect, useImperativeHandle, useRef, useMemo, useState } from "react";
import { useWebSocket } from "partysocket/react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { LigaturesAddon } from "@xterm/addon-ligatures";

interface XtermTerminalProps {
  wsBase?: string;
  tmuxSessionName?: string;
  agentSlug?: string;
}

export interface XtermTerminalHandle {
  sendText: (text: string) => void;
  focus: () => void;
}

const NO_RECONNECT_CODE = 4000;
const COMMAND_PREFIX = "\x00[command]\x00";
const MAX_RECONNECTION_ATTEMPTS = 20;

const READY_STATE_MAP = {
  [WebSocket.CONNECTING]: "connecting",
  [WebSocket.OPEN]: "connected",
  [WebSocket.CLOSING]: "disconnected",
  [WebSocket.CLOSED]: "disconnected",
} as Record<number, string>;

export const XtermTerminal = forwardRef<XtermTerminalHandle, XtermTerminalProps>(
  function XtermTerminal({ wsBase, tmuxSessionName, agentSlug }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const [termSize, setTermSize] = useState({ cols: 80, rows: 24 });

    const wsUrl = useMemo(() => {
      const baseUri = new URL(document.baseURI);
      const protocol = baseUri.protocol === "https:" ? "wss:" : "ws:";
      const base = wsBase || `${protocol}//${baseUri.host}${baseUri.pathname.replace(/\/$/, "")}`;
      const params = new URLSearchParams();
      if (agentSlug) params.set("agentSlug", agentSlug);
      if (tmuxSessionName) params.set("tmuxSession", tmuxSessionName);
      const queryString = params.toString();
      return `${base}/api/pty/ws${queryString ? `?${queryString}` : ""}`;
    }, [wsBase, tmuxSessionName, agentSlug]);

    const socket = useWebSocket(wsUrl, undefined, {
      maxRetries: MAX_RECONNECTION_ATTEMPTS,
      minReconnectionDelay: 1000,
      maxReconnectionDelay: 5000,
    });

    const connectionStatus = READY_STATE_MAP[socket.readyState] ?? "disconnected";

    useImperativeHandle(ref, () => ({
      sendText: (text: string) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(text);
        }
      },
      focus: () => {
        termRef.current?.focus();
      },
    }));

    useEffect(() => {
      if (!containerRef.current) return;

      const container = containerRef.current;

      const terminal = new Terminal({
        fontSize: 14,
        cursorBlink: true,
        fontFamily:
          '"JetBrainsMono Nerd Font", "JetBrains Mono", Monaco, Menlo, "Courier New", monospace',
        theme: {
          background: "#1e1e1e",
          foreground: "#d4d4d4",
          cursor: "#d4d4d4",
          cursorAccent: "#1e1e1e",
          selectionBackground: "#3a3a3a",
        },
        scrollback: 30000,
        allowProposedApi: true,
        allowTransparency: true,
      });

      termRef.current = terminal;

      const fitAddon = new FitAddon();
      fitAddonRef.current = fitAddon;
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(new UnicodeGraphemesAddon());
      terminal.loadAddon(new ClipboardAddon());

      terminal.open(container);
      // IMPORTANT: LigaturesAddon must be loaded after the terminal is opened
      terminal.loadAddon(new LigaturesAddon());

      try {
        const webglAddon = new WebglAddon({ customGlyphs: true });
        webglAddon.onContextLoss(() => webglAddon.dispose());
        terminal.loadAddon(webglAddon);
      } catch {
        // Intentionally empty - xterm falls back to canvas renderer
      }

      const sendControl = (msg: object) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(COMMAND_PREFIX + JSON.stringify(msg));
        }
      };

      const sendResize = () => {
        setTermSize({ cols: terminal.cols, rows: terminal.rows });
        sendControl({ type: "resize", cols: terminal.cols, rows: terminal.rows });
      };

      requestAnimationFrame(() => {
        fitAddon.fit();
        sendResize();
      });

      // For non-tmux connections (shell or agent), handle PageUp/PageDown for scrollback
      if (!tmuxSessionName) {
        terminal.attachCustomKeyEventHandler((event) => {
          if (event.shiftKey && (event.key === "PageUp" || event.key === "PageDown")) {
            return false;
          }
          return true;
        });
      }

      const handleOpen = () => {
        requestAnimationFrame(() => {
          fitAddon.fit();
          sendResize();
        });
        terminal.focus();
      };

      const handleMessage = (event: MessageEvent) => {
        terminal.write(event.data);
      };

      const handleClose = (event: CloseEvent) => {
        if (event.code === NO_RECONNECT_CODE) {
          socket.close();
          termRef.current?.writeln(`\r\n\x1b[31mSession closed by server\x1b[0m\r\n`);
        } else if (socket.retryCount >= MAX_RECONNECTION_ATTEMPTS) {
          termRef.current?.writeln(
            `\r\n\x1b[31mMaximum reconnection attempts reached, giving up.\x1b[0m\r\n`,
          );
          socket.close();
        } else {
          termRef.current?.writeln(
            `\r\n\x1b[31mConnection lost, trying to reconnect (attempt ${socket.retryCount})...\x1b[0m\r\n`,
          );
        }
      };

      socket.addEventListener("open", handleOpen);
      socket.addEventListener("message", handleMessage);
      socket.addEventListener("close", handleClose);

      const dataDisposable = terminal.onData((data: string) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(data);
        }
      });

      const resizeDisposable = terminal.onResize(() => sendResize());

      const handleSendCommand = (event: Event) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send((event as CustomEvent<string>).detail);
        }
      };
      window.addEventListener("terminal:send", handleSendCommand);

      const handleWindowResize = () => fitAddon.fit();
      window.addEventListener("resize", handleWindowResize);

      const resizeObserver = new ResizeObserver(() => {
        requestAnimationFrame(() => fitAddon.fit());
      });
      resizeObserver.observe(container);

      return () => {
        socket.removeEventListener("open", handleOpen);
        socket.removeEventListener("message", handleMessage);
        socket.removeEventListener("close", handleClose);
        dataDisposable.dispose();
        resizeDisposable.dispose();
        window.removeEventListener("terminal:send", handleSendCommand);
        window.removeEventListener("resize", handleWindowResize);
        resizeObserver.disconnect();
        terminal.dispose();
        termRef.current = null;
        container.innerHTML = "";
      };
    }, [socket, tmuxSessionName, agentSlug]);

    return (
      <div className="absolute inset-0 bg-[#1e1e1e]">
        <div className="absolute top-2 right-2 z-10 rounded bg-black/50 px-2 py-1 font-mono text-xs text-zinc-400">
          {termSize.cols}x{termSize.rows}
        </div>
        <div className="mx-auto h-full max-w-5xl">
          <div
            ref={containerRef}
            data-testid="terminal-container"
            data-connection-status={connectionStatus}
            data-tmux-session={tmuxSessionName}
            data-agent-slug={agentSlug}
            className="h-full w-full p-4"
            onClick={() => termRef.current?.focus()}
          />
        </div>
      </div>
    );
  },
);
