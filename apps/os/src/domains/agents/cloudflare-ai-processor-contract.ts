import { z } from "zod";
import { defineProcessorContract } from "../streams/processor-contracts.ts";
import { AgentProcessorContract } from "./agent-processor-contract.ts";

export const CloudflareAiProcessorContract = defineProcessorContract({
  slug: "cloudflare-ai",
  version: "0.1.0",
  description: "Runs agent LLM requests through an AI binding shaped like env.AI.",
  stateSchema: z.object({
    requests: z
      .record(z.string(), z.object({ status: z.enum(["started", "completed"]) }))
      .default({}),
  }),
  events: {
    "events.iterate.com/cloudflare-ai/llm-request-started": {
      description: "The Cloudflare AI processor started an agent LLM request.",
      payloadSchema: z.object({
        llmRequestId: z.number().int().positive(),
        model: z.string().min(1),
      }),
      examples: [
        {
          description:
            "The provider picks up a scheduled request; llmRequestId is the stream offset of the agent's llm-request-requested event.",
          payload: { llmRequestId: 117, model: "@cf/moonshotai/kimi-k2.7-code" },
        },
      ],
    },
    "events.iterate.com/cloudflare-ai/llm-response-chunk": {
      description: "One streamed provider chunk received from the AI binding.",
      payloadSchema: z.object({
        chunk: z.unknown(),
        llmRequestId: z.number().int().positive(),
        sequence: z.number().int().nonnegative(),
      }),
      examples: [
        {
          description: "The first streamed Workers AI delta of a response.",
          payload: { chunk: { response: "Hello" }, llmRequestId: 117, sequence: 0 },
        },
      ],
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
      examples: [
        {
          description: "The request finished successfully after a few seconds of streaming.",
          payload: {
            durationMs: 2843,
            llmRequestId: 117,
            result: {
              status: "success",
              usage: { completion_tokens: 96, prompt_tokens: 412, total_tokens: 508 },
            },
          },
        },
        {
          description: "The request failed because the model was temporarily overloaded.",
          payload: {
            durationMs: 4519,
            llmRequestId: 121,
            result: {
              error: {
                message:
                  "InferenceUpstreamError: 3040: Capacity temporarily exceeded for @cf/moonshotai/kimi-k2.7-code, please try again",
              },
              status: "failure",
            },
          },
        },
      ],
    },
  },
  processorDeps: [AgentProcessorContract],
  consumes: [
    "events.iterate.com/agent/llm-request-requested",
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
