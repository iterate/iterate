// Defines the "cloudflare-ai" processor contract on the class-based stream model.
//
// Migrated from packages/shared/src/stream-processors/cloudflare-ai/contract.ts.
// Wire formats (event types and payload schemas) are unchanged.

import { z } from "zod";
import { defineProcessorContract } from "@iterate-com/streams/shared/stream-processors";
import { CoreProcessorContract } from "@iterate-com/streams/processors/core/contract";
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
  processorDeps: [AgentProcessorContract, CoreProcessorContract],
  events: {
    "events.iterate.com/cloudflare-ai/llm-request-attempt-failed": {
      description:
        "An execution attempt for an agent LLM request died before its terminal events landed (e.g. the hosting durable object crashed mid-request). Appended by the reconciler before it re-executes, so the stream honestly records the crash and the retry.",
      payloadSchema: z.object({
        llmRequestId: LlmRequestId,
        reason: z.enum(["host-restarted", "unrecoverable"]),
      }),
    },
    "events.iterate.com/cloudflare-ai/llm-request-started": {
      description:
        "The Cloudflare AI processor started executing an agent LLM request. The llmRequestId is the offset of the source agent/llm-request-requested event; the chat request is rebuilt from stream history up to that offset, never embedded.",
      payloadSchema: z.object({
        llmRequestId: LlmRequestId,
        model: z.string().min(1),
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
    // The reconcile trigger: a fresh subscriber connection means some host's
    // runtime state was reset — check for started-but-not-executing requests.
    "events.iterate.com/stream/subscriber-connected",
  ],
  emits: [
    "events.iterate.com/cloudflare-ai/llm-request-started",
    "events.iterate.com/cloudflare-ai/llm-request-attempt-failed",
    "events.iterate.com/cloudflare-ai/llm-request-completed",
    "events.iterate.com/agent/output-added",
    "events.iterate.com/agent/llm-request-completed",
  ],
});

export type CloudflareAiState = z.infer<typeof CloudflareAiProcessorContract.stateSchema>;
