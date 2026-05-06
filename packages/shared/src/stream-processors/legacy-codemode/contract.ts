import { z } from "zod";
import {
  assertNever,
  defineProcessorContract,
  getInitialProcessorState,
  reduceProcessorEvents,
  type StreamEvent,
} from "../stream-processor.ts";
import { Callable } from "../../callable/types.ts";
import { AgentChatProcessorContract } from "../agent-chat/contract.ts";
import { AgentProcessorContract, reduceAgentEvents } from "../agent/contract.ts";
import { CoreProcessorRegisteredEventType } from "../core/contract.ts";
import { standardProcessorBehavior } from "../core/standard-processor-behavior.ts";

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
 * backend implementation that receives an injected code executor, calls
 * callable tool providers, and appends derived events belongs in a separate
 * file.
 */
export const CodemodeProcessorContract = defineProcessorContract({
  slug: "codemode",
  version: "0.1.0",
  description: "Turns assistant codemode blocks into tool execution results.",
  stateSchema: z.object({
    ...standardProcessorBehavior.stateShape,
    /**
     * Manual Agent processor state.
     *
     * Codemode needs to inspect Agent's reduced state, so it stores an Agent
     * snapshot directly inside its own serializable state. The reducer below
     * keeps this snapshot current by running the public Agent reducer for every
     * event Codemode consumes.
     *
     * If this pattern appears in more processors, we can give it a proper
     * helper and a proper name. For now the concrete field is easier to reason
     * about than a generic container.
     */
    agentProcessor: AgentProcessorContract.stateSchema.default(initialAgentProcessorState),
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
    ...standardProcessorBehavior.initialState,
    agentProcessor: initialAgentProcessorState,
  },
  processorDeps: [
    ...standardProcessorBehavior.processorDeps,
    AgentProcessorContract,
    AgentChatProcessorContract,
  ],
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
    ...standardProcessorBehavior.emits,
    "events.iterate.com/agent/input-added",
    "events.iterate.com/agent/status-updated",
    "events.iterate.com/agent-chat/agent-response-added",
    "events.iterate.com/codemode/block-added",
    "events.iterate.com/codemode/result-added",
  ],
  reduce({ contract, state, event }) {
    let nextState = state;

    nextState = standardProcessorBehavior.reduce({
      state: nextState,
      event,
      contract,
    });

    nextState = {
      ...nextState,
      agentProcessor: reduceAgentEvents({
        state: nextState.agentProcessor,
        events: [event],
      }),
    };

    switch (event.type) {
      case CoreProcessorRegisteredEventType:
        return nextState;
      case "events.iterate.com/agent/input-added":
        if (event.idempotencyKey === CODEMODE_PRIMER_IDEMPOTENCY_KEY) {
          return { ...nextState, hasAppendedCodemodePrompt: true };
        }
        break;
      case "events.iterate.com/agent/output-added":
        break;
      case "events.iterate.com/agent/system-prompt-updated":
      case "events.iterate.com/agent/llm-config-updated":
      case "events.iterate.com/agent/llm-request-scheduled":
      case "events.iterate.com/agent/llm-request-requested":
      case "events.iterate.com/agent/llm-request-completed":
      case "events.iterate.com/agent/llm-request-cancelled":
      case "events.iterate.com/agent/llm-request-queued":
      case "events.iterate.com/agent/status-updated":
        break;
      case "events.iterate.com/codemode/block-added":
      case "events.iterate.com/codemode/result-added":
        break;
      case "events.iterate.com/codemode/tool-provider-config-updated": {
        const { slug, executeCallable, getTypesCallable } = event.payload;
        if (executeCallable === null) {
          const { [slug]: _removed, ...toolProviders } = nextState.toolProviders;
          return { ...nextState, toolProviders };
        }

        return {
          ...nextState,
          toolProviders: {
            ...nextState.toolProviders,
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

    return nextState;
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
