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
export const CODEMODE_AUTOMATIC_CONTINUATION_LIMIT = 10;

export const CODEMODE_WEBCHAT_PROVIDER_TYPES = `declare const webchat: {
  sendMessage(args: { message: string }): Promise<void>;
};`;

/**
 * System-level instruction needed by streams that use Codemode for chat I/O.
 *
 * The one-time primer event below is still useful for raw streams where only
 * the codemode processor is subscribed. It is not strong enough for the golden
 * app path by itself, though: Codemode appends that primer from its own
 * after-append hook, so the first Agent LLM request can legitimately be
 * requested before the primer has round-tripped through the stream. App-created
 * chat streams therefore put this text directly in the Agent system prompt
 * before the first user input is appended.
 */
export const CODEMODE_CHAT_RESPONSE_SYSTEM_PROMPT = `Codemode is mandatory for user-visible chat responses in this stream.

When you want to reply to a web chat user, respond with exactly one fenced JavaScript block using \`\`\`js and no surrounding prose. The body must be a single async arrow function. Call \`webchat.sendMessage({ message })\` for user-visible replies; it returns void, so omit \`return\` to stop after side effects. Return any non-\`undefined\` value only when you want the result shown back to you and another LLM turn triggered. Use \`Promise.all\` for independent concurrent tool calls. Use \`fetch\` when you need internet access.`;

export const CODEMODE_PRIMER_TEXT = `${CODEMODE_CHAT_RESPONSE_SYSTEM_PROMPT}

Built-in webchat API:

\`\`\`ts
${CODEMODE_WEBCHAT_PROVIDER_TYPES}
\`\`\``;

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
    automaticContinuationsUsed: z.number().int().nonnegative().default(0),
    finalWrapUpRequested: z.boolean().default(false),
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
    "events.iterate.com/agent-chat/assistant-response-added",
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
      case "events.iterate.com/codemode/tool-provider-registered":
        break;
      case "events.iterate.com/agent/input-added":
        if (event.idempotencyKey === CODEMODE_PRIMER_IDEMPOTENCY_KEY) {
          return { ...nextState, hasAppendedCodemodePrompt: true };
        }
        if (isExternalAgentTurn(event)) {
          return { ...nextState, automaticContinuationsUsed: 0, finalWrapUpRequested: false };
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
        break;
      case "events.iterate.com/codemode/result-added":
        return advanceContinuationBudget(nextState, event.payload);
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

export function codemodeResultNeedsAgentTurn(payload: { result: unknown; error?: string }) {
  return payload.error != null || payload.result !== undefined;
}

function isExternalAgentTurn(event: {
  payload: { triggerLlmRequest?: { behaviour: string } };
  idempotencyKey?: string;
}) {
  return (
    event.payload.triggerLlmRequest?.behaviour !== "dont-trigger-request" &&
    !event.idempotencyKey?.startsWith("codemode/") &&
    !event.idempotencyKey?.startsWith("stream-processor:codemode:derived:")
  );
}

function advanceContinuationBudget<
  State extends {
    automaticContinuationsUsed: number;
    finalWrapUpRequested: boolean;
  },
>(state: State, payload: { result: unknown; error?: string }): State {
  if (!codemodeResultNeedsAgentTurn(payload)) return state;
  if (state.automaticContinuationsUsed < CODEMODE_AUTOMATIC_CONTINUATION_LIMIT) {
    return { ...state, automaticContinuationsUsed: state.automaticContinuationsUsed + 1 };
  }
  return state.finalWrapUpRequested ? state : { ...state, finalWrapUpRequested: true };
}
