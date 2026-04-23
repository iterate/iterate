import {
  a as __toESM,
  n as require_react,
  t as require_jsx_runtime,
} from "./jsx-runtime-B8ri5dzN.js";
//#region src/routes/terminal.tsx?tsr-split=component
var import_react = /* @__PURE__ */ __toESM(require_react());
var import_jsx_runtime = require_jsx_runtime();
function TerminalPage() {
  const termRef = (0, import_react.useRef)(null);
  const [status, setStatus] = (0, import_react.useState)("connecting");
  (0, import_react.useEffect)(() => {
    if (!termRef.current) return;
    let ws;
    let term;
    let fitAddon;
    (async () => {
      const { Terminal } = await import("./xterm-CXl2tWAd.js");
      const { FitAddon } = await import("./addon-fit-BA9tny33.js");
      term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
        theme: {
          background: "#1e1e1e",
          foreground: "#d4d4d4",
          cursor: "#f59e0b",
          selectionBackground: "#264f78",
        },
      });
      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(termRef.current);
      fitAddon.fit();
      term.writeln("\x1B[1;34m┌─────────────────────────────────────────┐\x1B[0m");
      term.writeln(
        "\x1B[1;34m│\x1B[0m  \x1B[1;33mTerminal\x1B[0m — Durable Object Facet       \x1B[1;34m│\x1B[0m",
      );
      term.writeln("\x1B[1;34m└─────────────────────────────────────────┘\x1B[0m");
      term.writeln("");
      term.writeln("\x1B[90mConnecting to /api/pty via WebSocket...\x1B[0m");
      term.writeln("");
      const url = new URL("/api/pty", window.location.origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(url.toString());
      ws.onopen = () => {
        setStatus("connected");
        term.writeln("\x1B[32m✓ Connected\x1B[0m");
        term.writeln("");
      };
      ws.onmessage = (event) => {
        term.write(event.data);
      };
      ws.onclose = (event) => {
        setStatus("closed");
        term.writeln("");
        term.writeln(
          `\x1b[90mConnection closed (code: ${event.code}${event.reason ? `, reason: ${event.reason}` : ""})\x1b[0m`,
        );
      };
      ws.onerror = () => {
        term.writeln("\x1B[31m✗ WebSocket error\x1B[0m");
      };
      term.onData((data) => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(data);
      });
      const resizeObserver = new ResizeObserver(() => {
        fitAddon?.fit();
        if (ws?.readyState === WebSocket.OPEN && term)
          ws.send(
            `\x00resize\x00${JSON.stringify({
              cols: term.cols,
              rows: term.rows,
            })}`,
          );
      });
      resizeObserver.observe(termRef.current);
      return () => resizeObserver.disconnect();
    })();
    return () => {
      ws?.close();
      term?.dispose();
    };
  }, []);
  const statusColor =
    status === "connected" ? "#4ade80" : status === "connecting" ? "#fbbf24" : "#888";
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      height: "calc(100vh - 49px)",
      background: "#1e1e1e",
    },
    children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
        style: {
          padding: "0.5rem 1rem",
          borderBottom: "1px solid #333",
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          background: "#1a1a1a",
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
            style: {
              fontSize: "0.85rem",
              fontWeight: 500,
              color: "#e0e0e0",
            },
            children: "Terminal",
          }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
            style: {
              fontSize: "0.7rem",
              padding: "1px 6px",
              borderRadius: 4,
              border: `1px solid ${statusColor}33`,
              color: statusColor,
            },
            children: status,
          }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
            style: {
              fontSize: "0.75rem",
              color: "#555",
            },
            children: "WebSocket → /api/pty",
          }),
        ],
      }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
        ref: termRef,
        style: {
          flex: 1,
          padding: "4px",
        },
      }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("link", {
        rel: "stylesheet",
        href: "https://cdn.jsdelivr.net/npm/@xterm/xterm@5/css/xterm.min.css",
      }),
    ],
  });
}
//#endregion
export { TerminalPage as component };
