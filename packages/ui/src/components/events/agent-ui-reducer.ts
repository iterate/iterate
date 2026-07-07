import type { Event } from "./types.ts";

// ---------------------------------------------------------------------------
// Reduced state model + pure batch planner
//
// The agent UI is a clean chat: user message → activity ("Ran code 2× · 3
// requests · 7.4 s") → assistant message, with quiet stream wake dividers.
// SETTLED items are emitted as ops that the agent-ui processor writes into
// the `agent_feed_items` SQLite table (the TanStack virtual list reads those
// rows); the reduced state holds only what is still in flight — the live
// activity with partially streamed thinking/response text, the presence
// roster, and the next dense row index. The live part renders as one element
// below the list, straight from this state, and exists only while work is
// active.
//
// Mirrors `browser-event-feed`'s planFeedOps contract: `reduce` advances
// state one event at a time, `processEventBatch` plans the whole batch from
// the same entry state to produce one idempotent SQLite transaction.
// ---------------------------------------------------------------------------

export type AgentUiLlmStep = {
  kind: "llm";
  id: string;
  llmRequestId: number;
  status: "running" | "done";
  model?: string;
  provider?: string;
  /** Streamed reasoning summary ("thinking") text. */
  thinkingText: string;
  /** Streamed response text — for code-mode agents this is source code. */
  responseText: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  outcome?: "completed" | "failed" | "cancelled";
  errorMessage?: string;
  providerResponseId?: string;
  startedAtMs: number;
};

export type AgentUiCodeStep = {
  kind: "code";
  id: string;
  executionId: string;
  status: "running" | "done";
  code: string;
  result?: unknown;
  errorMessage?: string;
  logs?: string[];
  durationMs?: number;
  success?: boolean;
  startedAtMs: number;
};

export type AgentUiStep = AgentUiLlmStep | AgentUiCodeStep;

export type AgentUiActivity = {
  kind: "activity";
  id: string;
  status: "running" | "done";
  steps: AgentUiStep[];
  startedAtMs: number;
  endedAtMs?: number;
};

/** A file attachment shown alongside a user message in the agent UI. */
export type AgentUiFileAttachment = {
  contentType: string;
  filename: string;
  path: string;
  size: number;
  url: string;
};

export type AgentUiMessageItem = {
  kind: "user" | "assistant";
  id: string;
  text: string;
  timestampMs: number;
  files?: AgentUiFileAttachment[];
};

export type AgentUiStreamWakeItem = {
  kind: "stream-woken";
  id: string;
  text: string;
  timestampMs: number;
};

export type AgentUiChildStreamItem = {
  kind: "child-stream-created";
  id: string;
  childPath: string;
  timestampMs: number;
};

export type AgentUiItem =
  | AgentUiMessageItem
  | AgentUiActivity
  | AgentUiStreamWakeItem
  | AgentUiChildStreamItem;

export type AgentUiProcessorAnnouncement = {
  slug: string;
  version: string;
  description: string;
  consumes: string[];
  emits: string[];
  ownedEvents: Array<{ type: string; description?: string }>;
};

export type AgentUiPresenceEntry = {
  subscriptionKey: string;
  direction: "inbound" | "outbound";
  connected: boolean;
  description?: string;
  processor?: AgentUiProcessorAnnouncement;
};

export type AgentUiState = {
  /** The running activity (streaming thinking/code), or null when no work is active. */
  live: AgentUiActivity | null;
  /** User messages that landed while the current request was already running. */
  queuedUserMessages: AgentUiMessageItem[];
  eventCount: number;
  /** Connection roster reduced from subscriber-connected/disconnected facts. */
  presence: AgentUiPresenceEntry[];
  /** Dense, monotonically increasing next agent_feed_items local_index. */
  nextLocalIndex: number;
};

export function initialAgentUiState(): AgentUiState {
  return { live: null, queuedUserMessages: [], eventCount: 0, presence: [], nextLocalIndex: 0 };
}

/** One settled item to upsert at a dense list position. */
export type AgentUiOp = { localIndex: number; item: AgentUiItem };

/**
 * Fold a batch of events into settled-item ops + the resulting state.
 * Idempotent by construction: replaying the same events from the same entry
 * state yields the same ops, and the processor upserts by local_index.
 */
