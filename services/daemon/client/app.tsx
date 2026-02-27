import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

const COMMAND_PREFIX = "\x00[command]\x00";
const MAX_RECONNECTION_ATTEMPTS = 20;

type ConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected";

type ControlMessage =
  | { type: "ptyId"; ptyId: string }
  | { type: "buffer"; data: string }
  | { type: "commandExecuted" };

function getInitialSearchParams(): {
  command?: string;
  autorun: boolean;
  ptyId?: string;
} {
  const search = new URL(window.location.href).searchParams;
  const command = search.get("command") ?? undefined;
  const ptyId = search.get("ptyId") ?? undefined;
  return {
    command,
    ptyId,
    autorun: search.get("autorun") === "true",
  };
}

function updateBrowserSearch(params: {
  ptyId?: string;
  clearPtyId?: boolean;
  clearCommand?: boolean;
}): void {
  const url = new URL(window.location.href);
  if (params.clearPtyId) {
    url.searchParams.delete("ptyId");
  } else if (params.ptyId) {
    url.searchParams.set("ptyId", params.ptyId);
  }
  if (params.clearCommand) {
    url.searchParams.delete("command");
    url.searchParams.delete("autorun");
  }
  window.history.replaceState({}, "", `${url.pathname}${url.search}`);
}

function parseControlMessage(payload: string): ControlMessage | null {
  try {
    return JSON.parse(payload) as ControlMessage;
  } catch {
    return null;
  }
}

function getApiPrefix(pathname: string): string {
  const terminalIndex = pathname.indexOf("/terminal");
  if (terminalIndex <= 0) return "";
  return pathname.slice(0, terminalIndex);
}

