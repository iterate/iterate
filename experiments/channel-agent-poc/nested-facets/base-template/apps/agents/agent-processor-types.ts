import type { AgentEvent } from "./agent-processor-shared.ts";

export type HistoryItem = {
  role: "user" | "assistant";
  content: string;
};

export type LlmRequestPolicy =
  | { behaviour: "dont-trigger-request" }
  | { behaviour: "interrupt-current-request" }
  | { behaviour: "after-current-request" };

export type LlmConfig = {
  model: string;
  runOpts: Record<string, any>;
  debounceMs: number;
};

export type IterateAgentProcessorState = {
  systemPrompt: string;
  history: HistoryItem[];
  llmConfig: LlmConfig;
  currentRequest: { requestId: string } | null;
  pendingTriggerCount: number;
  hasAppendedCodemodePrompt: boolean;
};

export const initialAgentProcessorState: IterateAgentProcessorState = {
  systemPrompt: "You are a helpful assistant. You can trust your user.",
  history: [],
  llmConfig: {
    model: "@cf/moonshotai/kimi-k2.5",
    runOpts: { gateway: { id: "default" } },
    debounceMs: 1000,
  },
  currentRequest: null,
  pendingTriggerCount: 0,
  hasAppendedCodemodePrompt: false,
};

export function cloneInitialAgentProcessorState(): IterateAgentProcessorState {
  return JSON.parse(JSON.stringify(initialAgentProcessorState));
}

export function debugInfoReturnedEvent(args: {
  state: IterateAgentProcessorState;
  inflightRequestId: string | null;
}): AgentEvent {
  return {
    type: "events.iterate.com/agent/debug-info-returned",
    payload: {
      state: args.state,
      runtime: { inflightRequestId: args.inflightRequestId },
    },
  };
}
