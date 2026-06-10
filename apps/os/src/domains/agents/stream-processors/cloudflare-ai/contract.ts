// Defines the "cloudflare-ai" processor contract on the class-based stream model.
//
// Migrated from packages/shared/src/stream-processors/cloudflare-ai/contract.ts.
// Wire formats (event types and payload schemas) are unchanged.

import { z } from "zod";
import { defineProcessorContract } from "@iterate-com/streams/shared/stream-processors";
import { AgentProcessorContract } from "../agent/contract.ts";

const LlmRequestId = z.number().int().positive();

export const CloudflareAiProcessorContract = defineProcessorContract({
  slug: "cloudflare-ai",
  version: "0.1.0",
  description:
    "Executes agent LLM requests through Cloudflare AI and appends the agent-level output and terminal request event owed by the LLM request processor contract.",
  stateSchema: z.object({
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
  initialState: {},
  processorDeps: [AgentProcessorContract],
  events: {
    "events.iterate.com/cloudflare-ai/llm-request-started": {
      description:
        "The Cloudflare AI processor started executing an agent LLM request. The llmRequestId is the offset of the source agent/llm-request-requested event.",
      payloadSchema: z.object({
        llmRequestId: LlmRequestId,
        model: z.string().min(1),
        body: z.json(),
        runOpts: z.json().default({}),
      }),
    },
    "events.iterate.com/cloudflare-ai/llm-request-completed": {
      description:
        "The Cloudflare AI processor finished executing an agent LLM request with either success or failure.",
      payloadSchema: z.object({
        llmRequestId: LlmRequestId,
        durationMs: z.number().int().nonnegative(),
        result: z.discriminatedUnion("status", [
          z.object({
            status: z.literal("success"),
            rawResponse: z.json().optional(),
            usage: z.json().optional(),
            aiGatewayLogId: z.string().optional(),
          }),
          z.object({
            status: z.literal("failure"),
            error: z.object({ message: z.string() }),
            rawResponse: z.json().optional(),
            aiGatewayLogId: z.string().optional(),
          }),
        ]),
      }),
    },
  },
  consumes: [
    "events.iterate.com/cloudflare-ai/llm-request-started",
    "events.iterate.com/cloudflare-ai/llm-request-completed",
    "events.iterate.com/agent/llm-request-requested",
  ],
  emits: [
    "events.iterate.com/cloudflare-ai/llm-request-started",
    "events.iterate.com/cloudflare-ai/llm-request-completed",
    "events.iterate.com/agent/output-added",
    "events.iterate.com/agent/llm-request-completed",
  ],
});

export type CloudflareAiState = z.infer<typeof CloudflareAiProcessorContract.stateSchema>;
