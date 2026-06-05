import { RpcTarget } from "capnweb";
import type { StreamEvent } from "./shared/event.ts";
import type { SubscriptionSink } from "./types.ts";

export type StreamEventBatch = {
  events: StreamEvent[];
  streamMaxOffset: number;
};

export type StreamSubscription = AsyncDisposable &
  AsyncIterable<StreamEventBatch> & {
    readonly subscriptionKey: string | undefined;
    readonly streamMaxOffset: number | undefined;
    readonly sink: SubscriptionSink;
    waitForEvent<T extends StreamEvent>(args: {
      predicate: (event: StreamEvent) => event is T;
      timeoutMs?: number;
    }): Promise<T>;
  };

export function createStreamSubscription(
  args: {
    subscriptionKey?: string;
    onDispose?: () => void | Promise<void>;
  } = {},
): StreamSubscription {
  const inbox = messageInbox<StreamEventBatch>();
  const waiters = new Set<{
    predicate(event: StreamEvent): boolean;
    resolve(event: StreamEvent): void;
    reject(error: unknown): void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  let streamMaxOffset: number | undefined;
  let disposed = false;
  const sink = new ClientSubscriptionSink((batch) => {
    streamMaxOffset = batch.streamMaxOffset;
    inbox.push(batch);

    for (const event of batch.events) {
      // Deleting the current element during Set iteration is safe in JS.
      for (const waiter of waiters) {
        if (!waiter.predicate(event)) continue;
        clearTimeout(waiter.timeout);
        waiters.delete(waiter);
        waiter.resolve(event);
      }
    }
  });

  const subscription = {
    get subscriptionKey() {
      return args.subscriptionKey;
    },
    get streamMaxOffset() {
      return streamMaxOffset;
    },
    get sink() {
      return sink;
    },
    waitForEvent<T extends StreamEvent>(waitArgs: {
      predicate: (event: StreamEvent) => event is T;
      timeoutMs?: number;
    }) {
      const timeoutMs = waitArgs.timeoutMs ?? 4_000;
      return new Promise<T>((resolve, reject) => {
        const waiter = {
          predicate: waitArgs.predicate as (event: StreamEvent) => boolean,
          resolve: resolve as (event: StreamEvent) => void,
          reject,
          timeout: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error("Timed out waiting for stream event."));
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },
    [Symbol.asyncIterator]() {
      return inbox;
    },
    async [Symbol.asyncDispose]() {
      if (disposed) return;
      disposed = true;
      for (const waiter of waiters) {
        clearTimeout(waiter.timeout);
        waiter.reject(new Error("Stream subscription disposed."));
      }
      waiters.clear();
      inbox.close();
      await args.onDispose?.();
    },
  };

  return subscription;
}

class ClientSubscriptionSink extends RpcTarget implements SubscriptionSink {
  readonly #processEventBatch: (args: { events: StreamEvent[]; streamMaxOffset: number }) => void;

  constructor(
    processEventBatch: (args: { events: StreamEvent[]; streamMaxOffset: number }) => void,
  ) {
    super();
    this.#processEventBatch = processEventBatch;
  }

  processEventBatch(args: { events: StreamEvent[]; streamMaxOffset: number }): undefined {
    this.#processEventBatch(args);
  }
}

function messageInbox<T>(): AsyncIterableIterator<T> & {
  push(value: T): void;
  close(): void;
  error(error: unknown): void;
} {
  const messages: T[] = [];
  const waiters: PromiseWithResolvers<IteratorResult<T>>[] = [];
  let closed = false;
  let thrown: unknown;
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
    error(error: unknown) {
      thrown = error;
      for (const waiter of waiters.splice(0)) waiter.reject(error);
    },
    next() {
      const value = messages.shift();
      if (value !== undefined) return Promise.resolve({ done: false as const, value });
      if (thrown !== undefined) return Promise.reject(thrown);
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
