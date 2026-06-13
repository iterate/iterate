// Defines the "agent" processor contract on the class-based stream model.
//
// Frontend-safe public contract for the agent processor: keep this file free of
// Durable Objects, WorkerEntrypoints, `Ai`, `Fetcher`, dynamic worker loaders,
// MCP clients, and other backend-only runtime objects. UIs can import this
// module to project stream events into display state without constructing the
// backend processor class.
//
// Contract announcements ride the host's `stream/subscriber-connected` fact;
// there is no per-processor registration slice.

import { z } from "zod";
import {
  assertNever,
  defineProcessorContract,
  getConsumedEventDefinition,
  getEventSchema,
  getInitialProcessorState,
  type ConsumedEvent,
  type StreamEvent,
} from "@iterate-com/streams/shared/stream-processors";
import { CoreProcessorContract } from "@iterate-com/streams/processors/core/contract";
import { ItxContract } from "~/itx/contract.ts";

export const DEFAULT_WORKERS_AI_AGENT_MODEL = "@cf/moonshotai/kimi-k2.6";

export const AgentProcessorContract = defineProcessorContract({
  slug: "agent",
  version: "0.1.0",
  description:
    "Maintains model-visible agent history and requests LLM work from a subscribed LLM request processor.",
  stateSchema: z.object({
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
        z.object({
          phase: z.literal("scheduled"),
          requestId: z.string(),
          /**
           * Offset of the llm-request-scheduled event. The durable half of the
           * debounce: a fresh instance (whose in-memory timer died with its
           * predecessor) re-derives the request handoff — and its idempotency
           * key — from this, so the recovery path and the timer path converge
           * on the same llm-request-requested append. Optional so checkpoints
           * written before this field existed still parse; recovery falls
           * back to finding the scheduled event in stream history.
           */
          scheduledOffset: z.number().int().positive().optional(),
        }),
        z.object({ phase: z.literal("requested"), llmRequestId: z.number().int().positive() }),
      ])
      .nullable()
      .default(null),
    pendingTriggerCount: z.number().int().nonnegative().default(0),
    /**
     * Offset of the latest model-visible input that asked for an LLM request
     * but is not yet covered by a durable request fact. Set by a triggering
     * `input-added`, cleared by `llm-request-scheduled` / `llm-request-requested`
     * / `llm-request-queued`. In live operation the window between set and
     * clear is brief; if it survives in reduced state it means the input's
     * scheduling side effect never ran — e.g. the input landed at or below the
     * host's side-effect anchor because it was appended before this processor's
     * subscription was configured — and the `subscriber-connected`
     * reconciliation owes the stream a schedule for it. Optional so checkpoints
     * written before this field existed still parse.
     */
    pendingTriggerOffset: z.number().int().positive().nullable().default(null),
  }),
  initialState: {},
  // The core contract owns `stream/subscriber-connected`, the scheduler's
  // reconcile trigger; the itx contract owns `itx/capability-provided`, which
  // we render into model-visible context so the LLM learns its tools (the same
  // event whose fold makes `itx.<name>` resolve — one abstraction, two readers).
  processorDeps: [CoreProcessorContract, ItxContract],
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
        "The agent has prepared an LLM request. A subscribed LLM request processor must execute it and respond with agent output and a terminal llm-request-completed event. The llmRequestId used by response events is this event's stream offset. REQUEST-BY-REFERENCE: the event carries no conversation body — embedding it would store a full copy of the growing history in every request (O(N²) stream growth). Providers rebuild the chat request by reducing committed history up to this event's offset (buildLlmChatRequest), which reproduces the exact model-visible context from the stream forever.",
      payloadSchema: z.object({
        model: z.string().min(1),
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
    "events.iterate.com/itx/capability-provided",
    "events.iterate.com/stream/subscriber-connected",
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
    "events.iterate.com/agent/input-added",
    "events.iterate.com/agent/llm-request-scheduled",
    "events.iterate.com/agent/llm-request-requested",
    "events.iterate.com/agent/llm-request-cancelled",
    "events.iterate.com/agent/llm-request-queued",
    "events.iterate.com/agent/status-updated",
  ],
});

export type AgentState = z.infer<typeof AgentProcessorContract.stateSchema>;
export type AgentConsumedEvent = ConsumedEvent<typeof AgentProcessorContract>;

