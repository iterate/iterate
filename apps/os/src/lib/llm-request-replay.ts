import { z } from "zod";
import { AgentProcessorContract } from "~/domains/agents/agent-processor-contract.ts";
import {
  buildAgentLlmRequestBody,
  flattenMessageToText,
} from "~/domains/agents/agent-processor-implementation.ts";
import { StreamEvent } from "~/domains/streams/schemas.ts";

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

export type LlmRequestReplayMessage = {
  role: "system" | "user" | "assistant";
  /** Flattened exactly as sent: file attachments become their hint lines. */
  content: string;
};

export type LlmRequestReplay = {
  messages: LlmRequestReplayMessage[];
  /** From the llm-request-requested event at the replayed offset. */
  model: string;
  requestedAt: string;
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
    z.looseObject({ status: z.literal("success") }),
    z.looseObject({ status: z.literal("failure"), error: z.looseObject({ message: z.string() }) }),
  ]),
});
const CancelledPayloadSlice = z.looseObject({
  phase: z.literal("requested"),
  llmRequestOffset: z.number(),
});

/**
 * Replays one LLM request's exact wire messages from mirrored raw events.
 * Rows that fail to parse are skipped like the processor's own fold skips
 * them (raw appends are accepted by design; a malformed event is a fact of
 * the log). Returns null when no llm-request-requested event exists at the
 * given offset — the mirror hasn't caught up, or the offset isn't a request.
 */
export function replayLlmRequest(input: {
  rawEventJsons: readonly string[];
  llmRequestOffset: number;
}): LlmRequestReplay | null {
  const events: StreamEvent[] = [];
  for (const rawJson of input.rawEventJsons) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      continue;
    }
    const result = StreamEvent.safeParse(parsed);
    if (result.success) events.push(result.data);
  }

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
    messages: body.messages.map((message) => ({
      role: message.role,
      content: flattenMessageToText(message),
    })),
    model: requested.data.model,
    requestedAt: requestedEvent.createdAt,
    outcome: replayOutcome(events, input.llmRequestOffset),
  };
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