export function planAgentUiOps(
  start: AgentUiState,
  events: readonly Event[],
): { endState: AgentUiState; ops: AgentUiOp[] } {
  const ops: AgentUiOp[] = [];
  let state = start;
  for (const event of events) state = reduceAgentUiEvent(state, event, ops);
  return { endState: state, ops };
}

/** Append a settled item op at the next dense position. */
function emitItem(state: AgentUiState, ops: AgentUiOp[], item: AgentUiItem): AgentUiState {
  ops.push({ localIndex: state.nextLocalIndex, item });
  return { ...state, nextLocalIndex: state.nextLocalIndex + 1 };
}

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

const AGENT_LLM_REQUEST_REQUESTED = "events.iterate.com/agent/llm-request-requested";
const AGENT_LLM_REQUEST_COMPLETED = "events.iterate.com/agent/llm-request-completed";
const AGENT_LLM_REQUEST_CANCELLED = "events.iterate.com/agent/llm-request-cancelled";
const AGENT_OUTPUT_ADDED = "events.iterate.com/agent/output-added";
const AGENT_INPUT_ADDED = "events.iterate.com/agent/input-added";
const AGENT_STATUS_UPDATED = "events.iterate.com/agent/status-updated";
const OPENAI_WS_REQUEST_STARTED = "events.iterate.com/openai-ws/llm-request-started";
// The openai-ws processor journals every raw Responses-WS frame as
// llm-response-chunk ({llmRequestId, sequence, chunk}); the frames stream
// into the live activity below.
const OPENAI_WS_RESPONSE_CHUNK = "events.iterate.com/openai-ws/llm-response-chunk";
const CLOUDFLARE_AI_REQUEST_STARTED = "events.iterate.com/cloudflare-ai/llm-request-started";
const CLOUDFLARE_AI_RESPONSE_CHUNK = "events.iterate.com/cloudflare-ai/llm-response-chunk";
const SCRIPT_EXECUTION_REQUESTED = "events.iterate.com/capability-host/script-execution-requested";
const SCRIPT_EXECUTION_COMPLETED = "events.iterate.com/capability-host/script-execution-completed";
const CODEMODE_SCRIPT_EXECUTION_REQUESTED =
  "events.iterate.com/codemode/script-execution-requested";
const CODEMODE_SCRIPT_EXECUTION_COMPLETED =
  "events.iterate.com/codemode/script-execution-completed";
