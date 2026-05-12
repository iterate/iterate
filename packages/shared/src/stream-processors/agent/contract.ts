import { z } from "zod";
import {
  assertNever,
  defineProcessorContract,
  reduceProcessorEvents,
  type StreamEvent,
} from "../stream-processor.ts";
import { CoreProcessorRegisteredEventType } from "../core/contract.ts";
import { standardProcessorBehavior } from "../core/standard-processor-behavior.ts";
import { CodemodeProcessorContract } from "../codemode/contract.ts";

export const DEFAULT_WORKERS_AI_AGENT_MODEL = "@cf/moonshotai/kimi-k2.6";

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
    "Maintains model-visible agent history and requests LLM work from a subscribed LLM request processor.",
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
      .default({ model: DEFAULT_WORKERS_AI_AGENT_MODEL, runOpts: {}, debounceMs: 1000 }),
    currentRequest: z
      .discriminatedUnion("phase", [
        z.object({ phase: z.literal("scheduled"), requestId: z.string() }),
        z.object({ phase: z.literal("requested"), llmRequestId: z.number().int().positive() }),
      ])
      .nullable()
      .default(null),
    pendingTriggerCount: z.number().int().nonnegative().default(0),
  }),
  initialState: {
    ...standardProcessorBehavior.initialState,
  },
  processorDeps: [...standardProcessorBehavior.processorDeps, CodemodeProcessorContract],
  events: {
    "events.iterate.com/agent/system-prompt-updated": {
      description: "Updates the system prompt used for future LLM requests.",
      examples: [
        {
          description: "Set a focused system prompt",
          payload: {
            systemPrompt:
              "You are a deployment assistant. Help the user check service health and review recent deploys.",
          },
        },
      ],
      payloadSchema: z.object({ systemPrompt: z.string() }),
    },
    "events.iterate.com/agent/input-added": {
      description: "A curated model-visible row of agent context.",
      examples: [
        {
          description:
            "User input that uses the default policy: request an LLM response without interrupting in-flight work.",
          payload: {
            content: "Summarize the deployment logs.",
          },
        },
        {
          description: "User input that interrupts the current request before starting a new one.",
          payload: {
            content: "Actually, focus only on failed checks.",
            llmRequestPolicy: { behaviour: "interrupt-current-request" },
          },
        },
      ],
      payloadSchema: z
        .object({
          content: z.string().describe("Model-visible user context to append to agent history."),
          llmRequestPolicy: z
            .discriminatedUnion("behaviour", [
              z.object({ behaviour: z.literal("dont-trigger-request") }),
              z.object({ behaviour: z.literal("interrupt-current-request") }),
              z.object({ behaviour: z.literal("after-current-request") }),
            ])
            .describe("How this input should affect LLM request scheduling.")
            .default({ behaviour: "after-current-request" }),
        })
        .describe("Payload for an agent input row."),
    },
    "events.iterate.com/agent/output-added": {
      description: "A model-visible assistant output row.",
      payloadSchema: z.object({
        content: z.string(),
        llmRequestId: z.number().int().positive().optional(),
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
    "events.iterate.com/agent/llm-request-requested": {
      description:
        "The agent has prepared an LLM request. A subscribed LLM request processor must execute it and respond with agent output and a terminal llm-request-completed event. The llmRequestId used by response events is this event's stream offset.",
      payloadSchema: z.object({
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
      description:
        "A subscribed LLM request processor finished the requested LLM work with either success or failure.",
      payloadSchema: z.object({
        llmRequestId: z.number().int().positive(),
        provider: z.string().min(1),
        durationMs: z.number().int().nonnegative(),
        result: z.discriminatedUnion("status", [
          z.object({
            status: z.literal("success"),
            rawResponse: z.json().optional(),
            usage: z.json().optional(),
            providerResponseId: z.string().optional(),
          }),
          z.object({
            status: z.literal("failure"),
            error: z.object({ message: z.string() }),
            rawResponse: z.json().optional(),
            providerResponseId: z.string().optional(),
          }),
        ]),
      }),
    },
    "events.iterate.com/agent/llm-request-cancelled": {
      description: "The LLM request was cancelled before completion.",
      payloadSchema: z
        .discriminatedUnion("phase", [
          z.object({
            phase: z.literal("scheduled"),
            requestId: z.string(),
            reason: z.literal("interrupted-by-user-input"),
          }),
          z.object({
            phase: z.literal("requested"),
            llmRequestId: z.number().int().positive(),
            reason: z.literal("interrupted-by-user-input"),
          }),
        ])
        .describe("Cancellation fact for either a debounced or in-flight LLM request."),
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
        llmRequestId: z.number().int().positive().optional(),
      }),
    },
  },
  consumes: [
    ...standardProcessorBehavior.consumes,
    "events.iterate.com/codemode/tool-provider-registered",
    "events.iterate.com/agent/system-prompt-updated",
    "events.iterate.com/agent/input-added",
    "events.iterate.com/agent/output-added",
    "events.iterate.com/agent/llm-config-updated",
    "events.iterate.com/agent/llm-request-scheduled",
    "events.iterate.com/agent/llm-request-requested",
    "events.iterate.com/agent/llm-request-completed",
    "events.iterate.com/agent/llm-request-cancelled",
    "events.iterate.com/agent/llm-request-queued",
    "events.iterate.com/agent/status-updated",
  ],
  emits: [
    ...standardProcessorBehavior.emits,
    "events.iterate.com/agent/input-added",
    "events.iterate.com/agent/llm-request-scheduled",
    "events.iterate.com/agent/llm-request-requested",
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
      case "events.iterate.com/codemode/tool-provider-registered":
        return nextState;
      case "events.iterate.com/agent/system-prompt-updated":
        return { ...nextState, systemPrompt: event.payload.systemPrompt };
      case "events.iterate.com/agent/input-added":
        return {
          ...nextState,
          history: [
            ...nextState.history,
            { role: "user" as const, content: event.payload.content },
          ],
        };
      case "events.iterate.com/agent/output-added":
        if (
          event.payload.llmRequestId != null &&
          (nextState.currentRequest?.phase !== "requested" ||
            nextState.currentRequest.llmRequestId !== event.payload.llmRequestId)
        ) {
          return nextState;
        }
        return {
          ...nextState,
          history: [
            ...nextState.history,
            { role: "assistant" as const, content: event.payload.content },
          ],
        };
      case "events.iterate.com/agent/llm-config-updated":
        return { ...nextState, llmConfig: event.payload };
      case "events.iterate.com/agent/llm-request-scheduled":
        return {
          ...nextState,
          currentRequest: { phase: "scheduled" as const, requestId: event.payload.requestId },
          pendingTriggerCount: 0,
        };
      case "events.iterate.com/agent/llm-request-requested":
        return {
          ...nextState,
          currentRequest: { phase: "requested" as const, llmRequestId: event.offset },
        };
      case "events.iterate.com/agent/llm-request-completed":
        return nextState.currentRequest?.phase === "requested" &&
          nextState.currentRequest.llmRequestId === event.payload.llmRequestId
          ? { ...nextState, currentRequest: null }
          : nextState;
      case "events.iterate.com/agent/llm-request-cancelled":
        if (
          event.payload.phase === "scheduled" &&
          nextState.currentRequest?.phase === "scheduled" &&
          nextState.currentRequest.requestId === event.payload.requestId
        ) {
          return { ...nextState, currentRequest: null };
        }
        if (
          event.payload.phase === "requested" &&
          nextState.currentRequest?.phase === "requested" &&
          nextState.currentRequest.llmRequestId === event.payload.llmRequestId
        ) {
          return { ...nextState, currentRequest: null };
        }
        return nextState;
      case "events.iterate.com/agent/llm-request-queued":
        return {
          ...nextState,
          pendingTriggerCount: nextState.pendingTriggerCount + 1,
        };

      // we consume these events, but they don't update our state but they do cause side-effects in the implementation
      case "events.iterate.com/agent/status-updated":
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