export function App() {
  const initial = useMemo(() => getInitialSearchParams(), []);
  const [commandInput, setCommandInput] = useState(initial.command ?? "");
  const [autorun, setAutorun] = useState(initial.autorun);
  const [ptyId, setPtyId] = useState<string | undefined>(initial.ptyId);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [statusText, setStatusText] = useState("Connecting…");

  const terminalContainerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const unmountedRef = useRef(false);
  const suppressReconnectOnCloseRef = useRef(false);
  const ptyIdRef = useRef<string | undefined>(initial.ptyId);
  const initialCommandRef = useRef<{ command?: string; autorun: boolean }>({
    command: initial.command,
    autorun: initial.autorun,
  });

  useEffect(() => {
    ptyIdRef.current = ptyId;
  }, [ptyId]);

  const sendControl = useCallback((message: object) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(COMMAND_PREFIX + JSON.stringify(message));
  }, []);

  const sendResize = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    sendControl({ type: "resize", cols: terminal.cols, rows: terminal.rows });
  }, [sendControl]);

  const connectSocket = useCallback(() => {
    if (unmountedRef.current) return;
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) return;

    const currentUrl = new URL(window.location.href);
    const wsProtocol = currentUrl.protocol === "https:" ? "wss:" : "ws:";
    const apiPrefix = getApiPrefix(currentUrl.pathname);
    const wsUrl = new URL(`${wsProtocol}//${currentUrl.host}${apiPrefix}/api/pty/ws`);

    if (ptyIdRef.current) {
      wsUrl.searchParams.set("ptyId", ptyIdRef.current);
    } else if (initialCommandRef.current.command) {
      wsUrl.searchParams.set("command", initialCommandRef.current.command);
      if (initialCommandRef.current.autorun) {
        wsUrl.searchParams.set("autorun", "true");
      }
    }

    const nextState: ConnectionState =
      reconnectAttemptsRef.current > 0 ? "reconnecting" : "connecting";
    setConnectionState(nextState);
    setStatusText(nextState === "reconnecting" ? "Reconnecting…" : "Connecting…");

    const socket = new WebSocket(wsUrl);
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      reconnectAttemptsRef.current = 0;
      setConnectionState("connected");
      setStatusText("Connected");
      requestAnimationFrame(() => {
        fitAddonRef.current?.fit();
        sendResize();
        terminalRef.current?.focus();
      });
    });

    socket.addEventListener("message", (event) => {
      const payload = typeof event.data === "string" ? event.data : "";
      if (payload.startsWith(COMMAND_PREFIX)) {
        const message = parseControlMessage(payload.slice(COMMAND_PREFIX.length));
        if (!message) return;

        if (message.type === "ptyId") {
          setPtyId(message.ptyId);
          ptyIdRef.current = message.ptyId;
          updateBrowserSearch({ ptyId: message.ptyId });
          return;
        }

        if (message.type === "buffer") {
          terminalRef.current?.reset();
          terminalRef.current?.write(message.data);
          return;
        }

        if (message.type === "commandExecuted") {
          initialCommandRef.current = { command: undefined, autorun: false };
          updateBrowserSearch({ clearCommand: true });
          return;
        }

        return;
      }
      terminalRef.current?.write(payload);
    });

    socket.addEventListener("close", (event) => {
      socketRef.current = null;
      if (suppressReconnectOnCloseRef.current) {
        suppressReconnectOnCloseRef.current = false;
        return;
      }

      const shouldReconnect =
        !unmountedRef.current &&
        event.code !== 1000 &&
        event.code !== 4000 &&
        reconnectAttemptsRef.current < MAX_RECONNECTION_ATTEMPTS;

      if (!shouldReconnect) {
        const reason = event.reason || "Disconnected";
        setConnectionState("disconnected");
        setStatusText(reason);
        return;
      }

      reconnectAttemptsRef.current += 1;
      const reconnectDelayMs = Math.min(5_000, 1_000 * reconnectAttemptsRef.current);
      setConnectionState("reconnecting");
      setStatusText(`Reconnecting (attempt ${reconnectAttemptsRef.current})…`);

      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      reconnectTimerRef.current = window.setTimeout(() => {
        connectSocket();
      }, reconnectDelayMs);
    });

    socket.addEventListener("error", () => {
      setStatusText("Connection error");
    });
  }, [sendResize]);

  const forceReconnect = useCallback(
    (options?: { clearPtyId?: boolean }) => {
      if (options?.clearPtyId) {
        setPtyId(undefined);
        ptyIdRef.current = undefined;
        updateBrowserSearch({ clearPtyId: true });
      }

      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      reconnectAttemptsRef.current = 0;

      const socket = socketRef.current;
      if (socket) {
        suppressReconnectOnCloseRef.current = true;
        socketRef.current = null;
        socket.close(1001, "Client reconnect");
      }

      connectSocket();
    },
    [connectSocket],
  );

  useEffect(() => {
    unmountedRef.current = false;
    const mount = terminalContainerRef.current;
    if (!mount) return;

    const terminal = new Terminal({
      fontSize: 13,
      cursorBlink: true,
      fontFamily:
        '"JetBrains Mono", "JetBrainsMono Nerd Font", Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: "#13151a",
        foreground: "#d9dde8",
        cursor: "#d9dde8",
        selectionBackground: "#1f2d4a",
      },
      scrollback: 30_000,
      allowTransparency: true,
    });
    const fitAddon = new FitAddon();

    terminal.loadAddon(fitAddon);
    terminal.open(mount);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    requestAnimationFrame(() => {
      fitAddon.fit();
      terminal.focus();
    });

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        fitAddon.fit();
        sendResize();
      });
    });
    resizeObserver.observe(mount);

    const resizeHandler = () => {
      fitAddon.fit();
      sendResize();
    };
    window.addEventListener("resize", resizeHandler);

    const dataSubscription = terminal.onData((data) => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      socket.send(data);
    });

    connectSocket();

    return () => {
      unmountedRef.current = true;
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      const socket = socketRef.current;
      if (socket) {
        suppressReconnectOnCloseRef.current = true;
        socketRef.current = null;
        socket.close(1001, "Unmount");
      }
      dataSubscription.dispose();
      resizeObserver.disconnect();
      window.removeEventListener("resize", resizeHandler);
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [connectSocket, sendResize]);

  const runCommand = useCallback(() => {
    const command = commandInput.trim();
    if (command.length === 0) return;
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      terminalRef.current?.writeln("\r\n\x1b[31mNot connected to PTY\x1b[0m\r\n");
      return;
    }
    sendControl({ type: "exec", command, autorun });
  }, [autorun, commandInput, sendControl]);

  return (
    <div className="app-shell">
      <section className="card controls-card">
        <div className="status-row">
          <span className="status-dot" data-state={connectionState} />
          <span className="status-text">{statusText}</span>
          {ptyId ? <span className="session-pill">pty:{ptyId.slice(0, 8)}</span> : null}
        </div>
        <div className="controls-grid">
          <input
            className="input"
            type="text"
            value={commandInput}
            onChange={(event) => setCommandInput(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                runCommand();
              }
            }}
            placeholder="Command to run in shell"
          />
          <button
            className="btn"
            type="button"
            onClick={runCommand}
            disabled={commandInput.trim().length === 0}
          >
            Run
          </button>
          <button className="btn btn-secondary" type="button" onClick={() => forceReconnect()}>
            Reconnect
          </button>
          <button
            className="btn btn-secondary"
            type="button"
            onClick={() => forceReconnect({ clearPtyId: true })}
          >
            New Session
          </button>
        </div>
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={autorun}
            onChange={(event) => setAutorun(event.currentTarget.checked)}
          />
          send Enter after command
        </label>
      </section>

      <section className="card terminal-card">
        <div className="terminal-container" ref={terminalContainerRef} />
      </section>
    </div>
  );
}