const STREAM_SUBSCRIBER_CONNECTED = "events.iterate.com/stream/subscriber-connected";
const STREAM_SUBSCRIBER_DISCONNECTED = "events.iterate.com/stream/subscriber-disconnected";
const STREAM_WOKEN = "events.iterate.com/stream/woken";
const STREAM_CHILD_STREAM_CREATED = "events.iterate.com/stream/child-stream-created";
const STREAM_WAKE_LABEL = "Stream durable object woke";

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function reduceAgentUiEvent(previous: AgentUiState, event: Event, ops: AgentUiOp[]): AgentUiState {
  const state: AgentUiState = {
    ...previous,
    queuedUserMessages: previous.queuedUserMessages ?? [],
    eventCount: previous.eventCount + 1,
  };
  const timestampMs = Date.parse(event.createdAt);

  switch (event.type) {
    case "events.iterate.com/agents/user-message-received": {
      const text = readString(event, "content");
      if (text == null) return state;
      return emitUserMessageItem(state, ops, {
        kind: "user",
        id: `user-${event.offset}`,
        text,
        timestampMs,
      });
    }

    case AGENT_INPUT_ADDED: {
      const text = readString(event, "content");
      const files = readFileAttachments(event);
      if (text == null || files.length === 0) return state;
      // Reflections of the agent's own sent messages (the processor's
      // "The assistant sent this visible web-chat message" inputs, keyed
      // agent/render-web-response@<offset>) carry the SAME attachments the
      // web-message-sent event already rendered as an assistant bubble —
      // they exist for the model's eyes, not the user's.
      if (event.idempotencyKey?.startsWith("agent/render-web-response@")) return state;
      return emitUserMessageItem(state, ops, {
        kind: "user",
        id: `user-file-${event.offset}`,
        text,
        files,
        timestampMs,
      });
    }

    case "events.iterate.com/agents/web-message-sent":
    case "events.iterate.com/agents/tui-message-sent": {
      const text = readString(event, "message");
      if (text == null) return state;
      const files = readFileAttachments(event);
      const item: AgentUiMessageItem = {
        kind: "assistant",
        id: `assistant-${event.offset}`,
        text,
        ...(files.length === 0 ? {} : { files }),
        timestampMs,
      };
      return emitItem(state, ops, item);
    }

    case AGENT_LLM_REQUEST_REQUESTED: {
      const base =
        state.queuedUserMessages.length === 0
          ? state
          : flushQueuedUserMessages(settleLiveIfIdle(state, timestampMs, ops), ops);
      const live = ensureLive(base, event.offset, timestampMs);
      const model = readString(event, "model");
      const step: AgentUiLlmStep = {
        kind: "llm",
        id: `llm-${event.offset}`,
        llmRequestId: event.offset,
        status: "running",
        ...(model == null ? {} : { model }),
        thinkingText: "",
        responseText: "",
        startedAtMs: timestampMs,
      };
      return { ...base, live: { ...live, steps: [...live.steps, step] } };
    }

    case OPENAI_WS_REQUEST_STARTED:
    case CLOUDFLARE_AI_REQUEST_STARTED: {
      const llmRequestId = readNumber(event, "llmRequestId");
      const model = readString(event, "model");
      if (llmRequestId == null || model == null) return state;
      return updateLlmStep(state, llmRequestId, (step) => ({ ...step, model }));
    }

    case OPENAI_WS_RESPONSE_CHUNK: {
      const llmRequestId = readNumber(event, "llmRequestId");
      const message = readRecord(event, "chunk");
      if (llmRequestId == null || message == null) return state;
      const frameType = typeof message.type === "string" ? message.type : "";
      const delta = typeof message.delta === "string" ? message.delta : "";

      if (frameType === "response.output_text.delta" && delta !== "") {
        return updateLlmStep(state, llmRequestId, (step) => ({
          ...step,
          responseText: step.status === "running" ? step.responseText + delta : step.responseText,
        }));
      }
      if (
        (frameType === "response.reasoning_summary_text.delta" ||
          frameType === "response.reasoning_text.delta") &&
        delta !== ""
      ) {
        return updateLlmStep(state, llmRequestId, (step) => ({
          ...step,
          thinkingText: step.status === "running" ? step.thinkingText + delta : step.thinkingText,
        }));
      }
      if (frameType === "response.reasoning_summary_part.added") {
        return updateLlmStep(state, llmRequestId, (step) => ({
          ...step,
          thinkingText:
            step.status !== "running" || step.thinkingText === ""
              ? step.thinkingText
              : `${step.thinkingText}\n\n`,
        }));
      }
      return state;
    }

    case CLOUDFLARE_AI_RESPONSE_CHUNK: {
      const llmRequestId = readNumber(event, "llmRequestId");
      const chunk = readPayloadRecord(event)?.chunk;
      if (llmRequestId == null) return state;
      const { responseDelta, thinkingDelta } = extractCloudflareChunkDeltas(chunk);
      if (responseDelta === "" && thinkingDelta === "") return state;
      return updateLlmStep(state, llmRequestId, (step) => ({
        ...step,
        responseText:
          step.status === "running" ? step.responseText + responseDelta : step.responseText,
        thinkingText:
          step.status === "running" ? step.thinkingText + thinkingDelta : step.thinkingText,
      }));
    }

    case AGENT_OUTPUT_ADDED: {
      const llmRequestId = readNumber(event, "llmRequestId");
      const content = readString(event, "content");
      if (llmRequestId == null || content == null) return state;
      // Authoritative full text: replaces whatever streamed in (or fills it
      // in for providers that never streamed).
      return updateLlmStep(state, llmRequestId, (step) =>
        step.status === "running" ? { ...step, responseText: content } : step,
      );
    }

    case AGENT_LLM_REQUEST_COMPLETED: {
      const llmRequestId = readNumber(event, "llmRequestId");
      if (llmRequestId == null) return state;
      const payload = readPayloadRecord(event);
      const result = isRecord(payload?.result) ? payload.result : undefined;
      const status = typeof result?.status === "string" ? result.status : "success";
      const usage = readUsageTokens(result?.usage);
      const errorMessage =
        isRecord(result?.error) && typeof result.error.message === "string"
          ? result.error.message
          : undefined;
      return settleLiveIfIdle(
        updateLlmStep(state, llmRequestId, (step) =>
          step.outcome === "cancelled"
            ? step
            : {
                ...step,
                status: "done",
                outcome: status === "success" ? "completed" : "failed",
                ...(typeof payload?.provider === "string" ? { provider: payload.provider } : {}),
                ...(typeof payload?.durationMs === "number"
                  ? { durationMs: payload.durationMs }
                  : {}),
                ...(usage.input == null ? {} : { inputTokens: usage.input }),
                ...(usage.output == null ? {} : { outputTokens: usage.output }),
                ...(errorMessage == null ? {} : { errorMessage }),
                ...(typeof result?.providerResponseId === "string"
                  ? { providerResponseId: result.providerResponseId }
                  : {}),
              },
        ),
        timestampMs,
        ops,
      );
    }

    case AGENT_LLM_REQUEST_CANCELLED: {
      const llmRequestId = readNumber(event, "llmRequestId");
      if (llmRequestId == null) return state;
      return settleLiveIfIdle(
        updateLlmStep(state, llmRequestId, (step) => ({
          ...step,
          status: "done",
          outcome: "cancelled",
        })),
        timestampMs,
        ops,
      );
    }

    case SCRIPT_EXECUTION_REQUESTED:
    case CODEMODE_SCRIPT_EXECUTION_REQUESTED: {
      const payload = readPayloadRecord(event);
      const executionId =
        typeof payload?.executionId === "string" ? payload.executionId : `exec-${event.offset}`;
      const live = ensureLive(state, event.offset, timestampMs);
      const step: AgentUiCodeStep = {
        kind: "code",
        id: `code-${executionId}`,
        executionId,
        status: "running",
        code: typeof payload?.code === "string" ? payload.code : "",
        startedAtMs: timestampMs,
      };
      return { ...state, live: { ...live, steps: [...live.steps, step] } };
    }

    case SCRIPT_EXECUTION_COMPLETED:
    case CODEMODE_SCRIPT_EXECUTION_COMPLETED: {
      const payload = readPayloadRecord(event);
      if (payload == null || state.live == null) return state;
      const executionId = typeof payload.executionId === "string" ? payload.executionId : null;
      const outcome = readCodeOutcome(payload);
      const steps = [...state.live.steps];
      const index =
        executionId == null
          ? steps.findLastIndex((step) => step.kind === "code" && step.status === "running")
          : steps.findIndex((step) => step.kind === "code" && step.executionId === executionId);
      const step = steps[index];
      if (step == null || step.kind !== "code") return state;
      steps[index] = { ...step, status: "done", ...outcome };
      const next = { ...state, live: { ...state.live, steps } };
      return settleLiveIfIdle(next, timestampMs, ops);
    }

    case AGENT_STATUS_UPDATED: {
      if (readString(event, "status") !== "idle") return state;
      return settleLiveIfIdle(state, timestampMs, ops);
    }

    case STREAM_SUBSCRIBER_CONNECTED: {
      const payload = readPayloadRecord(event);
      if (payload == null) return state;
      const subscriptionKey =
        typeof payload.subscriptionKey === "string" ? payload.subscriptionKey : null;
      if (subscriptionKey == null) return state;
      const direction = payload.direction === "inbound" ? "inbound" : "outbound";
      const subscriber = isRecord(payload.subscriber) ? payload.subscriber : undefined;
      const announcement = readProcessorAnnouncement(subscriber?.processor);
      const entry: AgentUiPresenceEntry = {
        subscriptionKey,
        direction,
        connected: true,
        ...(typeof subscriber?.description === "string"
          ? { description: subscriber.description }
          : {}),
        ...(announcement == null ? {} : { processor: announcement }),
      };
      const existingIndex = state.presence.findIndex(
        (candidate) => candidate.subscriptionKey === subscriptionKey,
      );
      const presence =
        existingIndex === -1
          ? [...state.presence, entry]
          : state.presence.map((candidate, index) =>
              index === existingIndex ? { ...candidate, ...entry } : candidate,
            );
      return { ...state, presence };
    }

    case STREAM_SUBSCRIBER_DISCONNECTED: {
      const subscriptionKey = readString(event, "subscriptionKey");
      if (subscriptionKey == null) return state;
      return {
        ...state,
        presence: state.presence.map((entry) =>
          entry.subscriptionKey === subscriptionKey ? { ...entry, connected: false } : entry,
        ),
      };
    }

    case STREAM_WOKEN: {
      // Every connection died with the previous stream incarnation; survivors
      // re-dial and re-land as fresh connected facts.
      const next = {
        ...state,
        presence: state.presence.map((entry) =>
          entry.connected ? { ...entry, connected: false } : entry,
        ),
      };
      if (isInitialStreamWake(event)) return next;
      return emitItem(next, ops, {
        kind: "stream-woken",
        id: `stream-woken-${event.offset}`,
        text: STREAM_WAKE_LABEL,
        timestampMs,
      });
    }

    case STREAM_CHILD_STREAM_CREATED: {
      const childPath = readString(event, "childPath");
      if (childPath == null) return state;
      return emitItem(state, ops, {
        kind: "child-stream-created",
        id: `child-stream-created-${event.offset}`,
        childPath,
        timestampMs,
      });
    }

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Reducer helpers
// ---------------------------------------------------------------------------

function ensureLive(state: AgentUiState, offset: number, startedAtMs: number): AgentUiActivity {
  // Multiple simultaneous steps render as one live activity.
  if (state.live != null) return { ...state.live, status: "running" };
  return {
    kind: "activity",
    id: `activity-${offset}`,
    status: "running",
    steps: [],
    startedAtMs,
  };
}

function isInitialStreamWake(event: Event): boolean {
  // Brand-new streams commit stream/created at offset 1 and stream/woken at offset 2.
  return event.offset <= 2;
}

function liveHasRunningStep(live: AgentUiActivity | null): boolean {
  return live?.steps.some((step) => step.status === "running") ?? false;
}

function settleLiveIfIdle(state: AgentUiState, endedAtMs: number, ops: AgentUiOp[]): AgentUiState {
  if (liveHasRunningStep(state.live)) return state;
  return settleLive(state, endedAtMs, ops);
}

/** Closes the live activity (if any) and emits it as a settled item. */
function settleLive(state: AgentUiState, endedAtMs: number, ops: AgentUiOp[]): AgentUiState {
  if (state.live == null) return state;
  if (state.live.steps.length === 0) return { ...state, live: null };
  const settled: AgentUiActivity = {
    ...state.live,
    status: "done",
    endedAtMs,
    steps: state.live.steps.map((step) =>
      step.status === "running" ? ({ ...step, status: "done" } as AgentUiStep) : step,
    ),
  };
  return emitItem({ ...state, live: null }, ops, settled);
}

function flushQueuedUserMessages(state: AgentUiState, ops: AgentUiOp[]): AgentUiState {
  let next: AgentUiState = { ...state, queuedUserMessages: [] };
  for (const item of state.queuedUserMessages) {
    next = emitItem(next, ops, item);
  }
  return next;
}

// A user message while steps are still running must not archive those steps
// as finished — the agent is still working. Queue it for the next flush;
// otherwise emit directly. Shared by plain user messages and file-attachment
// inputs.
function emitUserMessageItem(
  state: AgentUiState,
  ops: AgentUiOp[],
  item: AgentUiMessageItem,
): AgentUiState {
  if (liveHasRunningStep(state.live)) {
    return { ...state, queuedUserMessages: [...state.queuedUserMessages, item] };
  }
  return emitItem(state, ops, item);
}

function updateLlmStep(
  state: AgentUiState,
  llmRequestId: number,
  update: (step: AgentUiLlmStep) => AgentUiLlmStep,
): AgentUiState {
  if (state.live == null) return state;
  const index = state.live.steps.findIndex(
    (step) => step.kind === "llm" && step.llmRequestId === llmRequestId,
  );
  const step = state.live.steps[index];
  if (step == null || step.kind !== "llm") return state;
  const steps = [...state.live.steps];
  steps[index] = update(step);
  return { ...state, live: { ...state.live, steps } };
}

function extractCloudflareChunkDeltas(chunk: unknown): {
  responseDelta: string;
  thinkingDelta: string;
} {
  if (typeof chunk === "string") return { responseDelta: chunk, thinkingDelta: "" };
  if (!isRecord(chunk)) return { responseDelta: "", thinkingDelta: "" };

  // Workers AI: { response: "tok" }
  if (typeof chunk.response === "string") {
    return { responseDelta: chunk.response, thinkingDelta: "" };
  }
  // OpenAI-compatible chat completions: { choices: [{ delta: { content, reasoning_content } }] }
  if (Array.isArray(chunk.choices) && isRecord(chunk.choices[0])) {
    const delta = isRecord(chunk.choices[0].delta) ? chunk.choices[0].delta : undefined;
    return {
      responseDelta: typeof delta?.content === "string" ? delta.content : "",
      thinkingDelta: typeof delta?.reasoning_content === "string" ? delta.reasoning_content : "",
    };
  }
  // Anthropic: { delta: { text, thinking } }
  if (isRecord(chunk.delta)) {
    return {
      responseDelta: typeof chunk.delta.text === "string" ? chunk.delta.text : "",
      thinkingDelta: typeof chunk.delta.thinking === "string" ? chunk.delta.thinking : "",
    };
  }
  return { responseDelta: "", thinkingDelta: "" };
}

function readCodeOutcome(payload: Record<string, unknown>): Partial<AgentUiCodeStep> {
  const outcome = isRecord(payload.outcome) ? payload.outcome : undefined;
  const success = payload.ok !== false && payload.error == null && outcome?.status !== "threw";
  const result = "result" in payload ? payload.result : outcome?.value;
  const error =
    typeof payload.error === "string"
      ? payload.error
      : outcome?.status === "threw"
        ? stringifyUnknown(outcome.error)
        : undefined;
  const logs = Array.isArray(payload.logs)
    ? payload.logs.filter((line): line is string => typeof line === "string")
    : undefined;
  return {
    success,
    ...(result === undefined ? {} : { result }),
    ...(error == null ? {} : { errorMessage: error }),
    ...(logs == null ? {} : { logs }),
    ...(typeof payload.durationMs === "number" ? { durationMs: payload.durationMs } : {}),
  };
}

function readUsageTokens(usage: unknown): { input?: number; output?: number } {
  if (!isRecord(usage)) return {};
  const input = usage.input_tokens ?? usage.prompt_tokens;
  const output = usage.output_tokens ?? usage.completion_tokens;
  return {
    ...(typeof input === "number" ? { input } : {}),
    ...(typeof output === "number" ? { output } : {}),
  };
}

function readProcessorAnnouncement(value: unknown): AgentUiProcessorAnnouncement | null {
  if (!isRecord(value)) return null;
  const announcement = isRecord(value.announcement) ? value.announcement : value;
  if (typeof announcement.slug !== "string" || typeof announcement.version !== "string")
    return null;
  return {
    slug: announcement.slug,
    version: announcement.version,
    description: typeof announcement.description === "string" ? announcement.description : "",
    consumes: readStringArray(announcement.consumes),
    emits: readStringArray(announcement.emits),
    ownedEvents: Array.isArray(announcement.ownedEvents)
      ? announcement.ownedEvents
          .filter((owned): owned is Record<string, unknown> => isRecord(owned))
          .filter((owned) => typeof owned.type === "string")
          .map((owned) => ({
            type: owned.type as string,
            ...(typeof owned.description === "string" ? { description: owned.description } : {}),
          }))
      : [],
  };
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function readFileAttachments(event: Event): AgentUiFileAttachment[] {
  const value = readPayloadRecord(event)?.files;
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): AgentUiFileAttachment[] => {
    if (!isRecord(item)) return [];
    const contentType = typeof item.contentType === "string" ? item.contentType : null;
    const filename = typeof item.filename === "string" ? item.filename : null;
    const path = typeof item.path === "string" ? item.path : null;
    const size = typeof item.size === "number" && Number.isFinite(item.size) ? item.size : null;
    const url = typeof item.url === "string" ? item.url : null;
    if (contentType == null || filename == null || path == null || size == null || url == null) {
      return [];
    }
    return [{ contentType, filename, path, size, url }];
  });
}

function readString(event: Event, key: string): string | null {
  const value = readPayloadRecord(event)?.[key];
  return typeof value === "string" ? value : null;
}

function readNumber(event: Event, key: string): number | null {
  const value = readPayloadRecord(event)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readRecord(event: Event, key: string): Record<string, unknown> | null {
  const value = readPayloadRecord(event)?.[key];
  return isRecord(value) ? value : null;
}

function readPayloadRecord(event: Event): Record<string, unknown> | null {
  return isRecord(event.payload) ? event.payload : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
