import { z } from "zod";
import { extractCloudflareChunkDeltas } from "@iterate-com/ui/components/events/agent-ui-reducer";
import { StreamEvent } from "iterate/processors";
// Relative (not ~/) imports: apps/mobile's Meta tab replays prompts through
// this same fold, and its tsconfig/Metro don't know the os path alias.
import { AgentProcessorContract } from "../domains/agents/agent-processor-contract.ts";
import {
  buildAgentLlmRequestBody,
  flattenMessageToText,
} from "../domains/agents/agent-prompt-fold.ts";

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
 * live or catch-up batch. Browser mirrors never persist these ephemeral events.
 */
const LLM_RESPONSE_CHUNK_EVENT_TYPE = "events.iterate.com/agent/llm-response-chunk";
const LLM_RESPONSE_CHUNKS_EVENT_TYPE = "events.iterate.com/agent/llm-response-chunks";

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
  /** The llm-request-requested event's own append time → the first streamed
   * chunk landing. There is no separate dial event in this model, so the
   * window includes any pre-dial delay (debounce leftovers, transport
   * connect) before streaming began. */
  timeToFirstChunkMs: number | null;
  /** First chunk → settled — the generation window; falls back to the
   * last chunk for requests that never settled. */
  generationMs: number | null;
  chunkCount: number;
  /** Output tokens over the generation window. */
  outputTokensPerSecond: number | null;
  /** AI Gateway response-cache verdict (`cf-aig-cache-status`: HIT/MISS…)
   * where the transport recorded one — a HIT means the whole response was
   * served from the gateway's cache without touching the model. */
  gatewayCacheStatus: string | null;
  /** The settled event's verbatim result.rawResponse — whatever the
   * transport recorded (usage dialects, gateway cache status, …). */
  rawResponse: unknown;
};

