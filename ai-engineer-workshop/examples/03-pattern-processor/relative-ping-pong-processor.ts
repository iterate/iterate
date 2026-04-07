import { defineProcessor } from "ai-engineer-workshop";

type RelativePingPongState = {
  pingCount: number;
};

export const relativePingPongProcessor = defineProcessor<RelativePingPongState>(() => ({
  slug: "relative-ping-pong",
  initialState: { pingCount: 0 },

  reduce: ({ event, state }) => {
    if (event.type !== "ping") {
      return state;
    }

    return { pingCount: state.pingCount + 1 };
  },

  async afterAppend({ append, event, state }) {
    if (event.type !== "ping") {
      return;
    }

    const message = readPingMessage(event.payload);
    if (message.includes("parent")) {
      await append({
        path: "../",
        event: {
          type: "pong",
          payload: {
            location: "parent",
            pingCount: state.pingCount,
            replyToOffset: event.offset,
          },
        },
      });
      return;
    }

    if (message.includes("child")) {
      await append({
        path: "./child",
        event: {
          type: "pong",
          payload: {
            location: "child",
            pingCount: state.pingCount,
            replyToOffset: event.offset,
          },
        },
      });
    }
  },
}));

function readPingMessage(payload: unknown) {
  if (typeof payload !== "object" || payload == null || Array.isArray(payload)) {
    return "";
  }

  const message = Reflect.get(payload, "message");
  return typeof message === "string" ? message.toLowerCase() : "";
}
