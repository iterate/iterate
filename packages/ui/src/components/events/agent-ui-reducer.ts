import type { Event } from "@iterate-com/shared/streams/types";

// ---------------------------------------------------------------------------
// Reduced state model + pure batch planner
//
// The agent UI is a clean chat: user message → activity ("Ran code 2× · 3
// requests · 7.4 s") → assistant message. SETTLED items are emitted as ops
// that the agent-ui processor writes into the `agent_feed_items` SQLite
// table (the TanStack virtual list reads those rows); the reduced state holds
// only what is still in flight — the live activity with partially streamed
// thinking/response text, the presence roster, and the next dense row index.
// The live part renders as one element below the list, straight from this
// state.
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
  /**
   * "waiting" = the agent went idle but no chat message has settled the
   * activity yet — further rounds roll into it ("Ran code 3× · 3 requests").
   */
  status: "running" | "waiting" | "done";
  steps: AgentUiStep[];
  startedAtMs: number;
  endedAtMs?: number;
};

export type AgentUiMessageItem = {
  kind: "user" | "assistant";
  id: string;
  text: string;
  timestampMs: number;
};

export type AgentUiItem = AgentUiMessageItem | AgentUiActivity;

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
  /** The running activity (streaming thinking/code), or null when idle. */
  live: AgentUiActivity | null;
  eventCount: number;
  /** Connection roster reduced from subscriber-connected/disconnected facts. */
  presence: AgentUiPresenceEntry[];
  /** Dense, monotonically increasing next agent_feed_items local_index. */
  nextLocalIndex: number;
};