export type LlmRequestReplay = {
  messages: LlmRequestReplayMessage[];
  /** From the llm-request-requested event at the replayed offset. */
  model: string;
  requestedAt: string;
  /** True when the request was built by a DIFFERENT fold version than the one
   * replaying it (the requested event's contractVersion stamp differs, or —
   * for pre-stamp requests — is absent): the messages shown are a
   * reconstruction under the current fold, not byte-exact. */
  reconstructed: boolean;
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
const RequestedPayloadSlice = z.looseObject({
  model: z.string(),
  contractVersion: z.string().optional(),
});
/** A chunk row's back-reference to its request — the probe replayStats
 * scopes chunk events with. */
const RequestScopedPayloadSlice = z.looseObject({ llmRequestOffset: z.number() });
const TokenUsagePayloadSlice = z.looseObject({
  llmRequestOffset: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  maxContextTokens: z.number(),
  cachedInputTokens: z.number().optional(),
  reasoningOutputTokens: z.number().optional(),
});
const SettledPayloadSlice = z.looseObject({
  requestOffset: z.number(),
  durationMs: z.number().optional(),
  result: z.union([
    z.looseObject({ status: z.literal("succeeded"), rawResponse: z.unknown().optional() }),
    z.looseObject({
      status: z.literal("failed"),
      errorMessage: z.string(),
      rawResponse: z.unknown().optional(),
    }),
    z.looseObject({ status: z.literal("cancelled"), partialText: z.string().optional() }),
  ]),
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
const ChunksPayloadSlice = z.looseObject({
  chunks: z.array(z.unknown()),
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
    reconstructed: requested.data.contractVersion !== AgentProcessorContract.version,
    response: replayResponse({ events, chunkEvents, llmRequestOffset: input.llmRequestOffset }),
    stats: replayStats({
      events,
      chunkEvents,
      llmRequestOffset: input.llmRequestOffset,
      requestedEvent,
    }),
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

  // Deduped by sequence, first occurrence wins: a callback reconnect can
  // redeliver a buffered chunk already present in the caller's in-memory
  // batch. Concatenating both occurrences would double the text. A window
  // (plural) event's sequence numbers flushes; the legacy singular lane's
  // numbers chunks — a single response only ever rides one lane.
  const windowsBySequence = new Map<number, unknown[]>();
  for (const event of input.chunkEvents) {
    if (event.type === LLM_RESPONSE_CHUNK_EVENT_TYPE) {
      const parsed = ChunkPayloadSlice.safeParse(event.payload);
      if (!parsed.success || parsed.data.llmRequestOffset !== input.llmRequestOffset) continue;
      if (!windowsBySequence.has(parsed.data.sequence)) {
        windowsBySequence.set(parsed.data.sequence, [parsed.data.chunk]);
      }
    } else if (event.type === LLM_RESPONSE_CHUNKS_EVENT_TYPE) {
      const parsed = ChunksPayloadSlice.safeParse(event.payload);
      if (!parsed.success || parsed.data.llmRequestOffset !== input.llmRequestOffset) continue;
      if (!windowsBySequence.has(parsed.data.sequence)) {
        windowsBySequence.set(parsed.data.sequence, parsed.data.chunks);
      }
    }
  }
  const windows = [...windowsBySequence.entries()]
    .sort(([a], [b]) => a - b)
    .flatMap(([, chunks]) => chunks);
  let streamedText = "";
  let thinkingText = "";
  for (const chunk of windows) {
    const { responseDelta, thinkingDelta } = extractCloudflareChunkDeltas(chunk);
    streamedText += responseDelta;
    thinkingText += thinkingDelta;
  }

  if (outputText != null) return { text: outputText, thinkingText, source: "output" };
  if (streamedText !== "" || thinkingText !== "") {
    return { text: streamedText, thinkingText, source: "chunks" };
  }
  // An interrupted request has no committed output, and its chunks are
  // ephemeral (gone from durable mirrors) — the settled fact's partialText is
  // the durable record of what streamed before the abort.
  for (const event of input.events) {
    if (event.type !== "events.iterate.com/agent/llm-request-settled") continue;
    const parsed = SettledPayloadSlice.safeParse(event.payload);
    if (!parsed.success || parsed.data.requestOffset !== input.llmRequestOffset) continue;
    const result = parsed.data.result;
    if (result.status === "cancelled" && typeof result.partialText === "string") {
      return { text: result.partialText, thinkingText, source: "output" };
    }
    break;
  }
  return null;
}

/**
 * Everything else the journal knows about this request: normalized token
 * counts (token-usage-reported), latency derived from the lifecycle events'
 * own timestamps (requested = the ask, chunks = streaming, settled = done),
 * and the settled event's verbatim rawResponse. All server-stamped append
 * times, so the numbers are the stream's truth rather than a client clock.
 */
function replayStats(input: {
  events: readonly StreamEvent[];
  chunkEvents: readonly StreamEvent[];
  llmRequestOffset: number;
  requestedEvent: StreamEvent;
}): LlmRequestReplayStats {
  const requestedAt = timestampOf(input.requestedEvent);
  const settledEvent = input.events.find((event) => {
    if (event.type !== "events.iterate.com/agent/llm-request-settled") return false;
    const parsed = SettledPayloadSlice.safeParse(event.payload);
    return parsed.success && parsed.data.requestOffset === input.llmRequestOffset;
  });
  const settledAt = timestampOf(settledEvent);
  const settled =
    settledEvent === undefined ? undefined : SettledPayloadSlice.safeParse(settledEvent.payload);

  const chunks = input.chunkEvents.filter((event) => {
    if (
      event.type !== LLM_RESPONSE_CHUNK_EVENT_TYPE &&
      event.type !== LLM_RESPONSE_CHUNKS_EVENT_TYPE
    ) {
      return false;
    }
    const parsed = RequestScopedPayloadSlice.safeParse(event.payload);
    return parsed.success && parsed.data.llmRequestOffset === input.llmRequestOffset;
  });
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

  // Anchored on the requested event's own append time: the model has no
  // separate dial event, so this window includes any pre-dial delay before
  // the transport connected, not just streaming latency.
  const timeToFirstChunkMs =
    requestedAt != null && firstChunkAt != null ? Math.max(0, firstChunkAt - requestedAt) : null;
  const generationEndAt = settledAt ?? lastChunkAt;
  const generationMs =
    firstChunkAt != null && generationEndAt != null
      ? Math.max(0, generationEndAt - firstChunkAt)
      : null;
  const outputTokensPerSecond =
    tokens != null && generationMs != null && generationMs > 0
      ? Math.round((tokens.outputTokens / (generationMs / 1000)) * 10) / 10
      : null;

  const rawResponse =
    settled?.success && settled.data.result.status !== "cancelled"
      ? (settled.data.result.rawResponse ?? null)
      : null;
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

/** The request's outcome: the settled event is the ONE terminal fact —
 * there is no other settlement source; null = still in flight. */
function replayOutcome(
  events: readonly StreamEvent[],
  llmRequestOffset: number,
): LlmRequestReplay["outcome"] {
  for (const event of events) {
    if (event.type !== "events.iterate.com/agent/llm-request-settled") continue;
    const parsed = SettledPayloadSlice.safeParse(event.payload);
    if (!parsed.success || parsed.data.requestOffset !== llmRequestOffset) continue;
    const result = parsed.data.result;
    return {
      status:
        result.status === "succeeded"
          ? "success"
          : result.status === "failed"
            ? "failure"
            : "cancelled",
      durationMs: parsed.data.durationMs ?? null,
      errorMessage: result.status === "failed" ? result.errorMessage : null,
    };
  }
  return null;
}
