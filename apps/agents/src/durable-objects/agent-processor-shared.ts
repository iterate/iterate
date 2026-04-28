import type { EventInput } from "@iterate-com/events-contract";

export type Append = (input: { event: EventInput }) => void | Promise<void>;

/**
 * Synchronous execution view owned by the Durable Object.
 *
 * This is deliberately separate from `state.currentRequest`: the state field
 * is a replicated event-log projection stored in KV, while this interface
 * reports the DO's live timer / abort slot and exposes the only levers the pure
 * processor is allowed to pull.
 */
export interface ProcessorRuntime {
  inflight(): { requestId: string; status: "scheduled" | "running" } | null;
  scheduleLlmRequest(args: { debounceMs: number }): { requestId: string };
  extendDebounce(args: { requestId: string; debounceMs: number }): void;
  cancelLlmRequest(args: { requestId: string }): void;
  armCancelDeadline(args: { requestId: string; withinMs: number }): void;
}

export type AfterAppendArgs<TState> = {
  append: Append;
  event: unknown;
  state: TState;
  runtime: ProcessorRuntime;
};
