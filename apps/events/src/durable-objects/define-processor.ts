import type { Event, EventInput, StreamPath } from "@iterate-com/events-contract";

export type RelativeStreamPath = `.${string}`;
export type ProcessorAppendInput = {
  event: EventInput;
  path?: StreamPath | RelativeStreamPath;
};

/**
 * A Processor runs reduce/afterAppend hooks against its own slice of stream
 * state. Processors could in principle run across the network (e.g. a webhook
 * destination), so they cannot block event acceptance — they have no
 * `beforeAppend` hook.
 */
export type Processor<TState = Record<string, unknown>> = {
  slug: string;
  initialState: TState;
  reduce?(args: { event: Event; state: TState }): TState;
  afterAppend?(args: {
    append: (input: ProcessorAppendInput) => Event | Promise<Event>;
    event: Event;
    state: TState;
  }): Promise<void>;
};
export function defineProcessor<const TState>(factory: () => Processor<TState>): Processor<TState> {
  return factory();
}
