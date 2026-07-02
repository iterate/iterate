import { z } from "zod";
import { defineProcessorContract } from "../streams/stream-processor.ts";
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
