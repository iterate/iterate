import { type GenericEventInput } from "@iterate-com/events-contract";
import { match } from "schematch";
import { agentLoopAfterAppend, reduceAgentLoop } from "./agent-loop-processor.ts";
import type { AfterAppendArgs } from "./agent-processor-shared.ts";
import {
  DebugInfoRequestedEvent,
  DebugInfoReturnedEventInput,
  IterateAgentProcessorState,
} from "./agent-processor-types.ts";
import { codemodeAfterAppend, reduceCodemode } from "./codemode-processor.ts";
import type { CloudflareEnv } from "~/lib/worker-env.d.ts";

/**
 * Processor for codemode execution + tool-provider wiring, and for the
 * LLM trigger / request lifecycle (`agent-input-added`, `llm-request-*`).
 *
 * # Reduce (composed)
 *
 * - **Agent loop** (`reduceAgentLoop`): `system-prompt-updated`,
 *   `agent-input-added`, `llm-config-updated`, `llm-request-*`.
 * - **Codemode** (`reduceCodemode`): codemode prompt append state via
 *   idempotency key, `tool-provider-config-updated`.
 *
 * # AfterAppend (composed, order: codemode → agent-loop → debug)
 *
 * - **Codemode** (`codemodeAfterAppend`): one-time primer `agent-input-added`
 *   (idempotency key `iterate-agent:codemode-primer`),
 *   `codemode-block-added` / `codemode-result-added`, and per-provider
 *   explainer rows on `tool-provider-config-updated`.
 * - **Agent loop** (`agentLoopAfterAppend`): renders raw ingress / lifecycle
 *   events into model-visible `agent-input-added` rows, then runs the trigger
 *   FSM that schedules, queues, cancels, or deadlines LLM requests.
 * - **Debug** (`debugAfterAppend`): `debug-info-requested`.
 *
 * Codemode runs first so the primer hits the wire before the agent-loop can
 * schedule an LLM run for the same inbound event.
 */
export function createIterateAgentProcessor(deps: {
  loader: WorkerLoader;
  outboundFetch: Fetcher;
  env: CloudflareEnv;
}) {
  const reduce = (args: {
    event: GenericEventInput;
    state: IterateAgentProcessorState;
  }): IterateAgentProcessorState | undefined => {
    const codemodeState = reduceCodemode(args.event, args.state);
    const stateAfterCodemode = codemodeState ?? args.state;
    const agentLoopState = reduceAgentLoop(args.event, stateAfterCodemode);

    if (codemodeState === undefined && agentLoopState === undefined) {
      return undefined;
    }

    return agentLoopState ?? stateAfterCodemode;
  };

  return {
    slug: "iterate-agent",
    initialState: IterateAgentProcessorState.parse({}),
    reduce,

    afterAppend: async (args: AfterAppendArgs<IterateAgentProcessorState>) => {
      await codemodeAfterAppend({ ...args, deps });
      await agentLoopAfterAppend(args);
      await debugAfterAppend(args);
    },
  };
}

async function debugAfterAppend(args: AfterAppendArgs<IterateAgentProcessorState>): Promise<void> {
  const { append, state, runtime, event } = args;
  await match(event)
    .case(DebugInfoRequestedEvent, async () => {
      await append({
        event: DebugInfoReturnedEventInput.parse({
          type: "debug-info-returned",
          payload: {
            state,
            runtime: { inflightRequestId: runtime.inflight()?.requestId ?? null },
          },
        }),
      });
    })
    .defaultAsync(() => undefined);
}
