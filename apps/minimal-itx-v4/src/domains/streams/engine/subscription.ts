import type { ProcessEventBatch, StreamEventBatch } from "../../../../types.ts";

export type StreamSubscription = AsyncDisposable &
  AsyncIterable<StreamEventBatch> & {
    readonly subscriptionKey: string | undefined;
    readonly streamMaxOffset: number | undefined;
    readonly processEventBatch: ProcessEventBatch;
  };

export function createStreamSubscription(
  args: {
    subscriptionKey?: string;
    onDispose?: () => void | Promise<void>;
  } = {},
): StreamSubscription {
  const inbox = messageInbox<StreamEventBatch>();
  let streamMaxOffset: number | undefined;
  let disposed = false;
  const processEventBatch: ProcessEventBatch = (batch) => {
    streamMaxOffset = batch.streamMaxOffset;
    inbox.push(batch);
  };

  const subscription = {
    get subscriptionKey() {
      return args.subscriptionKey;
    },
    get streamMaxOffset() {
      return streamMaxOffset;
    },
    get processEventBatch() {
      return processEventBatch;
    },
    [Symbol.asyncIterator]() {
      return inbox;
    },
    async [Symbol.asyncDispose]() {
      if (disposed) return;
      disposed = true;
      inbox.close();
      await args.onDispose?.();
    },
  };

  return subscription;
}

function messageInbox<T>(): AsyncIterableIterator<T> & {
  push(value: T): void;
  close(): void;
} {
  const messages: T[] = [];
  const waiters: PromiseWithResolvers<IteratorResult<T>>[] = [];
  let closed = false;
  const inbox = {
    push(value: T) {
      const waiter = waiters.shift();
      if (waiter === undefined) {
        messages.push(value);
      } else {
        waiter.resolve({ done: false, value });
      }
    },
    close() {
      closed = true;
      for (const waiter of waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
    },
    next() {
      const value = messages.shift();
      if (value !== undefined) return Promise.resolve({ done: false as const, value });
      if (closed) return Promise.resolve({ done: true as const, value: undefined });
      const waiter = Promise.withResolvers<IteratorResult<T>>();
      waiters.push(waiter);
      return waiter.promise;
    },
    [Symbol.asyncIterator]() {
      return inbox;
    },
  };
  return inbox;
}
