import { z } from "zod";
import { extractCloudflareChunkDeltas } from "@iterate-com/ui/components/events/agent-ui-reducer";
import { StreamEvent } from "iterate/stream-events";
import { AgentProcessorContract } from "~/domains/agents/agent-processor-contract.ts";
import {
  buildAgentLlmRequestBody,
  flattenMessageToText,
} from "~/domains/agents/agent-processor-implementation.ts";

// The agent processor never journals an LLM request's input — it REBUILDS it
// from committed history on every attempt (buildAgentLlmRequestBody), keyed by
// the llm-request-requested event's offset. That makes the exact wire request
// a pure function of (events, llmRequestOffset), and the browser already
// mirrors the events — so the UI replays the same fold locally instead of
// storing a second copy of every prompt.

/**
 * The event types the replay needs from the local mirror: exactly what the
 * agent processor consumes (its prompt fold reads nothing else), which also
 * carries the request-lifecycle events the header derives model/outcome from.
 */
export const LLM_REPLAY_EVENT_TYPES: readonly string[] = AgentProcessorContract.consumes;

/**
 * The streamed-chunk event type for pure replay callers that already hold a
 * live batch. Browser mirrors never persist or replay these ephemeral rows.
 */
const LLM_RESPONSE_CHUNK_EVENT_TYPE = "events.iterate.com/agent/llm-response-chunk";

export type LlmRequestReplayMessage = {
  /** Stable identity: a message IS its position in the replayed request (the
   * journal is immutable, so the same offset always folds to the same list). */
  id: string;
  role: "system" | "developer" | "user" | "assistant";
  /** Flattened exactly as sent: file attachments become their hint lines. */
  content: string;
};

export type LlmRequestReplayResponse = {
  /** The response text: the committed output when the turn settled with one,
   * else whatever streamed in before the request failed / was cancelled /
   * is still in flight. */
  text: string;
  /** Streamed reasoning ("thinking") text, where the model reported any. */
  thinkingText: string;
  /** "output" = the committed assistant context item; "chunks" = re-assembled
   * from streamed deltas (partial or pre-settle). */
  source: "output" | "chunks";
};

export type LlmRequestReplayStats = {
  /** Normalized counts from token-usage-reported; null until the turn
   * settled successfully (or when the vendor reported no parseable usage). */
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number | null;
    reasoningOutputTokens: number | null;
    maxContextTokens: number;
  } | null;
  /** llm-request-started (the dial) → the first streamed chunk landing. */
  timeToFirstChunkMs: number | null;
  /** First chunk → completion — the generation window; falls back to the
   * last chunk for requests that never settled. */
  generationMs: number | null;
  chunkCount: number;
  /** Output tokens over the generation window. */
  outputTokensPerSecond: number | null;
  /** AI Gateway response-cache verdict (`cf-aig-cache-status`: HIT/MISS…)
   * where the transport recorded one — a HIT means the whole response was
   * served from the gateway's cache without touching the model. */
  gatewayCacheStatus: string | null;
  /** The completed event's verbatim result.rawResponse — whatever the
   * transport recorded (usage dialects, gateway cache status, …). */
  rawResponse: unknown;
};

export type LlmRequestReplay = {
  messages: LlmRequestReplayMessage[];
  /** From the llm-request-requested event at the replayed offset. */
  model: string;
  requestedAt: string;
  /** Null when nothing has streamed or settled for this request yet. */
  response: LlmRequestReplayResponse | null;
  stats: LlmRequestReplayStats;
  /** Null while the request is still in flight. */
  outcome: {
    status: "success" | "failure" | "cancelled";
    durationMs: number | null;
    errorMessage: string | null;
  } | null;
};

// Display slices of the lifecycle payloads (the contract's schemas stay the
// source of truth; these read just the fields the panel shows). Loose on
// purpose: a payload that grew fields must still replay.
const RequestedPayloadSlice = z.looseObject({ model: z.string() });
const CompletedPayloadSlice = z.looseObject({
  durationMs: z.number(),
  llmRequestOffset: z.number(),
  result: z.union([
    z.looseObject({ status: z.literal("success"), rawResponse: z.unknown().optional() }),
    z.looseObject({
      status: z.literal("failure"),
      error: z.looseObject({ message: z.string() }),
      rawResponse: z.unknown().optional(),
    }),
  ]),
});
/** Any lifecycle payload's back-reference to its request (started, completed,
 * chunks, usage all carry it) — the probe replayStats scopes events with. */
