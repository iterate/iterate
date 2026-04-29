import { z } from "zod";
import {
  assertNever,
  defineProcessorContract,
  reduceProcessorEvents,
  type StreamEvent,
} from "@iterate-com/shared/stream-processors";
import { CoreProcessorRegisteredEventType } from "../core/contract.ts";
import { standardProcessorBehavior } from "../core/standard-processor-behavior.ts";

/**
 * Frontend-safe public contract for the agent processor.
 *
 * Keep this file free of Durable Objects, WorkerEntrypoints, `Ai`, `Fetcher`,
 * dynamic worker loaders, MCP clients, and other backend-only runtime objects.
 * The agents UI can import this module to project stream events into
 * display state without constructing the backend processor implementation.
 */
export const AgentProcessorContract = defineProcessorContract({
  slug: "agent",
  version: "0.1.0",
  description:
    "Maintains model-visible agent history and the frontend-visible LLM request projection.",
  stateSchema: z.object({
    ...standardProcessorBehavior.stateShape,
    systemPrompt: z.string().default("You are a helpful assistant. You can trust your user."),
    history: z
      .array(
        z.object({
          role: z.enum(["user", "assistant"]),
          content: z.string(),
        }),
      )
      .default([]),
    llmConfig: z
      .object({
        model: z.string().min(1),
        runOpts: z.json().default({}),
        debounceMs: z.number().int().nonnegative().default(1000),
      })
      .default({ model: "@cf/moonshotai/kimi-k2.5", runOpts: {}, debounceMs: 1000 }),
    currentRequest: z.object({ requestId: z.string() }).nullable().default(null),
    pendingTriggerCount: z.number().int().nonnegative().default(0),
  }),
  initialState: {
    ...standardProcessorBehavior.initialState,
  },
  processorDeps: [...standardProcessorBehavior.processorDeps],
  events: {
    "events.iterate.com/agent/system-prompt-updated": {
      description: "Updates the system prompt used for future LLM requests.",
      payloadSchema: z.object({ systemPrompt: z.string() }),
    },
    "events.iterate.com/agent/webchat-message-received": {
      description: "Raw inbound webchat message before it is rendered into model context.",
      payloadSchema: z.object({ content: z.string() }),
    },
    "events.iterate.com/agent/webchat-response-added": {
      description: "User-visible webchat response emitted by a tool call.",
      payloadSchema: z.object({ message: z.string() }),
    },
    "events.iterate.com/agent/input-added": {
      description: "A curated model-visible row of agent context.",
      payloadSchema: z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
        triggerLlmRequest: z
          .discriminatedUnion("behaviour", [
            z.object({ behaviour: z.literal("auto") }),
            z.object({ behaviour: z.literal("dont-trigger-request") }),
            z.object({ behaviour: z.literal("interrupt-current-request") }),
            z.object({ behaviour: z.literal("after-current-request") }),
            z.object({
              behaviour: z.literal("trigger-request-within-time-period"),
              withinMs: z.number().int().nonnegative(),
            }),
          ])
          .default({ behaviour: "auto" }),
      }),
    },
    "events.iterate.com/agent/llm-config-updated": {
      description: "Updates model configuration for future LLM requests.",
      payloadSchema: z.object({
        model: z.string().min(1),
        runOpts: z.json().default({}),
        debounceMs: z.number().int().nonnegative().default(1000),
      }),
    },
    "events.iterate.com/agent/llm-request-scheduled": {
      description: "An LLM request was scheduled after a trigger.",
      payloadSchema: z.object({
        requestId: z.string(),
        debounceMs: z.number().int().nonnegative(),
        model: z.string().min(1),
      }),
    },
    "events.iterate.com/agent/llm-request-started": {
      description: "The scheduled LLM request started running.",
      payloadSchema: z.object({
        requestId: z.string(),
        model: z.string().min(1),
        body: z.object({
          messages: z
            .array(
              z.object({
                role: z.enum(["system", "user", "assistant"]),
                content: z.string(),
              }),
            )
            .min(1),
          max_tokens: z.number().int().positive().optional(),
          temperature: z.number().optional(),
          top_p: z.number().optional(),
        }),
        runOpts: z.json().default({}),
      }),
    },
    "events.iterate.com/agent/llm-request-completed": {
      description: "The LLM request completed successfully.",
      payloadSchema: z.object({
        requestId: z.string(),
        rawResponse: z.json(),
        durationMs: z.number().int().nonnegative(),
      }),
    },
    "events.iterate.com/agent/llm-request-failed": {
      description: "The LLM request failed before producing a usable assistant turn.",
      payloadSchema: z.object({
        requestId: z.string(),
        durationMs: z.number().int().nonnegative(),
        error: z.object({ message: z.string() }),
        rawResponse: z.json().optional(),
      }),
    },
    "events.iterate.com/agent/llm-request-cancelled": {
      description: "The LLM request was cancelled before completion.",
      payloadSchema: z.object({
        requestId: z.string(),
        reason: z.enum(["interrupted-by-user-input", "deadline-exceeded"]),
      }),
    },
    "events.iterate.com/agent/llm-request-queued": {
      description: "A follow-up trigger arrived while a request was already in flight.",
      payloadSchema: z.object({}),
    },
    "events.iterate.com/agent/status-updated": {
      description: "User-facing busy/idle status for the agent processor.",
      payloadSchema: z.object({
        status: z.enum(["working", "idle"]),
        reason: z.string(),
        requestId: z.string().optional(),
      }),
    },
  },
  consumes: [
    ...standardProcessorBehavior.consumes,
    "events.iterate.com/agent/system-prompt-updated",
    "events.iterate.com/agent/webchat-message-received",
    "events.iterate.com/agent/webchat-response-added",
    "events.iterate.com/agent/input-added",
    "events.iterate.com/agent/llm-config-updated",
    "events.iterate.com/agent/llm-request-scheduled",
    "events.iterate.com/agent/llm-request-started",
    "events.iterate.com/agent/llm-request-completed",
    "events.iterate.com/agent/llm-request-failed",
    "events.iterate.com/agent/llm-request-cancelled",
    "events.iterate.com/agent/llm-request-queued",
    "events.iterate.com/agent/status-updated",
  ],
  emits: [
    ...standardProcessorBehavior.emits,
    "events.iterate.com/agent/input-added",
    "events.iterate.com/agent/llm-request-scheduled",
    "events.iterate.com/agent/llm-request-started",
    "events.iterate.com/agent/llm-request-completed",
    "events.iterate.com/agent/llm-request-failed",
    "events.iterate.com/agent/llm-request-cancelled",
    "events.iterate.com/agent/llm-request-queued",
    "events.iterate.com/agent/status-updated",
  ],
  reduce({ contract, state, event }) {
    const nextState = standardProcessorBehavior.reduce({
      state,
      event,
      contract,
    });

    switch (event.type) {
      case CoreProcessorRegisteredEventType:
        return nextState;
      case "events.iterate.com/agent/system-prompt-updated":
        return { ...nextState, systemPrompt: event.payload.systemPrompt };
      case "events.iterate.com/agent/input-added":
        return {
          ...nextState,
          history: [
            ...nextState.history,
            { role: event.payload.role, content: event.payload.content },
          ],
        };
      case "events.iterate.com/agent/llm-config-updated":
        return { ...nextState, llmConfig: event.payload };
      case "events.iterate.com/agent/llm-request-scheduled":
        return {
          ...nextState,
          currentRequest: { requestId: event.payload.requestId },
          pendingTriggerCount: 0,
        };
      case "events.iterate.com/agent/llm-request-started":
        return {
          ...nextState,
          currentRequest: { requestId: event.payload.requestId },
        };
      case "events.iterate.com/agent/llm-request-completed":
      case "events.iterate.com/agent/llm-request-failed":
      case "events.iterate.com/agent/llm-request-cancelled":
        return nextState.currentRequest?.requestId === event.payload.requestId
          ? { ...nextState, currentRequest: null }
          : nextState;
      case "events.iterate.com/agent/llm-request-queued":
        return {
          ...nextState,
          pendingTriggerCount: nextState.pendingTriggerCount + 1,
        };

      // we consume these events, but they don't update our state but they do cause side-effects in the implementation
      case "events.iterate.com/agent/status-updated":
      case "events.iterate.com/agent/webchat-message-received":
      case "events.iterate.com/agent/webchat-response-added":
        return nextState;
      default:
        return assertNever(event);
    }
  },
});

export function reduceAgentEvents(args: {
  events: readonly StreamEvent[];
  state?: AgentState;
}): AgentState {
  return reduceProcessorEvents({
    contract: AgentProcessorContract,
    events: args.events,
    state: args.state,
  });
}

export type AgentState = z.infer<typeof AgentProcessorContract.stateSchema>;
