/**
 * Agent Chat Component
 *
 * Connects to an event stream, persists events to localStorage,
 * and renders a conversation feed via the messages reducer.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  messagesReducer,
  createInitialState,
  type MessagesState,
  type FeedItem,
  type MessageFeedItem,
} from "@/reducers/messages-reducer";
import { usePersistentStream, excludeTypes } from "@/hooks/use-persistent-stream";
import { cn } from "@/lib/utils";

const API_URL = "/api";

interface AgentChatProps {
  streamName: string;
}

export function AgentChat({ streamName }: AgentChatProps) {
  const [input, setInput] = useState("");
  const [showEvents, setShowEvents] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Use persistent stream with localStorage
  const { state, isStreaming, isReady, reset, offset } = usePersistentStream<
    MessagesState,
    { type: string; [key: string]: unknown }
  >({
    url: `${API_URL}/streams/${streamName}/subscribe`,
    reducer: messagesReducer,
    initialState: createInitialState(),
    storageKey: `agent:${streamName}`,
    // Don't persist streaming chunks (message_update) - they're transient
    shouldPersist: excludeTypes("message_update"),
  });

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state.feed, state.streamingMessage]);

  // Send a message
  const sendMessage = useCallback(
    async (text: string) => {
      if (!text.trim()) return;

      await fetch(`${API_URL}/streams/${streamName}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          data: {
            type: "iterate:agent:harness:pi:action:prompt:called",
            payload: { content: text },
          },
        }),
      });
    },
    [streamName],
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    sendMessage(input);
    setInput("");
  };

  const renderFeedItem = (item: FeedItem, streaming = false) => {
    if (item.kind === "message") {
      const message = item as MessageFeedItem;
      const isUser = message.role === "user";
      const text = message.content.map((c) => c.text).join("\n");

      return (
        <div
          className={cn(
            "max-w-[80%] rounded-lg px-4 py-2",
            isUser ? "ml-auto bg-blue-600 text-white" : "bg-gray-700 text-gray-100",
          )}
        >
          <div className="text-xs text-gray-400 mb-1">{message.role}</div>
          <div className="whitespace-pre-wrap">{text}</div>
          {streaming && <span className="animate-pulse">▌</span>}
        </div>
      );
    }

    if (item.kind === "error") {
      return (
        <div className="bg-red-900/50 border border-red-500 rounded-lg px-4 py-2 text-red-200">
          <div className="text-xs text-red-400 mb-1">Error</div>
          <div>{item.message}</div>
          {item.context && <div className="text-xs mt-1 text-red-300">Context: {item.context}</div>}
        </div>
      );
    }

    // Event item - compact form
    return <div className="text-xs text-gray-500 py-1 font-mono">[{item.eventType}]</div>;
  };

  if (!isReady) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-gray-400">Connecting to stream...</div>
      </div>
    );
  }

  const messages = state.feed.filter((item) => item.kind === "message");

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 p-4 border-b border-gray-700">
        <span className={cn("w-2 h-2 rounded-full", isReady ? "bg-green-500" : "bg-red-500")} />
        <span className="text-sm text-gray-400">
          {isReady ? "Connected" : "Disconnected"} - {streamName}
        </span>
        {(isStreaming || state.isStreaming) && (
          <span className="text-xs text-blue-400 animate-pulse">Streaming...</span>
        )}
        <div className="flex-1" />
        <button
          onClick={() => setShowEvents(!showEvents)}
          className={cn(
            "px-2 py-1 text-xs rounded",
            showEvents ? "bg-gray-600" : "bg-gray-800 hover:bg-gray-700",
          )}
        >
          {showEvents ? "Hide Events" : "Show Events"}
        </button>
        <button
          onClick={reset}
          className="px-2 py-1 text-xs bg-gray-800 hover:bg-gray-700 rounded"
          title="Clear stored events and reload"
        >
          Reset
        </button>
        <span className="text-xs text-gray-600 font-mono" title="Current offset">
          @{offset.slice(-8)}
        </span>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {(showEvents ? state.feed : messages).map((item, i) => (
          <div key={`${item.kind}-${i}`}>{renderFeedItem(item)}</div>
        ))}
        {state.streamingMessage && (
          <div key="streaming">{renderFeedItem(state.streamingMessage, true)}</div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="p-4 border-t border-gray-700">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a message..."
            className="flex-1 px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
          />
          <button
            type="submit"
            disabled={!input.trim() || !isReady}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed rounded-lg text-white"
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