const RequestScopedPayloadSlice = z.looseObject({ llmRequestOffset: z.number() });
const TokenUsagePayloadSlice = z.looseObject({
  llmRequestOffset: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  maxContextTokens: z.number(),
  cachedInputTokens: z.number().optional(),
  reasoningOutputTokens: z.number().optional(),
});
const CancelledPayloadSlice = z.looseObject({
  phase: z.literal("requested"),
  llmRequestOffset: z.number(),
});
const OutputPayloadSlice = z.looseObject({
  role: z.literal("assistant"),
  content: z.string(),
  llmRequestOffset: z.number(),
});
const ChunkPayloadSlice = z.looseObject({
  chunk: z.unknown(),
  llmRequestOffset: z.number(),
  sequence: z.number(),
});
/** The transport stamps the gateway's `cf-aig-cache-status` header onto the
 * rawResponse it journals (BYOK lane); absent everywhere else. */
const GatewayCacheSlice = z.looseObject({
  cloudflareAiGatewayResponseCacheStatus: z.string().nullable().optional(),
});

/**
 * Replays one LLM request's exact wire messages — and its response — from
 * mirrored raw events. `rawEventJsons` is the consumed subset
 * (LLM_REPLAY_EVENT_TYPES); `chunkEventJsons` is this request's streamed
 * chunks (LLM_RESPONSE_CHUNK_EVENT_TYPE), which fill in reasoning text and
 * the partial response when no output ever committed. Rows that fail to
 * parse are skipped like the processor's own fold skips them (raw appends
 * are accepted by design; a malformed event is a fact of the log). Returns
 * null when no llm-request-requested event exists at the given offset — the
 * mirror hasn't caught up, or the offset isn't a request.
 */
export function replayLlmRequest(input: {
  rawEventJsons: readonly string[];
  chunkEventJsons?: readonly string[];
  llmRequestOffset: number;
}): LlmRequestReplay | null {
  const events = parseEventRows(input.rawEventJsons);
  const chunkEvents = parseEventRows(input.chunkEventJsons ?? []);

  const requestedEvent = events.find(
    (event) =>
      event.offset === input.llmRequestOffset &&
      event.type === "events.iterate.com/agent/llm-request-requested",
  );
  const requested =
    requestedEvent === undefined
      ? undefined
      : RequestedPayloadSlice.safeParse(requestedEvent.payload);
  if (requestedEvent === undefined || requested === undefined || !requested.success) return null;

  const body = buildAgentLlmRequestBody({ events, llmRequestOffset: input.llmRequestOffset });
  return {
    messages: body.messages.map((message, position) => ({
      id: `${input.llmRequestOffset}:${position}`,
      role: message.role,
      content: flattenMessageToText(message),
    })),
    model: requested.data.model,
    requestedAt: requestedEvent.createdAt,
    response: replayResponse({ events, chunkEvents, llmRequestOffset: input.llmRequestOffset }),
    stats: replayStats({ events, chunkEvents, llmRequestOffset: input.llmRequestOffset }),
    outcome: replayOutcome(events, input.llmRequestOffset),
  };
}

/** JSON rows → parsed StreamEvents, silently dropping malformed rows. */
function parseEventRows(rawEventJsons: readonly string[]): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const rawJson of rawEventJsons) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      continue;
    }
    const result = StreamEvent.safeParse(parsed);
    if (result.success) events.push(result.data);
  }
  return events;
}

/**
 * The request's response: committed assistant context is authoritative
 * when the turn settled with one; thinking text only ever exists in the
 * streamed chunks. Without an output (cancelled, failed, or still in
 * flight), the chunks' re-assembled partial text is all there is.
 */
function replayResponse(input: {
  events: readonly StreamEvent[];
  chunkEvents: readonly StreamEvent[];
  llmRequestOffset: number;
}): LlmRequestReplayResponse | null {
  let outputText: string | null = null;
  for (const event of input.events) {
    if (event.type !== "events.iterate.com/agents/context-added") continue;
    const parsed = OutputPayloadSlice.safeParse(event.payload);
    if (!parsed.success || parsed.data.llmRequestOffset !== input.llmRequestOffset) continue;
    outputText = parsed.data.content;
    break;
  }

  // Deduped by sequence, first occurrence wins: chunk rows are ephemeral and
  // evictable, so a swept-then-restreamed attempt can leave two rows per
  // sequence in a mirror — concatenating both would double the text.
  const deltasBySequence = new Map<number, z.infer<typeof ChunkPayloadSlice>>();
  for (const event of input.chunkEvents) {
    if (event.type !== LLM_RESPONSE_CHUNK_EVENT_TYPE) continue;
    const parsed = ChunkPayloadSlice.safeParse(event.payload);
    if (!parsed.success || parsed.data.llmRequestOffset !== input.llmRequestOffset) continue;
    if (!deltasBySequence.has(parsed.data.sequence)) {
      deltasBySequence.set(parsed.data.sequence, parsed.data);
    }
  }
  const deltas = [...deltasBySequence.values()].sort((a, b) => a.sequence - b.sequence);
  let streamedText = "";
  let thinkingText = "";
  for (const delta of deltas) {
    const { responseDelta, thinkingDelta } = extractCloudflareChunkDeltas(delta.chunk);
    streamedText += responseDelta;
    thinkingText += thinkingDelta;
  }

  if (outputText != null) return { text: outputText, thinkingText, source: "output" };
  if (streamedText !== "" || thinkingText !== "") {
    return { text: streamedText, thinkingText, source: "chunks" };
  }
  return null;
}

