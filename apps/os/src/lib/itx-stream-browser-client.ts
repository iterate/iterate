import type { StreamEvent, StreamEventInput } from "~/domains/streams/engine/shared/event.ts";
import type { StreamRpc } from "~/domains/streams/engine/types.ts";
import type {
  BrowserStreamClient,
  StreamRuntimeState,
} from "~/domains/streams/engine/browser/stream-browser-store.ts";

type StreamSubscribeInput = Parameters<StreamRpc["subscribe"]>[0];

export type ItxStreamForBrowserRuntime = {
  append(args: { event: StreamEventInput }): Promise<StreamEvent>;
  appendBatch(args: { events: StreamEventInput[] }): Promise<StreamEvent[]>;
  at(streamPath: string): ItxStreamForBrowserRuntime;
  runtimeState(): Promise<StreamRuntimeState>;
  getProcessorRuntimeState(
    args: Parameters<StreamRpc["getProcessorRuntimeState"]>[0],
  ): ReturnType<StreamRpc["getProcessorRuntimeState"]>;
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
    at: (streamPath) => itxStreamBrowserClient(stream.at(streamPath)),
    runtimeState: () => stream.runtimeState(),
    getProcessorRuntimeState: (args) =>
      stream.getProcessorRuntimeState(args) as Promise<
        Awaited<ReturnType<StreamRpc["getProcessorRuntimeState"]>>
      >,
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
