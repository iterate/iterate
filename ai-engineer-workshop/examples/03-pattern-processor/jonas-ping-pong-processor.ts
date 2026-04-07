import { defineProcessor } from "ai-engineer-workshop";

type PingPongState = { pingCount: number };
const initialState: PingPongState = { pingCount: 0 };

export default defineProcessor(() => ({
  slug: "ping-pong",
  initialState,

  reduce: ({ event, state }) => {
    if (event.type !== "ping") return state;
    return { pingCount: state.pingCount + 1 };
  },

  afterAppend: async ({ append, event, state }) => {
    if (event.type !== "ping") return;

    await append({
      event: {
        type: "pong",
        payload: { replyToOffset: event.offset, pingCount: state.pingCount },
      },
    });
  },
}));
