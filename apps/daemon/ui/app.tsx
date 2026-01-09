// Suppress transient network errors from SSE reconnection during navigation

/* eslint-disable react-refresh/only-export-components -- not sure if this is actually bad */

window.addEventListener("unhandledrejection", (e) => {
  if (e.reason instanceof TypeError && e.reason.message === "network error") {
    e.preventDefault();
  }
});

import { createRoot } from "react-dom/client";
import { useState, useReducer, useEffect, useRef, useCallback, Suspense } from "react";

const IS_STANDALONE = !window.location.pathname.startsWith("/daemon");
const BASE_PATH = IS_STANDALONE ? "" : "/daemon";
const UI_PATH = IS_STANDALONE ? "/ui" : "/daemon/ui";
const API_URL = window.location.origin + BASE_PATH;

import {
  messagesReducer,
  createInitialState,
  type MessagesState,
  type FeedItem,
  type MessageFeedItem,
  type EventFeedItem,
  type ContentBlock,
} from "./messages-reducer.ts";
import { usePersistentStream, excludeTypes } from "./persistent-stream-reducer.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface AgentInfo {
  path: string;
  contentType: string;
  createdAt: string;
}

interface RegistryEvent {
  type: string;
  key: string;
  value?: AgentInfo;
  headers?: { operation: string };
}

// ─────────────────────────────────────────────────────────────────────────────
// Routing
// ─────────────────────────────────────────────────────────────────────────────

function parseAgentFromPath(): string | null {
  const pathname = window.location.pathname;
  if (pathname === BASE_PATH || pathname === BASE_PATH + "/") {
    window.history.replaceState({}, "", UI_PATH);
  }
  const agentPattern = new RegExp(`^${UI_PATH}/agents/(.+)$`);
  const match = pathname.match(agentPattern);
  return match ? decodeURIComponent(match[1]) : null;
}

function navigateToAgent(agentId: string | null) {
  const newPath = agentId ? `${UI_PATH}/agents/${encodeURIComponent(agentId)}` : UI_PATH;
  if (window.location.pathname !== newPath) {
    window.history.pushState({}, "", newPath);
  }
}

