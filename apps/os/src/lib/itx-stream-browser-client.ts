import type { StreamRpc } from "~/domains/streams/engine/types.ts";
import type { BrowserStreamClient } from "~/domains/streams/engine/browser/stream-browser-store.ts";

export type ItxStreamForBrowserRuntime = StreamRpc;

export function itxStreamBrowserClient(stream: ItxStreamForBrowserRuntime): BrowserStreamClient {
  return {
    append: (args) => stream.append(args),
    appendBatch: (args) => stream.appendBatch(args),
    getEvent: (args) => stream.getEvent(args),
    getEvents: (args) => stream.getEvents(args),
    waitForEvent: (args) => stream.waitForEvent(args),
    runtimeState: () => stream.runtimeState(),
    getProcessorRuntimeState: (args) =>
      stream.getProcessorRuntimeState(args) as Promise<
        Awaited<ReturnType<StreamRpc["getProcessorRuntimeState"]>>
      >,
    async subscribe(args) {
      let streamMaxOffset = 0;
      const subscription = await stream.subscribe({
        subscriptionKey: args.subscriptionKey,
        processEventBatch: (batch) => {
          streamMaxOffset = batch.streamMaxOffset;
          return args.processEventBatch(batch);
        },
        replayAfterOffset: args.replayAfterOffset,
        subscriber: args.subscriber,
      });
      return {
        subscriptionKey: subscription.subscriptionKey,
        streamMaxOffset: subscription.streamMaxOffset ?? streamMaxOffset,
        unsubscribe() {
          subscription.unsubscribe();
        },
      };
    },
    reduce: (args) => stream.reduce(args),
    kill: () => stream.kill(),
    reset: () => stream.reset(),
    [Symbol.dispose]() {},
  };
}
