import { agentLoopAfterAppend, reduceAgentLoop } from "./agent-loop-processor.ts";
import type { AgentEvent, AfterAppendArgs } from "./agent-processor-shared.ts";
import {
  cloneInitialAgentProcessorState,
  debugInfoReturnedEvent,
  type IterateAgentProcessorState,
} from "./agent-processor-types.ts";
import { codemodeAfterAppend, reduceCodemode } from "./codemode-processor.ts";

export { buildLlmChatRequest, extractLlmAssistantText } from "./agent-loop-processor.ts";
export type { IterateAgentProcessorState } from "./agent-processor-types.ts";
export type { ProcessorRuntime } from "./agent-processor-shared.ts";

export function createIterateAgentProcessor(deps: {
  executeScript(script: string): Promise<{ result?: unknown; error?: string; logs?: string[] }>;
  describeProviders(): Promise<Array<{ name: string; tools: string[] }>>;
}) {
  const reduce = (args: {
    event: AgentEvent;
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
    initialState: cloneInitialAgentProcessorState(),
    reduce,

    afterAppend: async (args: AfterAppendArgs<IterateAgentProcessorState>) => {
      await codemodeAfterAppend({ ...args, deps });
      await agentLoopAfterAppend(args);
      if (args.event.type === "events.iterate.com/agent/debug-info-requested") {
        await args.append({
          event: debugInfoReturnedEvent({
            state: args.state,
            inflightRequestId: args.runtime.inflight()?.requestId ?? null,
          }),
        });
      }
    },
  };
}
