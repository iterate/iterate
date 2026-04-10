import { defineProcessor } from "ai-engineer-workshop";

export default defineProcessor(() => ({
  slug: "ping-pong",
  initialState: {},
  reduce: ({ state }) => state,
  afterAppend: async ({ append, event }) => {
    if (event.type !== "ping") return;
    await append({ event: { type: "pong", payload: { ok: true } } });
  },
}));
