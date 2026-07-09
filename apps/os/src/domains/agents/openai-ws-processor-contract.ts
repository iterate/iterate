import { z } from "zod";
import { defineProcessorContract } from "../streams/processor-contracts.ts";
import { AgentProcessorContract } from "./agent-processor-contract.ts";

/** Default model for the openai-ws provider (matches the legacy os default). */
export const DEFAULT_OPENAI_WS_MODEL = "gpt-5.5";

export const OpenAiWsProcessorContract = defineProcessorContract({
  slug: "openai-ws",
  version: "0.1.0",
  description: "Runs agent LLM requests through OpenAI Responses WebSocket mode.",
  stateSchema: z.object({
    /**
     * The provider's OBLIGATIONS: every request of this provider's that has
     * not reached a terminal event (completed or cancelled), keyed by
     * llmRequestId. This is the "what should be running" half of the
     * end-of-batch reconciliation — the other half is the incarnation's live
     * execution set. Entries carry everything needed to START an attempt from
     * state alone (model, expiry), so recovery never depends on the requested
     * event being redelivered. Terminal events delete the entry.
     */
    requests: z
      .record(
        z.string(),
        z.object({
          status: z.enum(["requested", "started"]),
          model: z.string().min(1),
          /** Epoch ms past which no attempt may START; stale intent settles
           * as an expired failure instead (only-settle-past-expiry). */
          expiresAt: z.number().int().positive(),
        }),
      )
      .default({}),
  }),
  events: {
    "events.iterate.com/openai-ws/llm-request-started": {
      description: "The OpenAI WebSocket processor started an agent LLM request.",
      payloadSchema: z.object({
        llmRequestId: z.number().int().positive(),
        model: z.string().min(1),
      }),
    },
    "events.iterate.com/openai-ws/llm-response-chunk": {
      description: "One raw frame received from the OpenAI Responses WebSocket.",
      payloadSchema: z.object({
        chunk: z.unknown(),
        llmRequestId: z.number().int().positive(),
        sequence: z.number().int().nonnegative(),
      }),
    },
    "events.iterate.com/openai-ws/llm-request-completed": {
      description: "The OpenAI WebSocket processor finished an agent LLM request.",
      payloadSchema: z.object({
        durationMs: z.number().int().nonnegative(),
        llmRequestId: z.number().int().positive(),
        result: z.discriminatedUnion("status", [
          z.object({
            rawResponse: z.unknown().optional(),
            status: z.literal("success"),
            usage: z.unknown().optional(),
          }),
          z.object({
            error: z.object({ message: z.string() }),
            rawResponse: z.unknown().optional(),
            status: z.literal("failure"),
          }),
        ]),
      }),
    },
  },
  processorDeps: [AgentProcessorContract],
  consumes: [
    "events.iterate.com/agent/llm-request-requested",
    "events.iterate.com/agent/llm-request-cancelled",
    "events.iterate.com/openai-ws/llm-request-started",
    "events.iterate.com/openai-ws/llm-request-completed",
  ],
  emits: [
    "events.iterate.com/openai-ws/llm-request-started",
    "events.iterate.com/openai-ws/llm-response-chunk",
    "events.iterate.com/openai-ws/llm-request-completed",
    "events.iterate.com/agent/output-added",
    "events.iterate.com/agent/llm-request-completed",
  ],
});

/**
 * The contract's type under the same identifier, so type-level helpers read
 * without `typeof`: `ProcessorState<OpenAiWsProcessorContract>`,
 * `ConsumedEvent<OpenAiWsProcessorContract>`, `ProcessorEvent<OpenAiWsProcessorContract, T>`.
 */
export type OpenAiWsProcessorContract = typeof OpenAiWsProcessorContract;
