// Defines the "openai-ws" processor contract on the class-based stream model.
//
// OpenAI Responses WebSocket mode uses `response.create` messages on a
// WebSocket connection and emits the same streaming event family as ordinary
// Responses streaming. https://developers.openai.com/api/docs/guides/websocket-mode

import { z } from "zod";
import { defineProcessorContract } from "@iterate-com/streams/shared/stream-processors";
import { CoreProcessorContract } from "@iterate-com/streams/processors/core/contract";
import { AgentProcessorContract } from "../agent/contract.ts";

const LlmRequestId = z.number().int().positive();

export const OpenAiWsProcessorContract = defineProcessorContract({
  slug: "openai-ws",
  version: "0.1.0",
  description:
    "Executes agent LLM requests through OpenAI Responses WebSocket mode, recording raw socket transcript events and appending the agent-level output and terminal request event owed by the LLM request processor contract.",
  stateSchema: z.object({
    model: z.string().min(1).default("gpt-5.5"),
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
    "events.iterate.com/openai-ws/llm-request-attempt-failed": {
      description:
        "An execution attempt for an agent LLM request died before its terminal events landed (e.g. the hosting durable object crashed mid-request). Appended by the reconciler before it re-executes, so the stream honestly records the crash and the retry.",
      payloadSchema: z.object({
        llmRequestId: LlmRequestId,
        reason: z.enum(["host-restarted", "unrecoverable"]),
      }),
    },
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
    "events.iterate.com/openai-ws/config-updated",
    "events.iterate.com/openai-ws/llm-request-started",
    "events.iterate.com/openai-ws/llm-request-completed",
    "events.iterate.com/agent/llm-request-requested",
    // The reconcile trigger: a fresh subscriber connection means some host's
    // runtime state was reset — check for started-but-not-executing requests.
    "events.iterate.com/stream/subscriber-connected",
  ],
  emits: [
    "events.iterate.com/openai-ws/websocket-connected",
    "events.iterate.com/openai-ws/websocket-disconnected",
    "events.iterate.com/openai-ws/websocket-message-sent",
    "events.iterate.com/openai-ws/websocket-message-received",
    "events.iterate.com/openai-ws/llm-request-started",
    "events.iterate.com/openai-ws/llm-request-attempt-failed",
    "events.iterate.com/openai-ws/llm-request-completed",
    "events.iterate.com/agent/output-added",
    "events.iterate.com/agent/llm-request-completed",
  ],
});

export type OpenAiWsState = z.infer<typeof OpenAiWsProcessorContract.stateSchema>;
