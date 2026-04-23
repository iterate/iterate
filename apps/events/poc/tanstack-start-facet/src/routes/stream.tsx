import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { RPCLink as WebSocketRPCLink } from "@orpc/client/websocket";
import type { appRouter } from "../orpc/router";
import type { RouterClient } from "@orpc/server";
import type { RandomLogStreamRequest } from "../orpc/contract";

type Status = "idle" | "connecting" | "streaming" | "completed" | "error";
type Transport = "openapi" | "websocket";

type Client = RouterClient<typeof appRouter>;

function createRpcClient(): Client {
  return createORPCClient(new RPCLink({ url: `${window.location.origin}/api/rpc` }));
}

function createWsClient() {
  const url = new URL("/api/rpc-ws", window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const websocket = new WebSocket(url.toString());
  const client = createORPCClient(new WebSocketRPCLink({ websocket })) as Client;
  return { client, close: () => websocket.close() };
}

export const Route = createFileRoute("/stream")({
  component: StreamPage,
});

function StreamPage() {
  const [transport, setTransport] = useState<Transport>("openapi");
  const [count, setCount] = useState(20);
  const [minDelay, setMinDelay] = useState(50);
  const [maxDelay, setMaxDelay] = useState(300);
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines]);

  async function startStream() {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLines([]);
    setError(null);
    setStatus("connecting");

    const req: RandomLogStreamRequest = { count, minDelayMs: minDelay, maxDelayMs: maxDelay };

    const transportClient =
      transport === "websocket" ? createWsClient() : { client: createRpcClient(), close: () => {} };

    try {
      const stream = await transportClient.client.test.randomLogStream(req, {
        signal: controller.signal,
      });
      setStatus("streaming");
      for await (const line of stream) {
        if (controller.signal.aborted) return;
        setLines((prev) => [...prev, line].slice(-500));
      }
      if (!controller.signal.aborted) setStatus("completed");
    } catch (err: any) {
      if (!controller.signal.aborted) {
        setError(err.message || String(err));
        setStatus("error");
      }
    } finally {
      transportClient.close();
    }
  }

  const isActive = status === "connecting" || status === "streaming";

  return (
    <main
      style={{
        maxWidth: "none",
        display: "flex",
        flexDirection: "column",
        height: "calc(100vh - 49px)",
      }}
    >
      <div style={{ padding: "1rem 2rem", borderBottom: "1px solid #222" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
          <h1 style={{ fontSize: "1.2rem", margin: 0 }}>Log Stream</h1>
          <StatusBadge status={status} />
          <span style={{ color: "#555", fontSize: "0.85rem" }}>
            {transport === "websocket" ? "WebSocket" : "OpenAPI/SSE"} · {lines.length} lines
          </span>
        </div>

        <p style={{ fontSize: "0.85rem", color: "#888", margin: "0.5rem 0 0.75rem" }}>
          Streams from an <code>async function*</code> oRPC handler. Switch between OpenAPI (SSE
          over HTTP) and WebSocket transport.
        </p>

        <div style={{ display: "flex", gap: "0.75rem", alignItems: "flex-end", flexWrap: "wrap" }}>
          {/* Transport selector */}
          <div>
            <label
              style={{
                fontSize: "0.7rem",
                color: "#666",
                display: "block",
                marginBottom: "0.2rem",
              }}
            >
              Transport
            </label>
            <div style={{ display: "flex", gap: "0.25rem" }}>
              {(["openapi", "websocket"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTransport(t)}
                  disabled={isActive}
                  style={{
                    background: transport === t ? "#1e3a5f" : "#1a1a1a",
                    borderColor: transport === t ? "#2563eb" : "#333",
                    color: transport === t ? "#93c5fd" : "#888",
                    fontSize: "0.8rem",
                  }}
                >
                  {t === "openapi" ? "OpenAPI (SSE)" : "WebSocket"}
                </button>
              ))}
            </div>
          </div>

          <NumInput
            label="Count"
            value={count}
            onChange={setCount}
            min={1}
            max={500}
            disabled={isActive}
          />
          <NumInput
            label="Min ms"
            value={minDelay}
            onChange={setMinDelay}
            min={0}
            max={10000}
            disabled={isActive}
          />
          <NumInput
            label="Max ms"
            value={maxDelay}
            onChange={setMaxDelay}
            min={1}
            max={10000}
            disabled={isActive}
          />

          <button
            className="btn-primary"
            onClick={startStream}
            disabled={isActive || maxDelay <= minDelay}
          >
            {isActive ? "Streaming..." : "Start"}
          </button>
          <button
            onClick={() => {
              abortRef.current?.abort();
              setLines([]);
              setStatus("idle");
              setError(null);
            }}
          >
            Clear
          </button>
        </div>

        {/* Procedure info */}
        <div
          style={{
            marginTop: "0.5rem",
            padding: "0.4rem 0.6rem",
            background: "#111",
            border: "1px solid #222",
            borderRadius: 6,
            fontFamily: "monospace",
            fontSize: "0.7rem",
            color: "#888",
          }}
        >
          <span style={{ color: "#555" }}>procedure:</span>{" "}
          <span style={{ color: "#4ade80" }}>test.randomLogStream</span>
          <span style={{ color: "#555" }}> | transport:</span>{" "}
          <span style={{ color: "#60a5fa" }}>
            {transport === "websocket" ? "WebSocketRPCLink" : "RPCLink (fetch/SSE)"}
          </span>
          <span style={{ color: "#555" }}> | endpoint:</span>{" "}
          <span style={{ color: "#aaa" }}>
            {transport === "websocket" ? "/api/rpc-ws" : "/api/rpc/test/randomLogStream"}
          </span>
        </div>
      </div>

      {error && (
        <div
          style={{
            margin: "0.5rem 2rem",
            padding: "0.5rem 0.75rem",
            background: "#450a0a",
            border: "1px solid #7f1d1d",
            borderRadius: 6,
            color: "#fca5a5",
            fontSize: "0.85rem",
          }}
        >
          {error}
        </div>
      )}

      <pre
        ref={logRef}
        style={{
          flex: 1,
          margin: 0,
          padding: "1rem 2rem",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          background: "#0a0a0a",
        }}
      >
        {lines.length > 0 ? lines.join("\n") : "Click Start to stream log lines via oRPC."}
      </pre>
    </main>
  );
}

function NumInput({
  label,
  value,
  onChange,
  min,
  max,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  disabled: boolean;
}) {
  return (
    <div>
      <label
        style={{ fontSize: "0.7rem", color: "#666", display: "block", marginBottom: "0.2rem" }}
      >
        {label}
      </label>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(+e.target.value)}
        disabled={disabled}
        style={{ width: 70, textAlign: "center", fontFamily: "monospace" }}
      />
    </div>
  );
}

function StatusBadge({ status }: { status: Status }) {
  const c: Record<Status, string> = {
    idle: "#333",
    connecting: "#92400e",
    streaming: "#166534",
    completed: "#1d4ed8",
    error: "#991b1b",
  };
  const t: Record<Status, string> = {
    idle: "#888",
    connecting: "#fbbf24",
    streaming: "#4ade80",
    completed: "#93c5fd",
    error: "#fca5a5",
  };
  return (
    <span
      style={{
        padding: "1px 6px",
        borderRadius: 4,
        fontSize: "0.7rem",
        border: `1px solid ${c[status]}`,
        color: t[status],
      }}
    >
      {status}
    </span>
  );
}
