// A dead-simple chat view over an agent's stream: it renders only the
// conversation turns (the user's messages and the agent's visible replies),
// not the raw event firehose. The data layer is the same live browser
// stream runtime ProjectStreamView uses; we just SQL-filter the events table
// to the two chat event types and render bubbles.
//
// User messages are `agent-chat/user-message-added`; the agent's visible
// replies are `agent-chat/assistant-response-added` (what itx.chat.sendMessage
// emits). Everything else on the stream (LLM I/O, capability notes, websocket
// frames) is intentionally not shown here — the raw stream view is one tab
// over for debugging.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  acquireStreamRuntime,
  type StreamBrowserSnapshot,
} from "@iterate-com/streams/browser/stream-browser-store";
import { useStreamQuery } from "@iterate-com/streams/browser/hooks/use-stream-query";
import { browserProcessorStateStorage } from "@iterate-com/streams/browser/processor-state-storage";
import {
  BROWSER_RAW_EVENTS_SCHEMA_VERSION,
  BrowserRawEventsContract,
  BrowserRawEventsProcessor,
  type BrowserRawEventsState,
} from "@iterate-com/streams/processors/browser-raw-events/implementation";
import { Button } from "@iterate-com/ui/components/button";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { Textarea } from "@iterate-com/ui/components/textarea";
import { cn } from "@iterate-com/ui/lib/utils";
import { projectStreamRpcPath } from "~/lib/stream-links.ts";

const USER_MESSAGE = "events.iterate.com/agent-chat/user-message-added";
const ASSISTANT_RESPONSE = "events.iterate.com/agent-chat/assistant-response-added";
// A finished LLM turn — emitted regardless of channel, so it ends "Thinking…"
// even when the agent replied via Slack or produced no visible message.
const LLM_REQUEST_COMPLETED = "events.iterate.com/agent/llm-request-completed";

type ChatTurn = { offset: number; role: "user" | "agent"; text: string };

export function AgentChatView(props: {
  projectSlugOrId: string;
  /** The agent's stream path, e.g. "/agents/support". */
  agentPath: string;
  /** Append a user message to the agent (the route wires the orpc mutation). */
  onSend: (message: string) => Promise<void>;
}) {
  const store = useMemo(
    () =>
      acquireStreamRuntime({
        namespace: props.projectSlugOrId,
        streamPath: props.agentPath,
        streamUrl: projectStreamRpcPath(props.projectSlugOrId, props.agentPath),
        slug: BrowserRawEventsContract.slug,
        schemaVersion: BROWSER_RAW_EVENTS_SCHEMA_VERSION,
        tables: ["events"],
        createProcessor({ stream, sql, subscriptionKey }) {
          const storage = browserProcessorStateStorage<BrowserRawEventsState>({
            sql,
            processorSlug: BrowserRawEventsContract.slug,
            subscriptionKey,
          });
          return new BrowserRawEventsProcessor({
            iterateContext: { stream },
            sql,
            readState: storage.readState,
            writeState: storage.writeState,
          });
        },
      }),
    [props.projectSlugOrId, props.agentPath],
  );
  const snapshot = useSyncExternalStore<StreamBrowserSnapshot>(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );

  // The two chat event types, oldest-first. raw_jsonb holds the full event;
  // pull the one text field each kind carries.
  const rows = useStreamQuery(
    store.streamDatabase,
    `SELECT offset, type,
            json_extract(raw_jsonb, '$.payload.content') AS content,
            json_extract(raw_jsonb, '$.payload.message') AS message
       FROM events
      WHERE type IN (?, ?)
      ORDER BY offset ASC`,
    [USER_MESSAGE, ASSISTANT_RESPONSE],
  );

  const turns: ChatTurn[] = rows.data.map((row) => ({
    offset: Number(row.offset),
    role: row.type === USER_MESSAGE ? "user" : "agent",
    text: String((row.type === USER_MESSAGE ? row.content : row.message) ?? ""),
  }));

  // "Thinking" must clear when the agent's LLM turn FINISHES, not only when it
  // emits a chat reply — Slack agents reply via Slack (no chat event here) and
  // a web turn can end with an empty code block. So: a reply is owed iff the
  // newest user message is more recent than the newest turn-completion signal
  // (an assistant reply OR an llm-request-completed).
  const progress = useStreamQuery(
    store.streamDatabase,
    `SELECT
       (SELECT MAX(offset) FROM events WHERE type = ?) AS last_user,
       (SELECT MAX(offset) FROM events WHERE type IN (?, ?)) AS last_done`,
    [USER_MESSAGE, ASSISTANT_RESPONSE, LLM_REQUEST_COMPLETED],
  );
  const lastUser = Number(progress.data[0]?.last_user ?? 0);
  const lastDone = Number(progress.data[0]?.last_done ?? 0);
  const awaitingReply = lastUser > 0 && lastUser > lastDone;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Transcript turns={turns} awaitingReply={awaitingReply} status={snapshot.connectionStatus} />
      <Composer onSend={props.onSend} />
    </div>
  );
}

function Transcript(props: { turns: ChatTurn[]; awaitingReply: boolean; status: string }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  // Keep the newest turn in view as the conversation grows.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [props.turns.length, props.awaitingReply]);

  if (props.turns.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        {props.status === "subscribed"
          ? "Say hello to start the conversation."
          : `Connecting… (${props.status})`}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6">
      <div className="mx-auto flex max-w-2xl flex-col gap-4">
        {props.turns.map((turn) => (
          <Bubble key={turn.offset} role={turn.role} text={turn.text} />
        ))}
        {props.awaitingReply ? (
          <div className="flex items-center gap-2 self-start text-sm text-muted-foreground">
            <Spinner className="size-4" /> Thinking…
          </div>
        ) : null}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function Bubble(props: { role: "user" | "agent"; text: string }) {
  const isUser = props.role === "user";
  return (
    <div
      className={cn(
        "max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm",
        isUser
          ? "self-end bg-primary text-primary-foreground"
          : "self-start bg-muted text-foreground",
      )}
    >
      {props.text}
    </div>
  );
}

function Composer(props: { onSend: (message: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  async function send() {
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    try {
      await props.onSend(message);
      setText("");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="border-t p-3">
      <div className="mx-auto flex max-w-2xl items-end gap-2">
        <Textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends; Shift+Enter is a newline.
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder="Message this agent…"
          rows={1}
          className="max-h-40 min-h-10 flex-1 resize-none"
        />
        <Button onClick={() => void send()} disabled={sending || text.trim() === ""}>
          {sending ? <Spinner className="size-4" /> : "Send"}
        </Button>
      </div>
    </div>
  );
}