function useRouter(): [string | null, (id: string | null) => void] {
  const [agentId, setAgentId] = useState(parseAgentFromPath);

  useEffect(() => {
    const onPopState = () => setAgentId(parseAgentFromPath());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((id: string | null) => {
    navigateToAgent(id);
    setAgentId(id);
  }, []);

  return [agentId, navigate];
}

// ─────────────────────────────────────────────────────────────────────────────
// API helpers
// ─────────────────────────────────────────────────────────────────────────────

async function createAgent(name: string): Promise<boolean> {
  const res = await fetch(`${API_URL}/agents/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
  });
  return res.ok;
}

async function deleteAgent(name: string): Promise<boolean> {
  const res = await fetch(`${API_URL}/agents/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
  return res.ok || res.status === 204;
}

async function sendMessage(agentPath: string, text: string): Promise<boolean> {
  const res = await fetch(`${API_URL}/agents/${encodeURIComponent(agentPath)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "message", message: text }),
  });
  return res.ok;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reducers
// ─────────────────────────────────────────────────────────────────────────────

function registryReducer(state: AgentInfo[], event: RegistryEvent): AgentInfo[] {
  if (event.headers?.operation === "insert" && event.value) {
    return state.some((a) => a.path === event.value!.path) ? state : [...state, event.value];
  }
  if (event.headers?.operation === "delete") {
    return state.filter((a) => a.path !== event.key);
  }
  return state;
}

// messagesReducer is imported from ./messages-reducer

// ─────────────────────────────────────────────────────────────────────────────
// Hooks
// ─────────────────────────────────────────────────────────────────────────────

interface StreamState<T> {
  data: T;
  isLoaded: boolean;
}

function useStreamReducer<T, E>(
  streamUrl: string | null,
  reducer: (state: T, event: E) => T,
  initialState: T,
): StreamState<T> {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [isLoaded, setIsLoaded] = useState(false);
  const offsetRef = useRef("-1");

  useEffect(() => {
    if (!streamUrl) return;

    setIsLoaded(false);
    const url = new URL(streamUrl);
    url.searchParams.set("offset", offsetRef.current);
    url.searchParams.set("live", "sse");

    const es = new EventSource(url.toString());

    es.addEventListener("control", (evt) => {
      try {
        const ctrl = JSON.parse(evt.data);
        if (ctrl.streamNextOffset) offsetRef.current = ctrl.streamNextOffset;
        if (ctrl.upToDate) setIsLoaded(true);
      } catch {}
    });

    // Handle data events from the SSE stream (backend uses "data" event name)
    es.addEventListener("data", (evt) => {
      try {
        const data = JSON.parse(evt.data);
        // Backend wraps content in an array: [message.content]
        if (Array.isArray(data)) {
          for (const item of data) {
            dispatch(item);
          }
        } else {
          dispatch(data);
        }
      } catch {}
    });

    return () => es.close();
  }, [streamUrl]);

  return { data: state, isLoaded };
}

// ─────────────────────────────────────────────────────────────────────────────
// Components
// ─────────────────────────────────────────────────────────────────────────────

function Sidebar({
  agents,
  selectedAgent,
  onSelect,
  onDelete,
  onCreate,
}: {
  agents: AgentInfo[];
  selectedAgent: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onCreate: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    const ok = await createAgent(trimmed);
    setCreating(false);
    if (ok) {
      setName("");
      onCreate(trimmed);
    }
  };

  return (
    <aside className="w-72 bg-zinc-900 border-r border-zinc-800 flex flex-col">
      <header className="p-4 border-b border-zinc-800">
        <h1 className="text-lg font-semibold tracking-tight text-zinc-100 mb-3">Agents</h1>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleCreate();
            }
          }}
          placeholder="New agent name..."
          disabled={creating}
          className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all disabled:opacity-50"
        />
      </header>

      <nav className="flex-1 overflow-y-auto p-2">
        {agents.length === 0 ? (
          <p className="text-zinc-500 text-sm text-center py-6">No agents yet</p>
        ) : (
          <ul className="space-y-1">
            {[...agents]
              .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
              .map((a) => (
                <li key={a.path}>
                  <button
                    onClick={() => onSelect(a.path)}
                    className={`group w-full flex items-center justify-between px-3 py-2 rounded-lg text-left text-sm transition-colors ${
                      selectedAgent === a.path
                        ? "bg-indigo-600 text-white"
                        : "text-zinc-300 hover:bg-zinc-800"
                    }`}
                  >
                    <span className="truncate">{a.path}</span>
                    <span
                      role="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(a.path);
                      }}
                      className={`opacity-0 group-hover:opacity-100 ml-2 px-1.5 rounded transition-opacity ${
                        selectedAgent === a.path
                          ? "text-indigo-200 hover:text-white"
                          : "text-zinc-500 hover:text-red-400"
                      }`}
                    >
                      ×
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        )}
      </nav>
    </aside>
  );
}

function getMessageText(content: ContentBlock[]): string {
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function MessageBubble({ msg, isStreaming }: { msg: MessageFeedItem; isStreaming?: boolean }) {
  const isUser = msg.role === "user";
  const text = getMessageText(msg.content);
  const timeStr = new Date(msg.timestamp).toLocaleTimeString();

  return (
    <div
      className={`flex ${isUser ? "justify-end" : "justify-start"}`}
      data-testid="chat-message"
      data-role={msg.role}
    >
      <div
        className={`max-w-[75%] rounded-2xl px-4 py-3 ${
          isUser
            ? "bg-indigo-600 text-white"
            : isStreaming
              ? "bg-zinc-800 border border-indigo-500"
              : "bg-zinc-800 text-zinc-100"
        }`}
      >
        <div
          className={`text-xs mb-1 flex items-center gap-2 ${isUser ? "text-indigo-200" : "text-zinc-500"}`}
        >
          <span>{isUser ? "You" : "Assistant"}</span>
          <span className={isUser ? "text-indigo-300/60" : "text-zinc-600"}>·</span>
          <span className={isUser ? "text-indigo-300/60" : "text-zinc-600"}>{timeStr}</span>
          {isStreaming && <span className="ml-1 animate-pulse">●</span>}
        </div>
        <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
          {text || (
            <span className="text-zinc-500 italic">{isStreaming ? "Thinking..." : "Empty"}</span>
          )}
        </div>
      </div>
    </div>
  );
}

function EventLine({ event }: { event: EventFeedItem }) {
  const [expanded, setExpanded] = useState(false);
  const timeStr = new Date(event.timestamp).toLocaleTimeString();

  return (
    <div className="flex flex-col">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-xs text-zinc-500 hover:text-zinc-400 transition-colors py-0.5 cursor-pointer"
      >
        <span className="text-zinc-600">{expanded ? "▼" : "▶"}</span>
        <span className="font-mono">{event.eventType}</span>
        <span className="text-zinc-600">·</span>
        <span className="text-zinc-600">{timeStr}</span>
      </button>
      {expanded && (
        <pre className="text-xs bg-zinc-800/50 p-2 rounded mt-1 mb-2 overflow-x-auto font-mono text-zinc-400 border border-zinc-700/50">
          {JSON.stringify(event.raw, null, 2)}
        </pre>
      )}
    </div>
  );
}

function FeedItemRenderer({ item, isStreaming }: { item: FeedItem; isStreaming?: boolean }) {
  if (item.kind === "message") {
    return <MessageBubble msg={item} isStreaming={isStreaming} />;
  }
  return <EventLine event={item} />;
}

function AgentChat({ agentPath }: { agentPath: string }) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const {
    state: { feed, isStreaming: stateIsStreaming, streamingMessage, rawEvents },
    isStreaming: hookIsStreaming,
    isLeader,
    reset,
    offset,
  } = usePersistentStream<MessagesState, { type: string; [key: string]: unknown }>({
    url: `${API_URL}/agents/${encodeURIComponent(agentPath)}`,
    storageKey: `agent:${agentPath}`,
    reducer: messagesReducer,
    initialState: createInitialState(),
    shouldPersist: excludeTypes("message_update"),
    suspense: false,
  });

  const isStreaming = stateIsStreaming || hookIsStreaming;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [feed, streamingMessage]);

  // Focus input when navigating to agent
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setInput("");
    await sendMessage(agentPath, text);
    setSending(false);
    inputRef.current?.focus();
  };

  return (
    <div className="flex flex-col h-full">
      <header className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/50 backdrop-blur-sm">
        <h2 className="text-lg font-medium text-zinc-100">{agentPath}</h2>
        <div className="flex items-center gap-3">
          {isStreaming && (
            <span className="text-xs text-indigo-400 animate-pulse">● Streaming</span>
          )}
          <span className="text-xs text-zinc-600" title={`Offset: ${offset}`}>
            {isLeader ? "👑" : "📡"}
          </span>
          <button
            onClick={reset}
            className="text-xs px-2 py-1 rounded-md bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors"
            title="Clear persisted data"
          >
            Reset
          </button>
          <button
            onClick={() => setShowRaw(!showRaw)}
            className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
              showRaw ? "bg-indigo-600 text-white" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {showRaw ? "Chat" : "Raw"} ({rawEvents.length})
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto p-6 space-y-2">
        {showRaw ? (
          rawEvents.length === 0 ? (
            <p className="text-zinc-500 text-center py-8">No events yet</p>
          ) : (
            rawEvents.map((evt, i) => (
              <pre
                key={i}
                className="text-xs bg-zinc-800 p-3 rounded-lg overflow-x-auto font-mono text-zinc-300"
              >
                {JSON.stringify(evt, null, 2)}
              </pre>
            ))
          )
        ) : feed.length === 0 && !streamingMessage ? (
          <div className="flex flex-col items-center justify-center h-full text-zinc-500">
            <div className="text-4xl mb-2">💬</div>
            <p>Start a conversation</p>
          </div>
        ) : (
          <>
            {feed.map((item, i) => (
              <FeedItemRenderer key={i} item={item} />
            ))}
            {streamingMessage && <MessageBubble msg={streamingMessage} isStreaming />}
          </>
        )}
        <div ref={endRef} />
      </main>

      <footer className="p-4 border-t border-zinc-800 bg-zinc-900/50 backdrop-blur-sm">
        <div className="flex gap-3 max-w-4xl mx-auto">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
            placeholder="Type a message..."
            disabled={sending}
            className="flex-1 px-4 py-2.5 bg-zinc-800 border border-zinc-700 rounded-xl text-sm placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all disabled:opacity-50"
          />
          <button
            onClick={handleSend}
            disabled={sending || !input.trim()}
            className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-700 disabled:text-zinc-500 rounded-xl text-sm font-medium transition-colors"
          >
            {sending ? "..." : "Send"}
          </button>
        </div>
      </footer>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-zinc-500">
      <div className="text-6xl mb-4">🤖</div>
      <p className="text-lg">Select or create an agent to begin</p>
      <p className="text-sm mt-1 text-zinc-600">Use the sidebar to get started</p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// App
// ─────────────────────────────────────────────────────────────────────────────

function App() {
  const [selectedAgent, setSelectedAgent] = useRouter();
  const [agentReady, setAgentReady] = useState(false);
  const { data: agents, isLoaded: registryLoaded } = useStreamReducer<AgentInfo[], RegistryEvent>(
    `${API_URL}/agents/__registry__`,
    registryReducer,
    [],
  );

  // Auto-create agent if navigating to non-existent one
  // Wait for agent to exist before rendering AgentChat to avoid SSE race condition
  useEffect(() => {
    if (!selectedAgent) {
      setAgentReady(false);
      return;
    }
    const exists = agents.some((a) => a.path === selectedAgent);
    if (exists) {
      setAgentReady(true);
    } else {
      // Create the agent if it doesn't exist
      // (even if registry isn't loaded - handles 404 case)
      setAgentReady(false);
      createAgent(selectedAgent).then((ok) => {
        // Show chat even if creation failed (e.g., 404 registry)
        // The chat will handle its own SSE connection
        if (ok || !registryLoaded) {
          setAgentReady(true);
        }
      });
    }
  }, [selectedAgent, agents, registryLoaded]);

  const handleDelete = async (path: string) => {
    if (!confirm(`Delete agent "${path}"?`)) return;
    const ok = await deleteAgent(path);
    if (ok && selectedAgent === path) {
      setSelectedAgent(null);
    }
  };

  // Only render AgentChat once the agent exists in the registry
  const shouldShowChat = selectedAgent && agentReady;

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100">
      <Sidebar
        agents={agents}
        selectedAgent={selectedAgent}
        onSelect={setSelectedAgent}
        onDelete={handleDelete}
        onCreate={setSelectedAgent}
      />
      <main className="flex-1 bg-zinc-900">
        {shouldShowChat ? (
          <AgentChat key={selectedAgent} agentPath={selectedAgent} />
        ) : selectedAgent ? (
          <div className="flex flex-col items-center justify-center h-full text-zinc-500">
            <div className="animate-pulse text-2xl">⏳</div>
            <p className="mt-2">Creating agent...</p>
          </div>
        ) : (
          <EmptyState />
        )}
      </main>
    </div>
  );
}

// Mount
createRoot(document.getElementById("root")!).render(<App />);
