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
  initialCommand?: {
    command?: string;
    autorun?: boolean;
  };
  ptyId?: string;
  onParamsChange?: (params: { ptyId?: string; clearCommand?: boolean }) => void;
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
  function XtermTerminal({ wsBase, initialCommand, ptyId, onParamsChange }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const [termSize, setTermSize] = useState({ cols: 80, rows: 24 });

    const wsUrl = useMemo(() => {
      const baseUri = new URL(document.baseURI);
      const protocol = baseUri.protocol === "https:" ? "wss:" : "ws:";
      const base = wsBase || `${protocol}//${baseUri.host}${baseUri.pathname.replace(/\/$/, "")}`;
      const params = new URLSearchParams();
      if (ptyId) params.set("ptyId", ptyId);
      if (initialCommand?.command && !ptyId) {
        params.set("command", initialCommand.command);
        if (initialCommand.autorun) params.set("autorun", "true");
      }
      const query = params.toString();
      return `${base}/api/pty/ws${query ? `?${query}` : ""}`;
    }, [wsBase, ptyId, initialCommand]);

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
        const { cols, rows } = terminal;
        setTermSize({ cols, rows });
        sendControl({ type: "resize", cols, rows });
      };

      requestAnimationFrame(() => {
        fitAddon.fit();
        sendResize();
      });

      terminal.attachCustomKeyEventHandler((event) => {
        if (event.shiftKey && (event.key === "PageUp" || event.key === "PageDown")) {
          return false;
        }
        return true;
      });

      const handleOpen = () => {
        terminal.reset();
        requestAnimationFrame(() => {
          fitAddon.fit();
          sendResize();
        });
        terminal.focus();
      };

      const handleMessage = (event: MessageEvent) => {
        const data = typeof event.data === "string" ? event.data : "";
        if (data.startsWith(COMMAND_PREFIX)) {
          const parsed = JSON.parse(data.slice(COMMAND_PREFIX.length)) as {
            type?: string;
            ptyId?: string;
            data?: string;
          };
          if (parsed.type === "ptyId" && parsed.ptyId) {
            onParamsChange?.({ ptyId: parsed.ptyId });
          } else if (parsed.type === "buffer" && parsed.data) {
            terminal.reset();
            terminal.write(parsed.data);
          } else if (parsed.type === "commandExecuted") {
            onParamsChange?.({ clearCommand: true });
          }
          return;
        }
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
        requestAnimationFrame(() => {
          if (termRef.current) {
            fitAddon.fit();
          }
        });
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
    }, [socket, onParamsChange]);

    return (
      <div className="absolute inset-0 bg-[#1e1e1e] p-4">
        <div className="absolute top-6 right-6 z-10 rounded bg-black/50 px-2 py-1 font-mono text-xs text-zinc-400">
          {termSize.cols}x{termSize.rows}
        </div>
        <div className="relative h-full w-full overflow-hidden">
          <div
            ref={containerRef}
            data-testid="terminal-container"
            data-connection-status={connectionStatus}
            className="absolute inset-0"
            onClick={() => termRef.current?.focus()}
          />
        </div>
      </div>
    );
  },
);
