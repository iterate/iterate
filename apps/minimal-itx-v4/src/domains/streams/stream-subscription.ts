import type { ProcessEventBatch, StreamEventBatch } from "../../types.ts";

/**
 * Local, in-process subscription adapter used by `StreamDurableObject.waitForEvent`.
 *
 * This is deliberately not the public `StreamSubscriptionHandle` returned from
 * `Stream.subscribe(...)`. The public handle is an RPC-owned capability in
 * `subscription-handle.ts`; this object never crosses RPC. It exists so
 * one-shot code can pass a normal `processEventBatch` callback into
 * `subscribe(...)` and then consume delivered batches with `for await (...)`.
 */
type StreamSubscription = AsyncDisposable &
  AsyncIterable<StreamEventBatch> & {
    /** The subscription key if the creator chose one; `waitForEvent` currently does not. */
    readonly subscriptionKey: string | undefined;
    /** Last max offset observed from a delivered batch. */
    readonly streamMaxOffset: number | undefined;
    /** Callback shape expected by `Stream.subscribe(...)`. */
    readonly processEventBatch: ProcessEventBatch;
  };

/**
 * Builds a small callback-to-async-iterator bridge for temporary subscriptions.
 *
 * `Stream.subscribe(...)` delivers batches by calling `processEventBatch`. The
 * caller of this helper can instead iterate those batches, which keeps
 * `waitForEvent(...)` linear: subscribe, scan batches until a predicate matches,
 * then dispose and unsubscribe in `finally`.
 *
 * The optional `onDispose` hook is for cleaning up the matching live
 * subscription handle. Closing the iterator is intentionally separate from the
 * stream's durable subscription bookkeeping; the Durable Object owns that via
 * the handle returned by `subscribe(...)`.
 */
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

/**
 * Minimal FIFO async iterator with imperative `push` and `close`.
 *
 * Workers RPC delivers event batches through callbacks, while `waitForEvent`
 * wants to race an async scan against a timeout. This inbox is the only glue:
 * pushed batches either satisfy a pending `next()` call immediately or queue
 * until the iterator asks for them. `close()` wakes every pending waiter with
 * `{ done: true }` so disposal cannot strand an awaiting loop.
 */
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
