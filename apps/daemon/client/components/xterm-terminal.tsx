import "@xterm/xterm/css/xterm.css";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useMemo,
  useState,
  useCallback,
} from "react";
import { useWebSocket } from "partysocket/react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { LigaturesAddon } from "@xterm/addon-ligatures";
import { useIsMobile } from "@/hooks/use-mobile.ts";
import { MobileKeyboardToolbar } from "@/components/mobile-keyboard-toolbar.tsx";

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
    const [ctrlActive, setCtrlActive] = useState(false);
    const [altActive, setAltActive] = useState(false);
    const isMobile = useIsMobile();

    // Refs so the custom key handler (set up once) can read current modifier state
    const ctrlActiveRef = useRef(false);
    const altActiveRef = useRef(false);
    useEffect(() => {
      ctrlActiveRef.current = ctrlActive;
    }, [ctrlActive]);
    useEffect(() => {
      altActiveRef.current = altActive;
    }, [altActive]);

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

    // Handle key presses from the mobile toolbar and snippets panel
    const handleToolbarKeyPress = useCallback(
      (key: string) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(key);
        }
        // Reset modifiers after any key press
        setCtrlActive(false);
        setAltActive(false);
      },
      [socket],
    );

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

      // Suppress autocorrect/predictive text on xterm's internal textarea
      // and hide the native blinking caret (terminal renders its own cursor)
      const helperTextarea = container.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
      if (helperTextarea) {
        helperTextarea.setAttribute("autocorrect", "off");
        helperTextarea.setAttribute("autocomplete", "off");
        helperTextarea.setAttribute("autocapitalize", "none");
        helperTextarea.setAttribute("spellcheck", "false");
        helperTextarea.style.caretColor = "transparent";
      }

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
        sendControl({ type: "resize", cols, rows });
      };

      requestAnimationFrame(() => {
        fitAddon.fit();
        sendResize();
      });

      // Intercept keyboard events to apply Ctrl/Alt modifier toggles from the toolbar
      terminal.attachCustomKeyEventHandler((event) => {
        if (event.shiftKey && (event.key === "PageUp" || event.key === "PageDown")) {
          return false;
        }

        // Only process keydown events for modifier interception
        if (event.type !== "keydown") return true;

        // Ctrl modifier: convert letter keys to control characters
        if (ctrlActiveRef.current && event.key.length === 1 && /[a-zA-Z]/.test(event.key)) {
          const code = event.key.toLowerCase().charCodeAt(0) - 96; // a=1, b=2, c=3 ...
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(String.fromCharCode(code));
          }
          setCtrlActive(false);
          return false;
        }

        // Alt modifier: prefix with ESC (standard terminal Alt encoding)
        if (altActiveRef.current && event.key.length === 1) {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send("\x1b" + event.key);
          }
          setAltActive(false);
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
      <div className="flex h-full w-full flex-col bg-[#1e1e1e]">
        {/* Mobile toolbar at top */}
        {isMobile && (
          <div className="shrink-0">
            <MobileKeyboardToolbar
              onKeyPress={handleToolbarKeyPress}
              ctrlActive={ctrlActive}
              altActive={altActive}
              onCtrlToggle={() => setCtrlActive((prev) => !prev)}
              onAltToggle={() => setAltActive((prev) => !prev)}
            />
          </div>
        )}

        {/* Terminal fills remaining space */}
        <div className="relative min-h-0 flex-1">
          <div
            ref={containerRef}
            data-testid="terminal-container"
            data-connection-status={connectionStatus}
            className="absolute inset-0"
            onClick={() => termRef.current?.focus()}
            onTouchStart={() => termRef.current?.focus()}
          />
        </div>
      </div>
    );
  },
);
