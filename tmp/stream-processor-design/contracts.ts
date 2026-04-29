import { z } from "zod";
import {
  createEvent,
  defineProcessorContract,
  implementProcessor,
} from "../../packages/shared/src/stream-processors/stream-processor.ts";

/**
 * This file sketches final-ish processor contracts. It intentionally keeps
 * AgentLoop and Codemode separate.
 */

export const ProcessorRegisteredPayload = z.object({
  slug: z.string(),
  version: z.string(),
  description: z.string(),
  consumes: z.array(z.string()),
  emits: z.array(z.string()),
  ownedEvents: z.array(
    z.object({
      type: z.string(),
      description: z.string().optional(),
      jsonSchema: z.unknown(),
    }),
  ),
});

export const CoreStreamProcessorContract = defineProcessorContract({
  slug: "core-stream",
  version: "0.1.0",
  description: "Core stream-owned events used by processor hosts.",
  state: z.object({}).default({}),
  events: {
    ...createEvent({
      type: "processor-registered",
      description: "A processor registered its public contract on this stream.",
      payloadSchema: ProcessorRegisteredPayload,
    }),
  },
  consumes: [],
  emits: ["processor-registered"],
});

export const AgentInputAddedPayload = z.object({
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
});

export const AgentLoopState = z
  .object({
    hasRegisteredCurrentVersion: z.boolean().default(false),
    systemPrompt: z.string().default("You are a helpful assistant."),
    history: z
      .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }))
      .default([]),
    currentRequest: z.object({ requestId: z.string() }).nullable().default(null),
    pendingTriggerCount: z.number().int().nonnegative().default(0),
  })
  .prefault({});

export const AgentLoopProcessorContract = defineProcessorContract({
  slug: "agent-loop",
  version: "0.1.0",
  description: "Maintains LLM-visible context and schedules LLM lifecycle work.",
  state: AgentLoopState,
  processorDeps: [CoreStreamProcessorContract],
  events: {
    ...createEvent({
      type: "agent-input-added",
      description: "A model-visible row of agent context.",
      payloadSchema: AgentInputAddedPayload,
    }),
    ...createEvent({
      type: "llm-request-scheduled",
      description: "The agent loop scheduled a future LLM request.",
      payloadSchema: z.object({
        requestId: z.string(),
        debounceMs: z.number().int().nonnegative(),
        model: z.string(),
      }),
    }),
    ...createEvent({
      type: "llm-request-started",
      description: "The LLM request started.",
      payloadSchema: z.object({ requestId: z.string(), body: z.unknown() }),
    }),
    ...createEvent({
      type: "llm-request-completed",
      description: "The LLM request completed.",
      payloadSchema: z.object({
        requestId: z.string(),
        rawResponse: z.unknown(),
        durationMs: z.number().int().nonnegative(),
      }),
    }),
    ...createEvent({
      type: "llm-request-failed",
      description: "The LLM request failed.",
      payloadSchema: z.object({
        requestId: z.string(),
        error: z.object({ message: z.string() }),
        durationMs: z.number().int().nonnegative(),
      }),
    }),
  },
  consumes: [
    "processor-registered",
    "agent-input-added",
    "llm-request-scheduled",
    "llm-request-started",
    "llm-request-completed",
    "llm-request-failed",
  ],
  emits: [
    "processor-registered",
    "agent-input-added",
    "llm-request-scheduled",
    "llm-request-started",
    "llm-request-completed",
    "llm-request-failed",
  ],
  reduce({ state, event }) {
    switch (event.type) {
      case "processor-registered":
        return event.payload.slug === "agent-loop" &&
          event.payload.version === AgentLoopProcessorContract.version
          ? { ...state, hasRegisteredCurrentVersion: true }
          : undefined;
      case "agent-input-added":
        return {
          ...state,
          history: [...state.history, { role: event.payload.role, content: event.payload.content }],
        };
      case "llm-request-started":
        return { ...state, currentRequest: { requestId: event.payload.requestId } };
      case "llm-request-completed":
      case "llm-request-failed":
        return state.currentRequest?.requestId === event.payload.requestId
          ? { ...state, currentRequest: null }
          : undefined;
      default:
        return undefined;
    }
  },
});

export const CodemodeState = z
  .object({
    hasRegisteredCurrentVersion: z.boolean().default(false),
    hasAppendedPrimer: z.boolean().default(false),
    toolProviders: z
      .record(
        z.string(),
        z.object({
          executeCallable: z.unknown(),
          getTypesCallable: z.unknown().optional(),
        }),
      )
      .default({}),
  })
  .prefault({});

