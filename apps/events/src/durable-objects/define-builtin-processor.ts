import type { Event, EventInput } from "@iterate-com/events-contract";

/**
 * A BuiltinProcessor runs in-process inside the Durable Object, so it can
 * synchronously reject events via `beforeAppend` before they are committed.
 * Non-builtin processors cannot do this because they may execute across the
 * network where synchronous rejection is not possible.
 */
export type BuiltinProcessor<TState = Record<string, unknown>> = {
  slug: string;
  initialState: TState;
  beforeAppend?(args: { event: EventInput; state: TState }): void;
  reduce?(args: { event: Event; state: TState }): TState;
  afterAppend?(args: {
    append: (event: EventInput) => Event | Promise<Event>;
    event: Event;
    state: TState;
  }): Promise<void>;
};

export function defineBuiltinProcessor<const TState>(
  factory: () => BuiltinProcessor<TState>,
): BuiltinProcessor<TState> {
  return factory();
}
