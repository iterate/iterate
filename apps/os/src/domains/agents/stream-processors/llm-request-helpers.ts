// Pure helpers shared by the LLM request processors (cloudflare-ai,
// openai-ws). The two processors are deliberate siblings: each owns its event
// types, its control flow, and its transport; what they share are these
// stateless functions over agent stream history and reduced request state.

import type { StreamEvent } from "@iterate-com/shared/streams/stream-processors";
import {
  getConsumedEventDefinition,
  getEventSchema,
} from "@iterate-com/shared/streams/stream-processors";
import {
  AgentProcessorContract,
  buildLlmChatRequest,
  reduceAgentEvents,
  type AgentConsumedEvent,
} from "./agent/contract.ts";

export type LlmRequestRequestedEvent = Extract<
  AgentConsumedEvent,
  { type: "events.iterate.com/agent/llm-request-requested" }
>;

/**
 * REQUEST-BY-REFERENCE: `agent/llm-request-requested` carries no conversation
 * body (embedding it would store a full copy of the growing history in every
 * request — O(N²) stream growth). The llmRequestId IS the requested event's
 * offset, so the chat request is rebuilt here from committed history up to
 * that offset — reproducible from the stream forever.
 */
export function buildAgentLlmRequestBody(args: {
  events: readonly StreamEvent[];
  llmRequestId: number;
}) {
  return buildLlmChatRequest(
    reduceAgentEvents({
      events: args.events.filter((event) => event.offset <= args.llmRequestId),
    }),
  );
}

/**
 * Whether the agent is still waiting on this request. Checked against
 * committed history right before agent-visible appends: a request the agent
 * has moved past (interrupted, superseded) completes quietly — provider
 * completion only, no output row, no agent-level terminal (the cancellation
 * already was one).
 */
export function isAgentLlmRequestStillCurrent(args: {
  events: readonly StreamEvent[];
  llmRequestId: number;
}) {
  const state = reduceAgentEvents({ events: [...args.events] });
  return (
    state.currentRequest?.phase === "requested" &&
    state.currentRequest.llmRequestId === args.llmRequestId
  );
}

/**
 * Requests whose durable status says "started" but that this instance never
 * executed — they can only come from a previous incarnation that died
 * mid-request. The execution-claims set is instance-scoped on purpose; see
 * the processors' `#executedLlmRequestIds` field docs.
 */
export function findDanglingLlmRequestIds(args: {
  requests: Record<string, { status: "started" | "completed" }>;
  executedLlmRequestIds: ReadonlySet<number>;
}): number[] {
  return Object.entries(args.requests)
    .filter(
      ([id, request]) =>
        request.status === "started" && !args.executedLlmRequestIds.has(Number(id)),
    )
    .map(([id]) => Number(id));
}

/**
 * Finds and schema-parses the `agent/llm-request-requested` event at the given
 * offset, for recovery paths that must re-derive a typed requested event from
 * raw history. Returns null when the offset holds no such event.
 */
export function parseLlmRequestRequestedEventAt(args: {
  events: readonly StreamEvent[];
  llmRequestId: number;
}): LlmRequestRequestedEvent | null {
  const requestedEvent = args.events.find(
    (event) =>
      event.offset === args.llmRequestId &&
      event.type === "events.iterate.com/agent/llm-request-requested",
  );
  if (requestedEvent === undefined) return null;
  const definition = getConsumedEventDefinition({
    contract: AgentProcessorContract,
    eventType: requestedEvent.type,
  });
  if (definition === undefined) return null;
  const result = getEventSchema({
    type: requestedEvent.type,
    payloadSchema: definition.payloadSchema,
  }).safeParse(requestedEvent);
  return result.success ? (result.data as LlmRequestRequestedEvent) : null;
}
