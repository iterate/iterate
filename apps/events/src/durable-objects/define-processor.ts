import type { Event, EventInput } from "@iterate-com/events-contract";

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
    append: (event: EventInput) => Event;
    event: Event;
    state: TState;
  }): Promise<void>;
};

export function defineProcessor<const TState>(factory: () => Processor<TState>): Processor<TState> {
  return factory();
}
