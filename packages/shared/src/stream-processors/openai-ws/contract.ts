import { z } from "zod";
import {
  assertNever,
  defineProcessorContract,
  reduceProcessorEvents,
  type StreamEvent,
} from "../stream-processor.ts";
import { AgentProcessorContract } from "../agent/contract.ts";
import { CoreProcessorRegisteredEventType } from "../core/contract.ts";
import { standardProcessorBehavior } from "../core/standard-processor-behavior.ts";

const LlmRequestId = z.number().int().positive();

export const OpenAiWsProcessorContract = defineProcessorContract({
  slug: "openai-ws",
  version: "0.1.0",
  /**
   * OpenAI Responses WebSocket mode uses `response.create` messages on a
   * WebSocket connection and emits the same streaming event family as ordinary
   * Responses streaming.
   *
   * https://developers.openai.com/api/docs/guides/websocket-mode
   */
  description:
    "Executes agent LLM requests through OpenAI Responses WebSocket mode, recording raw socket transcript events and appending the agent-level output and terminal request event owed by the LLM request processor contract.",
  stateSchema: z.object({
    ...standardProcessorBehavior.stateShape,
    model: z.string().min(1).default("gpt-4.1-mini"),
    requests: z
      .record(
        z.string(),
        z.discriminatedUnion("status", [
          z.object({ status: z.literal("started") }),
          z.object({ status: z.literal("completed") }),
        ]),
      )
      .default({}),
  }),
  initialState: {
    ...standardProcessorBehavior.initialState,
  },
  processorDeps: [...standardProcessorBehavior.processorDeps, AgentProcessorContract],
  events: {
    "events.iterate.com/openai-ws/config-updated": {
      description: "Updates OpenAI WebSocket request configuration for future LLM requests.",
      payloadSchema: z.object({
        model: z.string().min(1),
      }),
    },
    "events.iterate.com/openai-ws/websocket-connected": {
      description: "The OpenAI WebSocket connection was established.",
      payloadSchema: z.object({
        connectionId: z.string().min(1),
        url: z.string().url(),
      }),
    },
    "events.iterate.com/openai-ws/websocket-disconnected": {
      description: "The OpenAI WebSocket connection closed or was discarded.",
      payloadSchema: z.object({
        connectionId: z.string().min(1),
        code: z.number().int().optional(),
        reason: z.string().optional(),
        wasClean: z.boolean().optional(),
      }),
    },
    "events.iterate.com/openai-ws/websocket-message-sent": {
      description: "A raw JSON message was sent to the OpenAI WebSocket.",
      payloadSchema: z.object({
        connectionId: z.string().min(1),
        llmRequestId: LlmRequestId.optional(),
        sequence: z.number().int().nonnegative(),
        message: z.json(),
      }),
    },
    "events.iterate.com/openai-ws/websocket-message-received": {
      description: "A raw JSON message was received from the OpenAI WebSocket.",
      payloadSchema: z.object({
        connectionId: z.string().min(1),
        llmRequestId: LlmRequestId.optional(),
        sequence: z.number().int().nonnegative(),
        message: z.json(),
      }),
    },
    "events.iterate.com/openai-ws/llm-request-started": {
      description:
        "The OpenAI WebSocket processor started executing an agent LLM request. The llmRequestId is the offset of the source agent/llm-request-requested event.",
      payloadSchema: z.object({
        connectionId: z.string().min(1),
        llmRequestId: LlmRequestId,
        model: z.string().min(1),
      }),
    },
    "events.iterate.com/openai-ws/llm-request-completed": {
      description:
        "The OpenAI WebSocket processor finished executing an agent LLM request with either success or failure.",
      payloadSchema: z.object({
        connectionId: z.string().min(1).optional(),
        llmRequestId: LlmRequestId,
        responseId: z.string().optional(),
        durationMs: z.number().int().nonnegative(),
        result: z.discriminatedUnion("status", [
          z.object({
            status: z.literal("success"),
            rawResponse: z.json().optional(),
            usage: z.json().optional(),
          }),
          z.object({
            status: z.literal("failure"),
            error: z.object({ message: z.string() }),
            rawResponse: z.json().optional(),
          }),
        ]),
      }),
    },
  },
  consumes: [
    ...standardProcessorBehavior.consumes,
    "events.iterate.com/openai-ws/config-updated",
    "events.iterate.com/openai-ws/llm-request-started",
    "events.iterate.com/openai-ws/llm-request-completed",
    "events.iterate.com/agent/llm-request-requested",
  ],
  emits: [
    ...standardProcessorBehavior.emits,
    "events.iterate.com/openai-ws/websocket-connected",
    "events.iterate.com/openai-ws/websocket-disconnected",
    "events.iterate.com/openai-ws/websocket-message-sent",
    "events.iterate.com/openai-ws/websocket-message-received",
    "events.iterate.com/openai-ws/llm-request-started",
    "events.iterate.com/openai-ws/llm-request-completed",
    "events.iterate.com/agent/output-added",
    "events.iterate.com/agent/llm-request-completed",
  ],
  reduce({ contract, state, event }) {
    const nextState = standardProcessorBehavior.reduce({
      state,
      event,
      contract,
    });

    switch (event.type) {
      case CoreProcessorRegisteredEventType:
      case "events.iterate.com/agent/llm-request-requested":
        return nextState;
      case "events.iterate.com/openai-ws/config-updated":
        return { ...nextState, model: event.payload.model };
      case "events.iterate.com/openai-ws/llm-request-started":
        return {
          ...nextState,
          requests: {
            ...nextState.requests,
            [String(event.payload.llmRequestId)]: { status: "started" as const },
          },
        };
      case "events.iterate.com/openai-ws/llm-request-completed":
        return {
          ...nextState,
          requests: {
            ...nextState.requests,
            [String(event.payload.llmRequestId)]: { status: "completed" as const },
          },
        };
      default:
        return assertNever(event);
    }
  },
});

export function reduceOpenAiWsEvents(args: {
  events: readonly StreamEvent[];
  state?: OpenAiWsState;
}): OpenAiWsState {
  return reduceProcessorEvents({
    contract: OpenAiWsProcessorContract,
    events: args.events,
    state: args.state,
  });
}

export type OpenAiWsState = z.infer<typeof OpenAiWsProcessorContract.stateSchema>;