/**
 * Pure projection of one consumed agent event into the next state. The
 * `AgentProcessor` class's `reduce` hook delegates here; LLM provider
 * processors and the agent's own debounce handoff use `reduceAgentEvents` to
 * rebuild this state from durable stream history.
 */
export function reduceAgentEvent(args: { state: AgentState; event: AgentConsumedEvent }) {
  const { state, event } = args;
  // subscriber-connected is consumed for side effects only (the scheduler's
  // reconcile trigger); like capability-provided it leaves state alone (the
  // capability table is the itx core's fold, not this projection's concern).
  switch (event.type) {
    case "events.iterate.com/itx/capability-provided":
    case "events.iterate.com/stream/subscriber-connected":
      return state;
    case "events.iterate.com/agent/system-prompt-updated":
      return { ...state, systemPrompt: event.payload.systemPrompt };
    case "events.iterate.com/agent/input-added":
      return {
        ...state,
        history: [...state.history, { role: "user" as const, content: event.payload.content }],
        ...(event.payload.llmRequestPolicy.behaviour === "dont-trigger-request"
          ? {}
          : { pendingTriggerOffset: event.offset }),
      };
    case "events.iterate.com/agent/output-added":
      if (
        event.payload.llmRequestId != null &&
        (state.currentRequest?.phase !== "requested" ||
          state.currentRequest.llmRequestId !== event.payload.llmRequestId)
      ) {
        return state;
      }
      return {
        ...state,
        history: [...state.history, { role: "assistant" as const, content: event.payload.content }],
      };
    case "events.iterate.com/agent/llm-config-updated":
      return { ...state, llmConfig: event.payload };
    case "events.iterate.com/agent/llm-request-scheduled":
      return {
        ...state,
        currentRequest: {
          phase: "scheduled" as const,
          requestId: event.payload.requestId,
          scheduledOffset: event.offset,
        },
        pendingTriggerCount: 0,
        pendingTriggerOffset: null,
      };
    case "events.iterate.com/agent/llm-request-requested":
      return {
        ...state,
        currentRequest: { phase: "requested" as const, llmRequestId: event.offset },
        pendingTriggerOffset: null,
      };
    case "events.iterate.com/agent/llm-request-completed":
      return state.currentRequest?.phase === "requested" &&
        state.currentRequest.llmRequestId === event.payload.llmRequestId
        ? { ...state, currentRequest: null }
        : state;
    case "events.iterate.com/agent/llm-request-cancelled":
      if (
        event.payload.phase === "scheduled" &&
        state.currentRequest?.phase === "scheduled" &&
        state.currentRequest.requestId === event.payload.requestId
      ) {
        return { ...state, currentRequest: null };
      }
      if (
        event.payload.phase === "requested" &&
        state.currentRequest?.phase === "requested" &&
        state.currentRequest.llmRequestId === event.payload.llmRequestId
      ) {
        return { ...state, currentRequest: null };
      }
      return state;
    case "events.iterate.com/agent/llm-request-queued":
      return {
        ...state,
        pendingTriggerCount: state.pendingTriggerCount + 1,
        pendingTriggerOffset: null,
      };
    // Consumed for side effects only; no state change.
    case "events.iterate.com/agent/status-updated":
      return state;
    default:
      return assertNever(event);
  }
}

/** Fold raw stream events into agent state, skipping non-consumed event types. */
export function reduceAgentEvents(args: {
  events: readonly StreamEvent[];
  state?: AgentState;
}): AgentState {
  let state = args.state ?? getInitialProcessorState(AgentProcessorContract);
  for (const event of args.events) {
    const definition = getConsumedEventDefinition({
      contract: AgentProcessorContract,
      eventType: event.type,
    });
    if (definition === undefined) continue;
    const parsed = getEventSchema({
      type: event.type,
      payloadSchema: definition.payloadSchema,
    }).parse(event) as AgentConsumedEvent;
    state = reduceAgentEvent({ state, event: parsed });
  }
  return state;
}

/**
 * Build the provider-agnostic chat request from reduced state only. LLM request
 * processors receive this rendered body through `agent/llm-request-requested`.
 */
export function buildLlmChatRequest(state: AgentState) {
  return {
    messages: [
      { role: "system" as const, content: state.systemPrompt },
      ...state.history.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    ],
  };
}