export function initialAgentUiState(): AgentUiState {
  return { live: null, eventCount: 0, presence: [], nextLocalIndex: 0 };
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

const AGENT_CHAT_USER_MESSAGE_ADDED = "events.iterate.com/agent-chat/user-message-added";
const AGENT_CHAT_ASSISTANT_RESPONSE_ADDED =
  "events.iterate.com/agent-chat/assistant-response-added";
const AGENT_LLM_REQUEST_REQUESTED = "events.iterate.com/agent/llm-request-requested";
const AGENT_LLM_REQUEST_COMPLETED = "events.iterate.com/agent/llm-request-completed";
const AGENT_LLM_REQUEST_CANCELLED = "events.iterate.com/agent/llm-request-cancelled";
const AGENT_OUTPUT_ADDED = "events.iterate.com/agent/output-added";
const AGENT_STATUS_UPDATED = "events.iterate.com/agent/status-updated";
const OPENAI_WS_REQUEST_STARTED = "events.iterate.com/openai-ws/llm-request-started";
const OPENAI_WS_MESSAGE_RECEIVED = "events.iterate.com/openai-ws/websocket-message-received";
const CLOUDFLARE_AI_REQUEST_STARTED = "events.iterate.com/cloudflare-ai/llm-request-started";
const CLOUDFLARE_AI_RESPONSE_CHUNK = "events.iterate.com/cloudflare-ai/llm-response-chunk";
const ITX_SCRIPT_EXECUTION_REQUESTED = "events.iterate.com/itx/script-execution-requested";
const ITX_SCRIPT_EXECUTION_COMPLETED = "events.iterate.com/itx/script-execution-completed";
const CODEMODE_SCRIPT_EXECUTION_REQUESTED =
  "events.iterate.com/codemode/script-execution-requested";
const CODEMODE_SCRIPT_EXECUTION_COMPLETED =
  "events.iterate.com/codemode/script-execution-completed";
const STREAM_SUBSCRIBER_CONNECTED = "events.iterate.com/stream/subscriber-connected";
const STREAM_SUBSCRIBER_DISCONNECTED = "events.iterate.com/stream/subscriber-disconnected";
const STREAM_WOKEN = "events.iterate.com/stream/woken";

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function reduceAgentUiEvent(previous: AgentUiState, event: Event, ops: AgentUiOp[]): AgentUiState {
  const state: AgentUiState = { ...previous, eventCount: previous.eventCount + 1 };
  const timestampMs = Date.parse(event.createdAt);

  switch (event.type) {
    case AGENT_CHAT_USER_MESSAGE_ADDED: {
      const text = readString(event, "content");
      if (text == null) return state;
      // A user message while steps are still running must not archive those
      // steps as finished — the agent is still working. Only a quiescent live
      // activity settles here; an active one keeps streaming and settles on
      // its own terminal event.
      const hasRunningStep = state.live?.steps.some((step) => step.status === "running") ?? false;
      const base = hasRunningStep ? state : settleLive(state, timestampMs, ops);
      return emitItem(base, ops, {
        kind: "user",
        id: `user-${event.offset}`,
        text,
        timestampMs,
      });
    }

    case AGENT_CHAT_ASSISTANT_RESPONSE_ADDED: {
      const text = readString(event, "message");
      if (text == null) return state;
      const settled = settleLive(state, timestampMs, ops);
      return emitItem(settled, ops, {
        kind: "assistant",
        id: `assistant-${event.offset}`,
        text,
        timestampMs,
      });
    }

    case AGENT_LLM_REQUEST_REQUESTED: {
      const live = ensureLive(state, event.offset, timestampMs);
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
      return { ...state, live: { ...live, steps: [...live.steps, step] } };
    }

    case OPENAI_WS_REQUEST_STARTED:
    case CLOUDFLARE_AI_REQUEST_STARTED: {
      const llmRequestId = readNumber(event, "llmRequestId");
      const model = readString(event, "model");
      if (llmRequestId == null || model == null) return state;
      return updateLlmStep(state, llmRequestId, (step) => ({ ...step, model }));
    }

    case OPENAI_WS_MESSAGE_RECEIVED: {
      const llmRequestId = readNumber(event, "llmRequestId");
      const message = readRecord(event, "message");
      if (llmRequestId == null || message == null) return state;
      const frameType = typeof message.type === "string" ? message.type : "";
      const delta = typeof message.delta === "string" ? message.delta : "";

      if (frameType === "response.output_text.delta" && delta !== "") {
        return updateLlmStep(state, llmRequestId, (step) => ({
          ...step,
          responseText: step.responseText + delta,
        }));
      }
      if (
        (frameType === "response.reasoning_summary_text.delta" ||
          frameType === "response.reasoning_text.delta") &&
        delta !== ""
      ) {
        return updateLlmStep(state, llmRequestId, (step) => ({
          ...step,
          thinkingText: step.thinkingText + delta,
        }));
      }
      if (frameType === "response.reasoning_summary_part.added") {
        return updateLlmStep(state, llmRequestId, (step) => ({
          ...step,
          thinkingText: step.thinkingText === "" ? "" : `${step.thinkingText}\n\n`,
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
        responseText: step.responseText + responseDelta,
        thinkingText: step.thinkingText + thinkingDelta,
      }));
    }

    case AGENT_OUTPUT_ADDED: {
      const llmRequestId = readNumber(event, "llmRequestId");
      const content = readString(event, "content");
      if (llmRequestId == null || content == null) return state;
      // Authoritative full text: replaces whatever streamed in (or fills it
      // in for providers that never streamed).
      return updateLlmStep(state, llmRequestId, (step) => ({ ...step, responseText: content }));
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
      return updateLlmStep(state, llmRequestId, (step) => ({
        ...step,
        status: "done",
        outcome: status === "success" ? "completed" : "failed",
        ...(typeof payload?.provider === "string" ? { provider: payload.provider } : {}),
        ...(typeof payload?.durationMs === "number" ? { durationMs: payload.durationMs } : {}),
        ...(usage.input == null ? {} : { inputTokens: usage.input }),
        ...(usage.output == null ? {} : { outputTokens: usage.output }),
        ...(errorMessage == null ? {} : { errorMessage }),
        ...(typeof result?.providerResponseId === "string"
          ? { providerResponseId: result.providerResponseId }
          : {}),
      }));
    }

    case AGENT_LLM_REQUEST_CANCELLED: {
      const llmRequestId = readNumber(event, "llmRequestId");
      if (llmRequestId == null) return state;
      return updateLlmStep(state, llmRequestId, (step) => ({
        ...step,
        status: "done",
        outcome: "cancelled",
      }));
    }

    case ITX_SCRIPT_EXECUTION_REQUESTED:
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

    case ITX_SCRIPT_EXECUTION_COMPLETED:
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
      return { ...state, live: { ...state.live, steps } };
    }

    case AGENT_STATUS_UPDATED: {
      if (readString(event, "status") !== "idle") return state;
      // Idle does NOT settle: rounds within one conversation roll into a
      // single activity, and only chat messages break it up. Mark the live
      // activity waiting so the UI can park the spinner until the next round.
      if (state.live == null) return state;
      return { ...state, live: { ...state.live, status: "waiting" } };
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
      return {
        ...state,
        presence: state.presence.map((entry) =>
          entry.connected ? { ...entry, connected: false } : entry,
        ),
      };
    }

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Reducer helpers
// ---------------------------------------------------------------------------

function ensureLive(state: AgentUiState, offset: number, startedAtMs: number): AgentUiActivity {
  // A new step resumes a waiting activity — that's the roll-up.
  if (state.live != null) return { ...state.live, status: "running" };
  return {
    kind: "activity",
    id: `activity-${offset}`,
    status: "running",
    steps: [],
    startedAtMs,
  };
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
  if (typeof value.slug !== "string" || typeof value.version !== "string") return null;
  return {
    slug: value.slug,
    version: value.version,
    description: typeof value.description === "string" ? value.description : "",
    consumes: readStringArray(value.consumes),
    emits: readStringArray(value.emits),
    ownedEvents: Array.isArray(value.ownedEvents)
      ? value.ownedEvents
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
