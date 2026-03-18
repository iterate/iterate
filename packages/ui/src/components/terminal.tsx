import "@xterm/xterm/css/xterm.css";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useWebSocket } from "partysocket/react";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { LigaturesAddon } from "@xterm/addon-ligatures";
import { SearchAddon } from "@xterm/addon-search";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as XTerm } from "@xterm/xterm";
import { useIsMobile } from "../hooks/use-mobile.ts";
import { MobileKeyboardToolbar } from "./mobile-keyboard-toolbar.tsx";

export interface TerminalProps {
  wsBase?: string;
  initialCommand?: {
    command?: string;
    autorun?: boolean;
  };
  ptyId?: string;
  onParamsChange?: (params: { ptyId?: string; clearCommand?: boolean }) => void;
}

export interface TerminalHandle {
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

export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal(
  { wsBase, initialCommand, ptyId, onParamsChange },
  ref,
) {
  const containerRef = useRef<HTMLButtonElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const [ctrlActive, setCtrlActive] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const isMobile = useIsMobile();
  const isMobileRef = useRef(isMobile);

  useEffect(() => {
    isMobileRef.current = isMobile;
  }, [isMobile]);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const keyboardThreshold = 100;
    const update = () => {
      setKeyboardVisible(window.innerHeight - viewport.height > keyboardThreshold);
    };

    viewport.addEventListener("resize", update);
    update();

    return () => viewport.removeEventListener("resize", update);
  }, []);

  const ctrlActiveRef = useRef(false);
  useEffect(() => {
    ctrlActiveRef.current = ctrlActive;
  }, [ctrlActive]);

  const wsUrl = useMemo(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const base = wsBase || `${protocol}//${window.location.host}`;
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

  const handleToolbarKeyPress = useCallback(
    (key: string) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(key);
      }
      setCtrlActive(false);
      terminalRef.current?.focus();
      const textarea = containerRef.current?.querySelector<HTMLElement>(".xterm-helper-textarea");
      textarea?.focus();
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
      terminalRef.current?.focus();
    },
  }));

  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;
    const terminal = new XTerm({
      fontSize: isMobileRef.current ? 10 : 14,
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

    terminalRef.current = terminal;

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new UnicodeGraphemesAddon());
    terminal.loadAddon(new ClipboardAddon());

    const searchAddon = new SearchAddon();
    terminal.loadAddon(searchAddon);
    searchAddonRef.current = searchAddon;

    terminal.open(container);

    const helperTextarea = container.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    if (helperTextarea) {
      helperTextarea.setAttribute("autocorrect", "off");
      helperTextarea.setAttribute("autocomplete", "off");
      helperTextarea.setAttribute("autocapitalize", "none");
      helperTextarea.setAttribute("spellcheck", "false");
      helperTextarea.style.caretColor = "transparent";
    }

    terminal.loadAddon(new LigaturesAddon());

    try {
      const webglAddon = new WebglAddon({ customGlyphs: true });
      webglAddon.onContextLoss(() => webglAddon.dispose());
      terminal.loadAddon(webglAddon);
    } catch {
      // xterm falls back to canvas rendering automatically.
    }

    const sendControl = (message: object) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(COMMAND_PREFIX + JSON.stringify(message));
      }
    };

    const sendResize = () => {
      sendControl({ type: "resize", cols: terminal.cols, rows: terminal.rows });
    };

    requestAnimationFrame(() => {
      fitAddon.fit();
      sendResize();
      terminal.focus();
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
      if (isMobileRef.current && helperTextarea) {
        setTimeout(() => helperTextarea.focus(), 100);
      }
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
        terminal.writeln("\r\n\x1b[31mSession closed by server\x1b[0m\r\n");
      } else if (socket.retryCount >= MAX_RECONNECTION_ATTEMPTS) {
        terminal.writeln(
          "\r\n\x1b[31mMaximum reconnection attempts reached, giving up.\x1b[0m\r\n",
        );
        socket.close();
      } else {
        terminal.writeln(
          `\r\n\x1b[31mConnection lost, trying to reconnect (attempt ${socket.retryCount})...\x1b[0m\r\n`,
        );
      }
    };

    socket.addEventListener("open", handleOpen);
    socket.addEventListener("message", handleMessage);
    socket.addEventListener("close", handleClose);

    const dataDisposable = terminal.onData((data: string) => {
      if (socket.readyState !== WebSocket.OPEN) return;

      if (ctrlActiveRef.current && data.length === 1) {
        setCtrlActive(false);
        if (/[a-zA-Z]/.test(data)) {
          const code = data.toLowerCase().charCodeAt(0) - 96;
          socket.send(String.fromCharCode(code));
          return;
        }
      }

      socket.send(data);
    });

    const resizeDisposable = terminal.onResize(() => sendResize());

    const handleWindowResize = () => fitAddon.fit();
    window.addEventListener("resize", handleWindowResize);

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        fitAddon.fit();
      });
    });
    resizeObserver.observe(container);

    return () => {
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("message", handleMessage);
      socket.removeEventListener("close", handleClose);
      dataDisposable.dispose();
      resizeDisposable.dispose();
      window.removeEventListener("resize", handleWindowResize);
      resizeObserver.disconnect();
      terminal.dispose();
      terminalRef.current = null;
      container.innerHTML = "";
    };
  }, [socket, onParamsChange]);

  return (
    <div className="flex h-full w-full flex-col bg-[#1e1e1e]">
      {isMobile && (
        <div className="shrink-0">
          <MobileKeyboardToolbar
            onKeyPress={handleToolbarKeyPress}
            ctrlActive={ctrlActive}
            onCtrlToggle={() => {
              setCtrlActive((previous) => !previous);
              terminalRef.current?.focus();
            }}
            keyboardVisible={keyboardVisible}
            onToggleKeyboard={() => {
              const textarea =
                containerRef.current?.querySelector<HTMLElement>(".xterm-helper-textarea");
              if (keyboardVisible) {
                textarea?.blur();
              } else {
                textarea?.focus();
              }
            }}
            onSearch={(query) => {
              searchAddonRef.current?.findNext(query);
            }}
            onSearchNext={(query) => {
              searchAddonRef.current?.findNext(query);
            }}
            onSearchPrev={(query) => {
              searchAddonRef.current?.findPrevious(query);
            }}
            onSearchClose={() => {
              searchAddonRef.current?.clearDecorations();
            }}
          />
        </div>
      )}

      <div className="relative min-h-0 flex-1 p-2">
        <button
          type="button"
          ref={containerRef}
          data-testid="terminal-container"
          data-connection-status={connectionStatus}
          className="absolute inset-2 border-0 bg-transparent p-0"
          onClick={() => terminalRef.current?.focus()}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            terminalRef.current?.focus();
          }}
          onTouchStart={() => {
            terminalRef.current?.focus();
            const textarea =
              containerRef.current?.querySelector<HTMLElement>(".xterm-helper-textarea");
            textarea?.focus();
          }}
        />
      </div>
    </div>
  );
});
