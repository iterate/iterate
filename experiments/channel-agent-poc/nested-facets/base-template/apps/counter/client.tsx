import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";

function Counter() {
  const [count, setCount] = useState<number>(0);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    function connect() {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(proto + "//" + location.host + "/api/ws");
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        setTimeout(connect, 1000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (e) => {
        try {
          const d = JSON.parse(e.data);
          if (d.count !== undefined) setCount(d.count);
        } catch {}
      };
    }
    connect();
    return () => {
      wsRef.current?.close();
    };
  }, []);

  function send(action: string) {
    if (wsRef.current?.readyState === 1) {
      wsRef.current.send(JSON.stringify({ action }));
    }
  }

  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        background: "#0a0a0a",
        color: "#e0e0e0",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
      }}
    >
      <img
        src="/logo.svg"
        alt="Counter"
        style={{ width: 64, height: 64, marginBottom: "0.5rem" }}
      />
      <h1 style={{ fontSize: "1.4rem", marginBottom: ".5rem", color: "#fff" }}>Counter App</h1>
      <div
        style={{
          fontSize: "6rem",
          fontWeight: 700,
          color: "#f59e0b",
          margin: "2rem 0",
          fontFamily: "monospace",
          minWidth: 200,
          textAlign: "center",
        }}
      >
        {count}
      </div>
      <div style={{ display: "flex", gap: "1rem" }}>
        <button
          onClick={() => send("decrement")}
          style={{
            fontSize: "2rem",
            width: 80,
            height: 80,
            borderRadius: "50%",
            border: "2px solid #7f1d1d",
            background: "#1a1a1a",
            color: "#f87171",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          -
        </button>
        <button
          onClick={() => send("increment")}
          style={{
            fontSize: "2rem",
            width: 80,
            height: 80,
            borderRadius: "50%",
            border: "2px solid #166534",
            background: "#1a1a1a",
            color: "#4ade80",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          +
        </button>
      </div>
      <div
        style={{
          fontSize: ".8rem",
          marginTop: "1rem",
          padding: "4px 12px",
          borderRadius: 12,
          background: "#1a1a1a",
          border: connected ? "1px solid #166534" : "1px solid #7f1d1d",
          color: connected ? "#4ade80" : "#f87171",
        }}
      >
        {connected ? "connected" : "disconnected"}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Counter />);
