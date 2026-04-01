import type { Event, EventInput } from "@iterate-com/events-contract";

type AppendEvent = Omit<EventInput, "path">;

export function defineProcessor<State>(processor: {
  initialState: State;
  reduce: (state: State, event: Event) => State | void;
  onEvent?: (args: {
    append: (event: AppendEvent) => Promise<void>;
    event: Event;
    state: State;
    prevState: State;
  }) => Promise<void>;
}) {
  return processor;
}

export type StreamProcessor<State> = ReturnType<typeof defineProcessor<State>>;
