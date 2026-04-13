import { defineProcessor, PullProcessorRuntime } from "ai-engineer-workshop";

type State = {};

const processor = defineProcessor<State>(() => ({
  slug: "template",
  initialState: {},
  reduce: ({ state }) => {
    return state;
  },

  afterAppend: async ({ append, event }) => {
    await append({
      event: {
        type: event.type,
        payload: event.payload,
        idempotencyKey: `${event.streamPath}-${event.offset}`,
      },
      path: "./child",
    });
  },
}));

await new PullProcessorRuntime({
  path: "/jonas/test2",
  processor,
  includeChildren: false,
}).run();
