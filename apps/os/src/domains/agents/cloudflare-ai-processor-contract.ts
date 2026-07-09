import { z } from "zod";
import { defineProcessorContract } from "../streams/processor-contracts.ts";
import { AgentProcessorContract } from "./agent-processor-contract.ts";

export const CloudflareAiProcessorContract = defineProcessorContract({
  slug: "cloudflare-ai",
  version: "0.1.0",
  description: "Runs agent LLM requests through an AI binding shaped like env.AI.",
  stateSchema: z.object({
    /**
     * The provider's open OBLIGATIONS, keyed by llmRequestId — the exact
     * shape (and reconciliation semantics) of the openai-ws sibling; see
     * OpenAiWsProcessorContract.stateSchema. The earlier shape here only
     * tracked started/completed, so a request whose incarnation died between
     * `requested` and `started` was invisible to recovery — the sibling
     * drift this contract's parity now prevents.
     */
    requests: z
      .record(
        z.string(),
        z.object({
          status: z.enum(["requested", "started"]),
          model: z.string().min(1),
          /** Epoch ms past which no attempt may START (only-settle-past-expiry). */
          expiresAt: z.number().int().positive(),
        }),
      )
      .default({}),
  }),
  events: {
    "events.iterate.com/cloudflare-ai/llm-request-started": {
      description: "The Cloudflare AI processor started an agent LLM request.",
      payloadSchema: z.object({
        llmRequestId: z.number().int().positive(),
        model: z.string().min(1),
      }),
    },
    "events.iterate.com/cloudflare-ai/llm-response-chunk": {
      description: "One streamed provider chunk received from the AI binding.",
      payloadSchema: z.object({
        chunk: z.unknown(),
        llmRequestId: z.number().int().positive(),
        sequence: z.number().int().nonnegative(),
      }),
    },
    "events.iterate.com/cloudflare-ai/llm-request-completed": {
      description: "The Cloudflare AI processor finished an agent LLM request.",
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
    "events.iterate.com/agent/llm-request-completed",
    "events.iterate.com/cloudflare-ai/llm-request-started",
    "events.iterate.com/cloudflare-ai/llm-request-completed",
  ],
  emits: [
    "events.iterate.com/cloudflare-ai/llm-request-started",
    "events.iterate.com/cloudflare-ai/llm-response-chunk",
    "events.iterate.com/cloudflare-ai/llm-request-completed",
    "events.iterate.com/agent/output-added",
    "events.iterate.com/agent/llm-request-completed",
  ],
});

/**
 * The contract's type under the same identifier, so type-level helpers read
 * without `typeof`: `ProcessorState<CloudflareAiProcessorContract>`,
 * `ConsumedEvent<CloudflareAiProcessorContract>`, `ProcessorEvent<CloudflareAiProcessorContract, T>`.
 */
export type CloudflareAiProcessorContract = typeof CloudflareAiProcessorContract;
