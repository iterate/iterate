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
} from "@iterate-com/shared/streams/stream-processors";
import { CoreProcessorContract } from "~/domains/streams/engine/processors/core/contract.ts";
import { ItxContract } from "~/itx/contract.ts";

export const DEFAULT_WORKERS_AI_AGENT_MODEL = "@cf/moonshotai/kimi-k2.7-code";
export const DEFAULT_AGENT_LLM_REQUEST_DEBOUNCE_MS = 1000;

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
      })
      .default({ model: DEFAULT_WORKERS_AI_AGENT_MODEL }),
    llmProvider: z.enum(["openai-ws", "cloudflare-ai"]).nullable().default(null),
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
           * on the same llm-request-requested append.
           */
          scheduledOffset: z.number().int().positive(),
        }),
        z.object({ phase: z.literal("requested"), llmRequestId: z.number().int().positive() }),
      ])
      .nullable()
      .default(null),
    pendingTriggerCount: z.number().int().nonnegative().default(0),
    /**
     * Offset of the latest model-visible input that asked for an LLM request
     * but is not yet covered by a durable scheduling/queueing fact. Set by a
     * triggering `input-added`, cleared by `llm-request-scheduled` /
     * `llm-request-requested` / `llm-request-queued`. In live operation the
     * window between set and clear is brief; if it survives in reduced state
     * after a restart, `subscriber-connected` reconciliation can re-run the
     * idempotent scheduling append for that input.
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
    "events.iterate.com/agent/config-updated": {
      description:
        "Project-authored agent configuration. The agent processor turns this birth/config fact into concrete setup facts and runtime side effects.",
      examples: [
        {
          description: "Configure a web agent's default prompt",
          payload: {
            systemPrompt: "You are the Iterate web agent for /agents/demo.",
          },
        },
      ],
      payloadSchema: z.object({
        systemPrompt: z.string().optional(),
      }),
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
    "events.iterate.com/agents/user-message-received": {
      description: "Inbound user chat message before it is rendered into model context.",
      examples: [
        {
          description: "Web chat message",
          payload: { content: "What can you help me with?", origin: "web" },
        },
        {
          description: "TUI chat message",
          payload: { content: "What can you help me with?", origin: "tui" },
        },
      ],
      payloadSchema: z.object({
        origin: z.enum(["web", "tui"]),
        content: z.string(),
      }),
    },
    "events.iterate.com/agents/agent-message-received": {
      description:
        "Inbound message from an AI agent acting on behalf of the project owner before it is rendered into model context.",
      examples: [
        {
          description: "Agent-to-agent request",
          payload: { message: "Check whether the project has any failing deployment checks." },
        },
      ],
      payloadSchema: z.object({
        message: z.string(),
      }),
    },
    "events.iterate.com/agents/web-message-sent": {
      description: "User-visible web chat response emitted by a tool call.",
      examples: [
        {
          description: "Assistant reply via web",
          payload: {
            message: "I can help you manage your project, run code, and more.",
          },
        },
      ],
      payloadSchema: z.object({
        message: z.string(),
      }),
    },
    "events.iterate.com/agents/tui-message-sent": {
      description: "User-visible TUI chat response emitted by a tool call.",
      examples: [
        {
          description: "Assistant reply via TUI",
          payload: {
            message: "I can help you manage your project, run code, and more.",
          },
        },
      ],
      payloadSchema: z.object({
        message: z.string(),
      }),
    },
    "events.iterate.com/agents/agent-message-sent": {
      description: "Response emitted to an AI agent that asked this agent for help.",
      examples: [
        {
          description: "Assistant reply to another agent",
          payload: {
            message: "The project has two active agents and no failing checks.",
          },
        },
      ],
      payloadSchema: z.object({
        message: z.string(),
      }),
    },
    "events.iterate.com/agent/output-added": {
      description: "A model-visible assistant output row.",
      payloadSchema: z.object({
        content: z.string(),
        llmRequestId: z.number().int().positive().optional(),
      }),
    },
    "events.iterate.com/agent/llm-provider-selected": {
      description: "Selects the LLM provider processor and model for future LLM requests.",
      payloadSchema: z.object({
        ifUnset: z.boolean().optional(),
        model: z.string().min(1),
        provider: z.enum(["openai-ws", "cloudflare-ai"]),
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
      payloadSchema: z.strictObject({
        model: z.string().min(1),
        provider: z.enum(["openai-ws", "cloudflare-ai"]),
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
    "events.iterate.com/itx/script-execution-completed",
    "events.iterate.com/stream/subscriber-connected",
    "events.iterate.com/agents/user-message-received",
    "events.iterate.com/agents/agent-message-received",
    "events.iterate.com/agents/web-message-sent",
    "events.iterate.com/agents/tui-message-sent",
    "events.iterate.com/agents/agent-message-sent",
    "events.iterate.com/agent/system-prompt-updated",
    "events.iterate.com/agent/config-updated",
    "events.iterate.com/agent/input-added",
    "events.iterate.com/agent/output-added",
    "events.iterate.com/agent/llm-provider-selected",
    "events.iterate.com/agent/llm-request-scheduled",
    "events.iterate.com/agent/llm-request-requested",
    "events.iterate.com/agent/llm-request-completed",
    "events.iterate.com/agent/llm-request-cancelled",
    "events.iterate.com/agent/llm-request-queued",
    "events.iterate.com/agent/status-updated",
  ],
  emits: [
    "events.iterate.com/itx/script-execution-requested",
    "events.iterate.com/agent/system-prompt-updated",
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
    case "events.iterate.com/itx/script-execution-completed":
    case "events.iterate.com/stream/subscriber-connected":
    case "events.iterate.com/agents/user-message-received":
    case "events.iterate.com/agents/agent-message-received":
    case "events.iterate.com/agents/web-message-sent":
    case "events.iterate.com/agents/tui-message-sent":
    case "events.iterate.com/agents/agent-message-sent":
      return state;
    case "events.iterate.com/agent/config-updated":
      return event.payload.systemPrompt === undefined
        ? state
        : { ...state, systemPrompt: event.payload.systemPrompt };
    case "events.iterate.com/agent/system-prompt-updated":
      return { ...state, systemPrompt: event.payload.systemPrompt };
    case "events.iterate.com/agent/input-added":
      return {
        ...state,
        history: [...state.history, { role: "user" as const, content: event.payload.content }],
        pendingTriggerOffset:
          event.payload.llmRequestPolicy.behaviour === "dont-trigger-request"
            ? state.pendingTriggerOffset
            : event.offset,
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
    case "events.iterate.com/agent/llm-provider-selected":
      if (event.payload.ifUnset === true && state.llmProvider !== null) return state;
      return {
        ...state,
        llmConfig: { model: event.payload.model },
        llmProvider: event.payload.provider,
      };
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
