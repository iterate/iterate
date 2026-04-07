import { defineProcessor } from "ai-engineer-workshop";

type PingPongState = { pingCount: number };
const initialState: PingPongState = { pingCount: 0 };

export default defineProcessor(() => ({
  slug: "relative-ping-pong",
  initialState,

  reduce: ({ event, state }) => {
    if (event.type !== "ping") return state;
    return { pingCount: state.pingCount + 1 };
  },

  afterAppend: async ({ append, event, state }) => {
    if (event.type !== "ping") return;

    const message = String((event.payload as { message?: string }).message ?? "").toLowerCase();

    if (message.includes("parent")) {
      await append({
        path: "../",
        event: {
          type: "pong",
          payload: { location: "parent", pingCount: state.pingCount, replyToOffset: event.offset },
        },
      });
    }

    if (message.includes("child")) {
      await append({
        path: "./child",
        event: {
          type: "pong",
          payload: { location: "child", pingCount: state.pingCount, replyToOffset: event.offset },
        },
      });
    }
  },
}));