export const CodemodeProcessorContract = defineProcessorContract({
  slug: "codemode",
  version: "0.1.0",
  description: "Turns assistant codemode blocks into sandbox/tool execution results.",
  state: CodemodeState,
  processorDeps: [CoreStreamProcessorContract, AgentLoopProcessorContract],
  events: {
    ...createEvent({
      type: "codemode-block-added",
      description: "A JavaScript codemode block was extracted from model output.",
      payloadSchema: z.object({ script: z.string() }),
    }),
    ...createEvent({
      type: "codemode-result-added",
      description: "A codemode block finished running.",
      payloadSchema: z.object({
        result: z.unknown().optional(),
        error: z.string().optional(),
        logs: z.array(z.string()).optional(),
        durationMs: z.number().int().nonnegative(),
      }),
    }),
    ...createEvent({
      type: "tool-provider-config-updated",
      description: "A tool provider was added, updated, or removed.",
      payloadSchema: z.object({
        slug: z.string().regex(/^[a-zA-Z_$][a-zA-Z0-9_$]*$/),
        executeCallable: z.unknown().nullable(),
        getTypesCallable: z.unknown().optional().nullable(),
      }),
    }),
  },
  consumes: [
    "processor-registered",
    "agent-input-added",
    "codemode-block-added",
    "codemode-result-added",
    "tool-provider-config-updated",
  ],
  emits: [
    "processor-registered",
    "agent-input-added",
    "codemode-block-added",
    "codemode-result-added",
  ],
  reduce({ state, event }) {
    switch (event.type) {
      case "processor-registered":
        return event.payload.slug === "codemode" &&
          event.payload.version === CodemodeProcessorContract.version
          ? { ...state, hasRegisteredCurrentVersion: true }
          : undefined;
      case "agent-input-added":
        return event.idempotencyKey === "codemode:primer"
          ? { ...state, hasAppendedPrimer: true }
          : undefined;
      case "tool-provider-config-updated": {
        const { slug, executeCallable, getTypesCallable } = event.payload;
        if (executeCallable == null) {
          const { [slug]: _removed, ...toolProviders } = state.toolProviders;
          return { ...state, toolProviders };
        }
        return {
          ...state,
          toolProviders: {
            ...state.toolProviders,
            [slug]: {
              executeCallable,
              ...(getTypesCallable == null ? {} : { getTypesCallable }),
            },
          },
        };
      }
      default:
        return undefined;
    }
  },
});

export function createAgentLoopProcessor(deps: { ai: Ai }) {
  return implementProcessor(AgentLoopProcessorContract, {
    async onStart({ state, streamApi }) {
      if (!state.hasRegisteredCurrentVersion) {
        await streamApi.append({
          event: CoreStreamProcessorContract.events["processor-registered"].createInput({
            idempotencyKey: `processor-registered:agent-loop:${AgentLoopProcessorContract.version}`,
            payload: processorRegistrationPayload(AgentLoopProcessorContract),
          }),
        });
      }
    },
    async afterAppend({ event, state, streamApi }) {
      if (event.type !== "agent-input-added") return;
      if (event.payload.role === "assistant") return;

      await streamApi.append({
        event: AgentLoopProcessorContract.events["llm-request-scheduled"].createInput({
          idempotencyKey: `agent-loop:schedule:${event.streamPath}:${event.offset}`,
          payload: {
            requestId: `req_${event.streamPath}_${event.offset}`,
            debounceMs: 1000,
            model: "default",
          },
        }),
      });

      void deps.ai;
      void state;
    },
  });
}

export function createCodemodeProcessor(deps: { loader: WorkerLoader; outboundFetch: Fetcher }) {
  return implementProcessor(CodemodeProcessorContract, {
    async onStart({ state, streamApi }) {
      if (!state.hasRegisteredCurrentVersion) {
        await streamApi.append({
          event: CoreStreamProcessorContract.events["processor-registered"].createInput({
            idempotencyKey: `processor-registered:codemode:${CodemodeProcessorContract.version}`,
            payload: processorRegistrationPayload(CodemodeProcessorContract),
          }),
        });
      }
    },
    async afterAppend({ event, state, streamApi }) {
      if (!state.hasAppendedPrimer) {
        await streamApi.append({
          event: AgentLoopProcessorContract.events["agent-input-added"].createInput({
            idempotencyKey: "codemode:primer",
            payload: {
              role: "user",
              content: "Codemode is available. Use one fenced js block to call tools.",
              triggerLlmRequest: { behaviour: "dont-trigger-request" },
            },
          }),
        });
      }

      if (event.type !== "agent-input-added" || event.payload.role !== "assistant") return;

      const script = extractSingleJsBlock(event.payload.content);
      if (script == null) return;

      await streamApi.append({
        event: CodemodeProcessorContract.events["codemode-block-added"].createInput({
          idempotencyKey: `codemode:block:${event.streamPath}:${event.offset}`,
          payload: { script },
        }),
      });

      void deps;
    },
  });
}

function processorRegistrationPayload(contract: {
  slug: string;
  version: string;
  description: string;
  consumes: readonly string[];
  emits: readonly string[];
  events: Record<string, { type: string; description?: string }>;
}) {
  return {
    slug: contract.slug,
    version: contract.version,
    description: contract.description,
    consumes: [...contract.consumes],
    emits: [...contract.emits],
    ownedEvents: Object.values(contract.events).map((event) => ({
      type: event.type,
      description: event.description,
      jsonSchema: {},
    })),
  };
}

function extractSingleJsBlock(content: string): string | null {
  const match = /^```(?:js|javascript)\s*\n([\s\S]*?)\n```\s*$/.exec(content.trim());
  return match?.[1]?.trim() ?? null;
}
