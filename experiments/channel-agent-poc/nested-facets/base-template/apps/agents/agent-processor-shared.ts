export type AgentEvent = {
  type: string;
  payload?: Record<string, any>;
  idempotencyKey?: string;
  offset?: number;
  [key: string]: any;
};

export type Append = (input: { event: AgentEvent }) => void | Promise<void>;

export interface ProcessorRuntime {
  inflight(): { requestId: string; status: "scheduled" | "running" } | null;
  scheduleLlmRequest(args: { debounceMs: number }): { requestId: string };
  extendDebounce(args: { requestId: string; debounceMs: number }): void;
  cancelLlmRequest(args: { requestId: string }): void;
  armCancelDeadline(args: { requestId: string; withinMs: number }): void;
}

export type AfterAppendArgs<TState> = {
  append: Append;
  event: AgentEvent;
  state: TState;
  runtime: ProcessorRuntime;
};
