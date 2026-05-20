import type { StreamEvent, StreamEventInput } from "../types.js";

export type EchoProcessorState = {
  pongCount: number;
};

/**
 * Minimal stand-in for shared stream processor contracts (e.g. agent-chat).
 * The StreamProcessor DO runs reduce + afterAppend against this object.
 */
export const echoProcessor = {
  slug: "echo",
  version: "0.1.0",
  initialState: { pongCount: 0 } satisfies EchoProcessorState,

  reduce(args: { state: EchoProcessorState; event: StreamEvent }): EchoProcessorState {
    if (args.event.type === "ping") {
      return { pongCount: args.state.pongCount + 1 };
    }
    return args.state;
  },

  async afterAppend(args: {
    event: StreamEvent;
    state: EchoProcessorState;
    append: (event: StreamEventInput) => Promise<void>;
  }): Promise<void> {
    if (args.event.type !== "ping") return;

    await args.append({
      type: "pong",
      payload: { n: args.state.pongCount },
      idempotencyKey: `echo:pong:${args.event.offset}`,
      source: {
        processor: { slug: echoProcessor.slug, version: echoProcessor.version },
      },
    });
  },
};
