import React, { useState, useEffect, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";

type Subscription = {
  id: number;
  stream_path: string;
  events_base_url: string;
  events_project_slug: string;
  slug: string;
  callback_url: string;
  created_at: string;
};

type StreamEvent = {
  id: number;
  type: string;
  role: string | null;
  content: string | null;
  payload: string;
  offset: number | null;
  stream_path: string;
  created_at: string;
};

// Derive project slug from hostname: agents.<project>.iterate-dev-jonas.app
function deriveProjectSlug(): string {
  const host = location.hostname;
  const suffix = ".iterate-dev-jonas.app";
  if (!host.endsWith(suffix)) return "";
  const prefix = host.slice(0, -suffix.length); // "agents.test"
  const dot = prefix.indexOf(".");
  return dot === -1 ? prefix : prefix.slice(dot + 1); // "test"
}

function normalizeStreamPath(p: string): string {
  const trimmed = p.trim();
  return trimmed.startsWith("/") ? trimmed : "/" + trimmed;
}

function AgentsApp() {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [connected, setConnected] = useState(false);
  const [streamPath, setStreamPath] = useState("/agents/demo");
  const [eventsBaseUrl, setEventsBaseUrl] = useState("https://events.iterate.com");
  const [eventsProjectSlug, setEventsProjectSlug] = useState(deriveProjectSlug);
  const [subscribing, setSubscribing] = useState(false);
  const [lastResult, setLastResult] = useState<any>(null);
  const [selectedStream, setSelectedStream] = useState<string | null>(null);
  const [streamEvents, setStreamEvents] = useState<StreamEvent[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  // WebSocket for live UI sync
  useEffect(() => {
    function connect() {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(proto + "//" + location.host + "/api/ws");
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        setTimeout(connect, 2000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "sync" && msg.subscriptions) {
            setSubscriptions(msg.subscriptions);
          }
        } catch {}
      };
    }
    connect();
    return () => {
      wsRef.current?.close();
    };
  }, []);

  // Load subscriptions on mount
  useEffect(() => {
    fetch("/api/subscriptions")
      .then((r) => r.json())
      .then((d) => setSubscriptions(d.subscriptions || []))
      .catch(() => {});
  }, []);

  const handleSubscribe = useCallback(async () => {
    if (!streamPath || !eventsBaseUrl || !eventsProjectSlug) return;
    setSubscribing(true);
    setLastResult(null);
    const normalized = normalizeStreamPath(streamPath);
    setStreamPath(normalized);
    try {
      const resp = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ streamPath: normalized, eventsBaseUrl, eventsProjectSlug }),
      });
      const result = await resp.json();
      setLastResult(result);
      if (result.ok) {
        setSelectedStream(streamPath);
      }
    } catch (err: any) {
      setLastResult({ error: err.message });
    }
    setSubscribing(false);
  }, [streamPath, eventsBaseUrl, eventsProjectSlug]);

  // Poll stream events when a stream is selected
  useEffect(() => {
    if (!selectedStream) return;
    let active = true;
    async function poll() {
      try {
        const resp = await fetch("/api/stream-events/" + encodeURIComponent(selectedStream!));
        const data = await resp.json();
        if (active) setStreamEvents(data.events || []);
      } catch {}
      if (active) setTimeout(poll, 3000);
    }
    poll();
    return () => {
      active = false;
    };
  }, [selectedStream]);

  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        background: "#0a0a0a",
        color: "#e0e0e0",
        minHeight: "100vh",
        padding: "2rem",
        maxWidth: 720,
        margin: "0 auto",
      }}
    >
      <h1 style={{ fontSize: "1.4rem", color: "#fff", marginBottom: ".5rem" }}>Agents App</h1>
      <div
        style={{
          fontSize: ".8rem",
          padding: "4px 12px",
          borderRadius: 12,
          background: "#1a1a1a",
          border: connected ? "1px solid #166534" : "1px solid #7f1d1d",
          color: connected ? "#4ade80" : "#f87171",
          display: "inline-block",
          marginBottom: "1.5rem",
        }}
      >
        {connected ? "connected" : "disconnected"}
      </div>

      {/* Subscribe form */}
      <div
        style={{
          background: "#1a1a1a",
          border: "1px solid #333",
          borderRadius: 8,
          padding: "1.2rem",
          marginBottom: "1rem",
        }}
      >
        <b style={{ color: "#fff" }}>Subscribe to events stream</b>
        <p style={{ fontSize: ".8rem", color: "#888", margin: ".5rem 0" }}>
          This appends a websocket subscription to events.iterate.com so events on the stream push
          to this app's StreamProcessor via WebSocket.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: ".5rem", marginTop: ".5rem" }}>
          <input
            value={eventsBaseUrl}
            onChange={(e) => setEventsBaseUrl(e.target.value)}
            placeholder="Events base URL"
            style={inputStyle}
          />
          <input
            value={eventsProjectSlug}
            onChange={(e) => setEventsProjectSlug(e.target.value)}
            placeholder="Events project slug (e.g. your-slug)"
            style={inputStyle}
          />
          <input
            value={streamPath}
            onChange={(e) => setStreamPath(e.target.value)}
            placeholder="Stream path (e.g. agents/demo)"
            style={inputStyle}
          />
          <button
            onClick={handleSubscribe}
            disabled={subscribing || !streamPath || !eventsProjectSlug}
            style={{
              background: subscribing ? "#555" : "#3b82f6",
              color: "#fff",
              border: "none",
              padding: ".5rem 1rem",
              borderRadius: 6,
              cursor: subscribing ? "not-allowed" : "pointer",
              fontWeight: 600,
            }}
          >
            {subscribing ? "Subscribing..." : "Subscribe"}
          </button>
        </div>
        {lastResult && (
          <pre
            style={{
              marginTop: ".5rem",
              fontSize: ".75rem",
              color: lastResult.ok ? "#6ee7b7" : "#f87171",
              background: "#111",
              padding: ".5rem",
              borderRadius: 4,
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {JSON.stringify(lastResult, null, 2)}
          </pre>
        )}
      </div>

      {/* Subscriptions list */}
      {subscriptions.length > 0 && (
        <div style={{ marginBottom: "1rem" }}>
          <h2 style={{ fontSize: "1rem", color: "#aaa", marginBottom: ".5rem" }}>
            Subscriptions ({subscriptions.length})
          </h2>
          {subscriptions.map((sub) => (
            <div
              key={sub.id}
              onClick={() => setSelectedStream(sub.stream_path)}
              style={{
                background: selectedStream === sub.stream_path ? "#1e3a5f" : "#1a1a1a",
                border: selectedStream === sub.stream_path ? "1px solid #3b82f6" : "1px solid #333",
                borderRadius: 8,
                padding: ".8rem",
                marginBottom: ".5rem",
                cursor: "pointer",
                transition: "border-color .15s",
              }}
            >
              <div style={{ fontWeight: 600, color: "#fff", fontFamily: "monospace" }}>
                {sub.stream_path}
              </div>
              <div style={{ fontSize: ".75rem", color: "#555", marginTop: ".2rem" }}>
                {sub.events_project_slug}.events | slug: {sub.slug}
              </div>
              <div
                style={{
                  fontSize: ".7rem",
                  marginTop: ".3rem",
                  display: "flex",
                  gap: ".5rem",
                  flexWrap: "wrap",
                }}
              >
                <a
                  href={`https://${sub.events_project_slug}.events.iterate.com/streams${sub.stream_path}`}
                  target="_blank"
                  rel="noopener"
                  style={{ color: "#60a5fa", textDecoration: "none" }}
                  onClick={(e) => e.stopPropagation()}
                >
                  events viewer
                </a>
                <span style={{ color: "#333" }}>|</span>
                <span style={{ color: "#444", wordBreak: "break-all" }}>
                  callback: {sub.callback_url}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Stream events */}
      {selectedStream && (
        <div>
          <h2 style={{ fontSize: "1rem", color: "#aaa", marginBottom: ".5rem" }}>
            Events: {selectedStream}
            <span style={{ fontSize: ".75rem", color: "#555", marginLeft: ".5rem" }}>
              (polling every 3s)
            </span>
          </h2>
          {streamEvents.length === 0 ? (
            <div
              style={{
                background: "#1a1a1a",
                border: "1px solid #333",
                borderRadius: 8,
                padding: "1rem",
                textAlign: "center",
                color: "#555",
              }}
            >
              No events yet. Append an{" "}
              <code style={{ background: "#222", padding: "2px 6px", borderRadius: 3 }}>
                agent-input-added
              </code>{" "}
              event to the stream.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: ".5rem" }}>
              {streamEvents.map((ev) => (
                <div
                  key={ev.id}
                  style={{
                    background:
                      ev.role === "assistant" ? "#1a1a1a" : ev.role === "user" ? "#1e3a5f" : "#111",
                    border:
                      "1px solid " +
                      (ev.role === "assistant" ? "#333" : ev.role === "user" ? "#2563eb" : "#222"),
                    borderRadius: 8,
                    padding: ".8rem",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <span
                      style={{
                        fontSize: ".75rem",
                        fontWeight: 600,
                        color:
                          ev.role === "user"
                            ? "#93c5fd"
                            : ev.role === "assistant"
                              ? "#6ee7b7"
                              : "#60a5fa",
                      }}
                    >
                      {ev.role ? `${ev.role}` : ev.type}
                    </span>
                    <span style={{ fontSize: ".7rem", color: "#444" }}>
                      #{ev.id} {ev.created_at}
                    </span>
                  </div>
                  {ev.content ? (
                    <div style={{ marginTop: ".3rem", fontSize: ".85rem", whiteSpace: "pre-wrap" }}>
                      {ev.content}
                    </div>
                  ) : (
                    <pre
                      style={{
                        marginTop: ".3rem",
                        fontSize: ".7rem",
                        color: "#888",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-all",
                      }}
                    >
                      {ev.payload}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Links */}
      <div style={{ marginTop: "2rem", fontSize: ".8rem", color: "#555" }}>
        <a href="/_studio" style={{ color: "#60a5fa" }}>
          App SQL Studio
        </a>
        {selectedStream && (
          <>
            {" | "}
            <a
              href={"/streams/" + encodeURIComponent(selectedStream) + "/_studio"}
              style={{ color: "#60a5fa" }}
            >
              Stream SQL Studio
            </a>
          </>
        )}
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "#222",
  border: "1px solid #444",
  color: "#fff",
  padding: ".5rem .75rem",
  borderRadius: 6,
  fontFamily: "monospace",
  fontSize: ".85rem",
  width: "100%",
};

createRoot(document.getElementById("root")!).render(<AgentsApp />);