/**
 * Everything else the journal knows about this request: normalized token
 * counts (token-usage-reported), latency derived from the lifecycle events'
 * own timestamps (started = the dial, chunks = streaming, completed = done),
 * and the completed event's verbatim rawResponse. All server-stamped append
 * times, so the numbers are the stream's truth rather than a client clock.
 */
function replayStats(input: {
  events: readonly StreamEvent[];
  chunkEvents: readonly StreamEvent[];
  llmRequestOffset: number;
}): LlmRequestReplayStats {
  const forThisRequest = (event: StreamEvent, type: string) => {
    if (event.type !== type) return false;
    const parsed = RequestScopedPayloadSlice.safeParse(event.payload);
    return parsed.success && parsed.data.llmRequestOffset === input.llmRequestOffset;
  };
  const startedAt = timestampOf(
    input.events.find((event) =>
      forThisRequest(event, "events.iterate.com/agent/llm-request-started"),
    ),
  );
  const completedEvent = input.events.find((event) =>
    forThisRequest(event, "events.iterate.com/agent/llm-request-completed"),
  );
  const completedAt = timestampOf(completedEvent);
  const completed =
    completedEvent === undefined
      ? undefined
      : CompletedPayloadSlice.safeParse(completedEvent.payload);

  const chunks = input.chunkEvents.filter((event) =>
    forThisRequest(event, LLM_RESPONSE_CHUNK_EVENT_TYPE),
  );
  const firstChunkAt = timestampOf(chunks[0]);
  const lastChunkAt = timestampOf(chunks.at(-1));

  let tokens: LlmRequestReplayStats["tokens"] = null;
  for (const event of input.events) {
    if (event.type !== "events.iterate.com/agent/token-usage-reported") continue;
    const parsed = TokenUsagePayloadSlice.safeParse(event.payload);
    if (!parsed.success || parsed.data.llmRequestOffset !== input.llmRequestOffset) continue;
    tokens = {
      inputTokens: parsed.data.inputTokens,
      outputTokens: parsed.data.outputTokens,
      cachedInputTokens: parsed.data.cachedInputTokens ?? null,
      reasoningOutputTokens: parsed.data.reasoningOutputTokens ?? null,
      maxContextTokens: parsed.data.maxContextTokens,
    };
    break;
  }

  const timeToFirstChunkMs =
    startedAt != null && firstChunkAt != null ? Math.max(0, firstChunkAt - startedAt) : null;
  const generationEndAt = completedAt ?? lastChunkAt;
  const generationMs =
    firstChunkAt != null && generationEndAt != null
      ? Math.max(0, generationEndAt - firstChunkAt)
      : null;
  const outputTokensPerSecond =
    tokens != null && generationMs != null && generationMs > 0
      ? Math.round((tokens.outputTokens / (generationMs / 1000)) * 10) / 10
      : null;

  const rawResponse = completed?.success ? (completed.data.result.rawResponse ?? null) : null;
  const gatewayCacheStatus = GatewayCacheSlice.safeParse(rawResponse);
  return {
    tokens,
    timeToFirstChunkMs,
    generationMs,
    chunkCount: chunks.length,
    outputTokensPerSecond,
    gatewayCacheStatus: gatewayCacheStatus.success
      ? (gatewayCacheStatus.data.cloudflareAiGatewayResponseCacheStatus ?? null)
      : null,
    rawResponse,
  };
}

function timestampOf(event: StreamEvent | undefined): number | null {
  if (event === undefined) return null;
  const parsed = Date.parse(event.createdAt);
  return Number.isNaN(parsed) ? null : parsed;
}

/** The request's settled outcome: completed beats cancelled (a late completion
 * under the shared idempotency key is the durable fact); null = in flight. */
function replayOutcome(
  events: readonly StreamEvent[],
  llmRequestOffset: number,
): LlmRequestReplay["outcome"] {
  for (const event of events) {
    if (event.type !== "events.iterate.com/agent/llm-request-completed") continue;
    const parsed = CompletedPayloadSlice.safeParse(event.payload);
    if (!parsed.success || parsed.data.llmRequestOffset !== llmRequestOffset) continue;
    const result = parsed.data.result;
    return {
      status: result.status,
      durationMs: parsed.data.durationMs,
      errorMessage: result.status === "failure" ? result.error.message : null,
    };
  }
  for (const event of events) {
    if (event.type !== "events.iterate.com/agent/llm-request-cancelled") continue;
    const parsed = CancelledPayloadSlice.safeParse(event.payload);
    if (!parsed.success || parsed.data.llmRequestOffset !== llmRequestOffset) continue;
    return { status: "cancelled", durationMs: null, errorMessage: null };
  }
  return null;
}
