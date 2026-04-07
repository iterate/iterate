import type { Event, EventInput } from "ai-engineer-workshop/runtime";

export type StreamProcessor<State> = {
  initialState: State;
  reduce: (state: State, event: Event) => State;
  onEvent?: (args: {
    append: (event: Omit<EventInput, "path">) => Promise<void>;
    event: Event;
    prevState: State;
    state: State;
  }) => Promise<void>;
};
