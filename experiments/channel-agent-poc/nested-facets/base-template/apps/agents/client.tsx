import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

type StreamEvent = {
  type: string;
  payload?: any;
  idempotencyKey?: string;
  offset?: number;
  createdAt?: string;
};

function normalizeStreamPath(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "/agents/webchat";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function initialStreamPath() {
  const params = new URLSearchParams(window.location.search);
  return normalizeStreamPath(params.get("path") ?? "/agents/webchat");
}

function appBasePath() {
  const match = window.location.pathname.match(/^\/apps\/agents(?:\/|$)/);
  return match ? "/apps/agents" : "";
}

const APP_BASE_PATH = appBasePath();

function yamlScalar(value: unknown): string {
  if (value == null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = String(value);
  return /^[a-zA-Z0-9._/@:-]+$/.test(text) ? text : JSON.stringify(text);
}

function yamlBlock(key: string, value: string, indent = 0): string[] {
  const pad = " ".repeat(indent);
  return [`${pad}${key}: |-`, ...value.split("\n").map((line) => `${pad}  ${line}`)];
}

function valueToYaml(key: string, value: any, indent = 0): string[] {
  const pad = " ".repeat(indent);
  if (typeof value === "undefined") return [];
  if (typeof value === "string" && value.includes("\n")) return yamlBlock(key, value, indent);
  if (value == null || typeof value !== "object") return [`${pad}${key}: ${yamlScalar(value)}`];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}${key}: []`];
    return [
      `${pad}${key}:`,
      ...value.flatMap((item) =>
        item != null && typeof item === "object"
          ? [`${pad}  -`, ...objectToYaml(item, indent + 4)]
          : [`${pad}  - ${yamlScalar(item)}`],
      ),
    ];
  }
  return [`${pad}${key}:`, ...objectToYaml(value, indent + 2)];
}

function objectToYaml(value: Record<string, any>, indent = 0): string[] {
  return Object.entries(value).flatMap(([key, child]) => valueToYaml(key, child, indent));
}

function eventToYaml(event: StreamEvent): string {
  return objectToYaml({
    offset: event.offset,
    type: event.type,
    idempotencyKey: event.idempotencyKey,
    createdAt: event.createdAt,
    payload: event.payload ?? {},
  }).join("\n");
}

export function AgentsWebchat() {
  const [streamPath, setStreamPath] = useState(initialStreamPath);
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [content, setContent] = useState("");
  const [connected, setConnected] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const normalizedPath = useMemo(() => normalizeStreamPath(streamPath), [streamPath]);

  useEffect(() => {
    document.documentElement.style.height = "100%";
    document.body.style.height = "100%";
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";
    const root = document.getElementById("root");
    if (root) root.style.height = "100%";
  }, []);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("path")) return;
    fetch(`${APP_BASE_PATH}/api/webchat-config`)
      .then((r) => r.json())
      .then((config) => {
        if (config.defaultStreamPath) setStreamPath(config.defaultStreamPath);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setEvents([]);
    setConnected(false);
    setError(null);
    const source = new EventSource(
      `${APP_BASE_PATH}/api/webchat-stream?path=${encodeURIComponent(normalizedPath)}`,
    );
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data);
        setEvents((current) => {
          if (
            event.offset != null &&
            current.some((existing) => existing.offset === event.offset)
          ) {
            return current;
          }
          return [...current, event];
        });
      } catch (err: any) {
        setError(err.message);
      }
    };
    return () => source.close();
  }, [normalizedPath]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
    bottomRef.current?.scrollIntoView({ block: "end" });
    requestAnimationFrame(() => {
      list.scrollTop = list.scrollHeight;
      bottomRef.current?.scrollIntoView({ block: "end" });
    });
  }, [events]);

  async function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    const text = content.trim();
    if (!text) return;
    setSending(true);
    setError(null);
    try {
      const resp = await fetch(`${APP_BASE_PATH}/api/webchat-message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ streamPath: normalizedPath, content: text }),
      });
      const result = await resp.json();
      if (!resp.ok || !result.ok) throw new Error(result.error ?? `HTTP ${resp.status}`);
      setContent("");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  }

  return (
    <main style={styles.shell}>
      <section style={styles.toolbar}>
        <div style={styles.brand}>
          <div style={styles.title}>Agents</div>
          <div style={connected ? styles.connected : styles.disconnected}>
            {connected ? "live" : "connecting"}
          </div>
        </div>
        <input
          value={streamPath}
          onChange={(e) => setStreamPath(e.target.value)}
          onBlur={() => setStreamPath(normalizedPath)}
          style={styles.pathInput}
          aria-label="Stream path"
        />
      </section>

      <section ref={listRef} style={styles.events}>
        {events.length === 0 ? (
          <div style={styles.empty}>Waiting for events on {normalizedPath}</div>
        ) : (
          events.map((event) => (
            <pre key={`${event.offset ?? event.idempotencyKey ?? event.type}`} style={styles.event}>
              {eventToYaml(event)}
            </pre>
          ))
        )}
        <div ref={bottomRef} style={styles.bottomAnchor} />
      </section>

      <form onSubmit={sendMessage} style={styles.composer}>
        <input
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Send a message to the agent"
          style={styles.messageInput}
          disabled={sending}
        />
        <button type="submit" disabled={sending || !content.trim()} style={styles.sendButton}>
          Send
        </button>
      </form>
      {error && <div style={styles.error}>{error}</div>}
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  shell: {
    height: "100dvh",
    background: "#f7f7f4",
    color: "#1e293b",
    display: "grid",
    gridTemplateRows: "auto minmax(0, 1fr)",
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
    overflow: "hidden",
    paddingBottom: 88,
  },
  toolbar: {
    display: "flex",
    gap: 12,
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
    borderBottom: "1px solid #d9d9d2",
    background: "#ffffff",
  },
  brand: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    minWidth: 140,
  },
  title: {
    fontSize: 16,
    fontWeight: 700,
  },
  connected: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 12,
    color: "#047857",
  },
  disconnected: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 12,
    color: "#b45309",
  },
  pathInput: {
    flex: 1,
    maxWidth: 560,
    minWidth: 0,
    height: 36,
    border: "1px solid #c9c9c2",
    borderRadius: 6,
    padding: "0 10px",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 13,
    color: "#111827",
    background: "#fbfbf8",
  },
  events: {
    minHeight: 0,
    height: "100%",
    overflow: "auto",
    padding: 16,
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  empty: {
    height: "100%",
    minHeight: 240,
    display: "grid",
    placeItems: "center",
    color: "#64748b",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 13,
    border: "1px dashed #cbd5e1",
    borderRadius: 8,
    background: "#ffffff",
  },
  event: {
    margin: 0,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    background: "#ffffff",
    border: "1px solid #d9d9d2",
    borderRadius: 8,
    padding: 12,
    color: "#0f172a",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 12,
    lineHeight: 1.45,
  },
  bottomAnchor: {
    width: 1,
    height: 1,
    flex: "0 0 auto",
  },
  composer: {
    display: "flex",
    gap: 10,
    padding: 16,
    borderTop: "1px solid #d9d9d2",
    background: "#ffffff",
    position: "fixed",
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 10,
    boxShadow: "0 -1px 0 #d9d9d2",
  },
  messageInput: {
    flex: 1,
    minWidth: 0,
    height: 40,
    border: "1px solid #c9c9c2",
    borderRadius: 6,
    padding: "0 12px",
    fontSize: 14,
    color: "#111827",
    background: "#fbfbf8",
  },
  sendButton: {
    height: 40,
    minWidth: 80,
    border: "1px solid #0f172a",
    borderRadius: 6,
    background: "#0f172a",
    color: "#ffffff",
    fontWeight: 700,
    cursor: "pointer",
  },
  error: {
    position: "fixed",
    left: 0,
    right: 0,
    bottom: 72,
    zIndex: 11,
    padding: "8px 16px",
    color: "#b91c1c",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 12,
    background: "#ffffff",
    borderTop: "1px solid #fecaca",
  },
};

createRoot(document.getElementById("root")!).render(<AgentsWebchat />);
