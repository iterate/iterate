import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

export const Route = createFileRoute("/terminal")({
  component: TerminalPage,
});

function TerminalPage() {
  const termRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"connecting" | "connected" | "closed">("connecting");

  useEffect(() => {
    if (!termRef.current) return;

    let ws: WebSocket | undefined;
    let term: any;
    let fitAddon: any;

    (async () => {
      // Dynamic import to avoid SSR issues (xterm needs DOM)
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");

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
      term.open(termRef.current!);
      fitAddon.fit();

      term.writeln("\x1b[1;34m┌─────────────────────────────────────────┐\x1b[0m");
      term.writeln(
        "\x1b[1;34m│\x1b[0m  \x1b[1;33mTerminal\x1b[0m — Durable Object Facet       \x1b[1;34m│\x1b[0m",
      );
      term.writeln("\x1b[1;34m└─────────────────────────────────────────┘\x1b[0m");
      term.writeln("");
      term.writeln("\x1b[90mConnecting to /api/pty via WebSocket...\x1b[0m");
      term.writeln("");

      // Connect to the PTY WebSocket
      const url = new URL("/api/pty", window.location.origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(url.toString());

      ws.onopen = () => {
        setStatus("connected");
        term.writeln("\x1b[32m✓ Connected\x1b[0m");
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
        term.writeln("\x1b[31m✗ WebSocket error\x1b[0m");
      };

      // Forward terminal input to WebSocket
      term.onData((data: string) => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });

      // Handle resize
      const resizeObserver = new ResizeObserver(() => {
        fitAddon?.fit();
        if (ws?.readyState === WebSocket.OPEN && term) {
          ws.send(`\x00resize\x00${JSON.stringify({ cols: term.cols, rows: term.rows })}`);
        }
      });
      resizeObserver.observe(termRef.current!);

      return () => resizeObserver.disconnect();
    })();

    return () => {
      ws?.close();
      term?.dispose();
    };
  }, []);

  const statusColor =
    status === "connected" ? "#4ade80" : status === "connecting" ? "#fbbf24" : "#888";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "calc(100vh - 49px)",
        background: "#1e1e1e",
      }}
    >
      <div
        style={{
          padding: "0.5rem 1rem",
          borderBottom: "1px solid #333",
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          background: "#1a1a1a",
        }}
      >
        <span style={{ fontSize: "0.85rem", fontWeight: 500, color: "#e0e0e0" }}>Terminal</span>
        <span
          style={{
            fontSize: "0.7rem",
            padding: "1px 6px",
            borderRadius: 4,
            border: `1px solid ${statusColor}33`,
            color: statusColor,
          }}
        >
          {status}
        </span>
        <span style={{ fontSize: "0.75rem", color: "#555" }}>WebSocket → /api/pty</span>
      </div>
      <div ref={termRef} style={{ flex: 1, padding: "4px" }} />
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5/css/xterm.min.css" />
    </div>
  );
}
