import type { StreamEvent, StreamEventInput } from "~/domains/streams/engine/shared/event.ts";
import type { StreamRpc } from "~/domains/streams/engine/types.ts";
import type {
  BrowserStreamClient,
  StreamRuntimeState,
} from "~/domains/streams/engine/browser/stream-browser-store.ts";

type StreamSubscribeInput = Parameters<StreamRpc["subscribe"]>[0];

type ItxStreamForBrowserRuntime = {
  append(args: { streamPath?: string; event: StreamEventInput }): Promise<StreamEvent>;
  appendBatch(args: { streamPath?: string; events: StreamEventInput[] }): Promise<StreamEvent[]>;
  runtimeState(): Promise<StreamRuntimeState>;
  subscribe(args: {
    subscriptionKey?: string;
    processEventBatch(batch: { events: StreamEvent[]; streamMaxOffset: number }): unknown;
    replayAfterOffset?: number;
    events?: boolean;
    subscriber?: StreamSubscribeInput["subscriber"];
  }): Promise<{ unsubscribe(): void }>;
  kill(): Promise<void>;
  reset(): Promise<void>;
};

export function itxStreamBrowserClient(stream: ItxStreamForBrowserRuntime): BrowserStreamClient {
  return {
    append: (args) => stream.append(args),
    appendBatch: (args) => stream.appendBatch(args),
    runtimeState: () => stream.runtimeState(),
    async subscribe(args) {
      const subscription = await stream.subscribe({
        subscriptionKey: args.subscriptionKey,
        processEventBatch: (batch) =>
          args.processEventBatch({
            events: batch.events,
            streamMaxOffset: batch.streamMaxOffset,
          }),
        replayAfterOffset: args.replayAfterOffset,
        subscriber: args.subscriber,
      });
      return {
        unsubscribe() {
          subscription.unsubscribe();
        },
      };
    },
    kill: () => stream.kill(),
    reset: () => stream.reset(),
    [Symbol.dispose]() {},
  };
}
