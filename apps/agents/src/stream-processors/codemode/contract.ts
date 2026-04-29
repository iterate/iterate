import { z } from "zod";
import {
  assertNever,
  defineProcessorContract,
  getInitialProcessorState,
  reduceProcessorEvents,
  type StreamEvent,
} from "@iterate-com/shared/stream-processors";
import { Callable } from "@iterate-com/shared/callable/types.ts";
import { AgentProcessorContract, reduceAgentEvents } from "../agent/contract.ts";
import { CoreProcessorRegisteredEventType } from "../core/contract.ts";
import { wellBehavedProcessorDefaults } from "../core/well-behaved-processor-defaults.ts";

/**
 * Idempotency key used for the one-time codemode primer row.
 *
 * The reducer watches for this key on `agent/input-added` to know that the
 * primer append has round-tripped through the stream. The backend implementation
 * may optimistically attempt the append more than once; stream idempotency is
 * what keeps the wire log single-copy.
 */
export const CODEMODE_PRIMER_IDEMPOTENCY_KEY = "iterate-agent:codemode-primer";

const initialAgentProcessorState = getInitialProcessorState(AgentProcessorContract);

/**
 * Frontend-safe public contract for the codemode processor.
 *
 * This file owns only schemas, reduced state, and pure projection logic. The
 * backend implementation that imports `@cloudflare/codemode`, calls callable
 * tool providers, and appends derived events belongs in a separate file.
 */
export const CodemodeProcessorContract = defineProcessorContract({
  slug: "codemode",
  version: "0.1.0",
  description: "Turns assistant codemode blocks into tool execution results.",
  stateSchema: z.object({
    ...wellBehavedProcessorDefaults.stateShape,
    /**
     * Explicit dependency-state composition.
     *
     * Codemode relies on the agent processor's reduced state, so it stores an
     * agent snapshot inside its own serializable state. The reducer below keeps
     * this snapshot current by running the public agent reducer for every event
     * codemode consumes. We may introduce a helper for this later, but keeping
     * it spelled out here makes the composition model easy to inspect while the
     * abstraction is still young.
     */
    processorDeps: z
      .object({
        agent: AgentProcessorContract.stateSchema.default(initialAgentProcessorState),
      })
      .default({ agent: initialAgentProcessorState }),
    hasAppendedCodemodePrompt: z.boolean().default(false),
    toolProviders: z
      .record(
        z.string(),
        z.object({
          executeCallable: Callable,
          getTypesCallable: Callable.optional(),
        }),
      )
      .default({}),
  }),
  initialState: {
    ...wellBehavedProcessorDefaults.initialState,
    processorDeps: {
      agent: initialAgentProcessorState,
    },
  },
  processorDeps: [...wellBehavedProcessorDefaults.processorDeps, AgentProcessorContract],
  events: {
    "events.iterate.com/codemode/block-added": {
      description: "A JavaScript codemode block was extracted for execution.",
      payloadSchema: z.object({ script: z.string() }),
    },
    "events.iterate.com/codemode/result-added": {
      description: "A codemode block finished executing.",
      payloadSchema: z.object({
        result: z.unknown(),
        error: z.string().optional(),
        logs: z.array(z.string()).optional(),
        durationMs: z.number().int().nonnegative(),
      }),
    },
    "events.iterate.com/codemode/tool-provider-config-updated": {
      description: "A codemode tool provider was added, updated, or removed.",
      payloadSchema: z.object({
        slug: z
          .string()
          .min(1)
          .regex(/^[a-zA-Z_$][a-zA-Z0-9_$]*$/, {
            message: "slug must be a valid JS identifier because it becomes a sandbox namespace",
          }),
        executeCallable: Callable.nullable(),
        getTypesCallable: Callable.optional().nullable(),
      }),
    },
  },
  consumes: [
    ...AgentProcessorContract.consumes,
    "events.iterate.com/codemode/block-added",
    "events.iterate.com/codemode/result-added",
    "events.iterate.com/codemode/tool-provider-config-updated",
  ],
  emits: [
    ...wellBehavedProcessorDefaults.emits,
    "events.iterate.com/agent/input-added",
    "events.iterate.com/agent/webchat-response-added",
    "events.iterate.com/agent/status-updated",
    "events.iterate.com/codemode/block-added",
    "events.iterate.com/codemode/result-added",
  ],
  reduce({ contract, state, event }) {
    // Keep embedded dependency state current before reducing codemode's own
    // state. This is intentionally explicit for now; a future helper may
    // package this pattern once we have more examples than agent -> codemode.
    const stateWithProcessorDeps = {
      ...state,
      processorDeps: {
        ...state.processorDeps,
        agent: reduceAgentEvents({
          state: state.processorDeps.agent,
          events: [event],
        }),
      },
    };

    switch (event.type) {
      case CoreProcessorRegisteredEventType:
        return wellBehavedProcessorDefaults.reduce({
          state: stateWithProcessorDeps,
          event,
          contract,
        });
      case "events.iterate.com/agent/input-added":
        return event.idempotencyKey === CODEMODE_PRIMER_IDEMPOTENCY_KEY
          ? { ...stateWithProcessorDeps, hasAppendedCodemodePrompt: true }
          : stateWithProcessorDeps;
      case "events.iterate.com/agent/system-prompt-updated":
      case "events.iterate.com/agent/webchat-message-received":
      case "events.iterate.com/agent/webchat-response-added":
      case "events.iterate.com/agent/llm-config-updated":
      case "events.iterate.com/agent/llm-request-scheduled":
      case "events.iterate.com/agent/llm-request-started":
      case "events.iterate.com/agent/llm-request-completed":
      case "events.iterate.com/agent/llm-request-failed":
      case "events.iterate.com/agent/llm-request-cancelled":
      case "events.iterate.com/agent/llm-request-queued":
      case "events.iterate.com/agent/status-updated":
        return stateWithProcessorDeps;
      case "events.iterate.com/codemode/block-added":
      case "events.iterate.com/codemode/result-added":
        return stateWithProcessorDeps;
      case "events.iterate.com/codemode/tool-provider-config-updated": {
        const { slug, executeCallable, getTypesCallable } = event.payload;
        if (executeCallable === null) {
          const { [slug]: _removed, ...toolProviders } = stateWithProcessorDeps.toolProviders;
          return { ...stateWithProcessorDeps, toolProviders };
        }

        return {
          ...stateWithProcessorDeps,
          toolProviders: {
            ...stateWithProcessorDeps.toolProviders,
            [slug]: {
              executeCallable,
              ...(getTypesCallable == null ? {} : { getTypesCallable }),
            },
          },
        };
      }
      default:
        return assertNever(event);
    }
  },
});

export function reduceCodemodeEvents(args: {
  events: readonly StreamEvent[];
  state?: CodemodeState;
}): CodemodeState {
  return reduceProcessorEvents({
    contract: CodemodeProcessorContract,
    events: args.events,
    state: args.state,
  });
}

export type CodemodeState = z.infer<typeof CodemodeProcessorContract.stateSchema>;
