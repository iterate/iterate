import { RpcTarget } from "capnweb";
import type { StreamEventInput } from "../shared/event.ts";
import type {
  ProcessEventBatch,
  StreamCoreProcessorState,
  StreamRpc,
  SubscriptionKey,
} from "../types.ts";

/**
 * StreamCapability is the front-door object exposed to Cap'n Web clients.
 *
 * Today it proxies the full StreamRpc surface to a captured Durable Object stub.
 * Later this is the right place to enforce capability scopes from constructor
 * props before forwarding to the full-power DO stub.
 *
 * Cap'n Web is intentionally kept at this Worker boundary. The Stream Durable
 * Object speaks Workers RPC internally; browsers and external JS runtimes reach
 * it through this stateless adapter:
 * https://blog.cloudflare.com/capnweb-javascript-rpc-library/
 * https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-from-workers/
 */
export class StreamCapability extends RpcTarget implements StreamRpc {
  constructor(readonly stream: StreamRpc) {
    super();
  }

  append(args: { streamPath?: string; event: StreamEventInput }) {
    return this.stream.append(args);
  }

  appendBatch(args: { streamPath?: string; events: StreamEventInput[] }) {
    return this.stream.appendBatch(args);
  }

  getEvent(
    args: { offset: number; idempotencyKey?: never } | { idempotencyKey: string; offset?: never },
  ) {
    return this.stream.getEvent(args);
  }

  getEvents(args?: { afterOffset?: number; beforeOffset?: number | null; limit?: number }) {
    return this.stream.getEvents(args);
  }

  async subscribe(args: {
    subscriptionKey?: SubscriptionKey;
    processEventBatch: ProcessEventBatch;
    replayAfterOffset?: number;
  }) {
    // Cap'n Web supports callbacks by reference. Because subscribe() returns
    // before future batches arrive, duplicate the callback stub and dispose it
    // when the stream subscription is explicitly unsubscribed or breaks:
    // https://blog.cloudflare.com/capnweb-javascript-rpc-library/
    // https://github.com/cloudflare/capnweb#memory-management
    const clientProcessEventBatch = retainProcessEventBatch(args.processEventBatch);
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      clientProcessEventBatch[Symbol.dispose]();
    };
    const processEventBatch: ProcessEventBatch & Disposable = Object.assign(
      (batch: Parameters<ProcessEventBatch>[0]) => {
        const pendingBatch = clientProcessEventBatch(batch);
        disposeIgnoredRpcResult(pendingBatch);
      },
      { [Symbol.dispose]: dispose },
    );

    try {
      const subscription = await this.stream.subscribe({
        subscriptionKey: args.subscriptionKey,
        replayAfterOffset: args.replayAfterOffset,
        processEventBatch,
      });

      clientProcessEventBatch.onRpcBroken?.(() => {
        disposeIgnoredRpcResult(subscription.unsubscribe());
        dispose();
      });

      return {
        subscriptionKey: subscription.subscriptionKey,
        streamMaxOffset: subscription.streamMaxOffset,
        unsubscribe() {
          disposeIgnoredRpcResult(subscription.unsubscribe());
          dispose();
        },
      };
    } catch (error) {
      clientProcessEventBatch[Symbol.dispose]();
      throw error;
    }
  }

  runtimeState() {
    return this.stream.runtimeState();
  }

  kill() {
    return this.stream.kill();
  }

  reset() {
    return this.stream.reset();
  }

  reduce(args: {
    event: Parameters<StreamRpc["reduce"]>[0]["event"];
    coreProcessorState?: StreamCoreProcessorState;
  }) {
    return this.stream.reduce(args);
  }
}

type RetainedProcessEventBatch = ProcessEventBatch &
  Disposable & {
    onRpcBroken?(callback: (error: unknown) => void): void;
  };

type RetainableProcessEventBatch = ProcessEventBatch &
  Partial<Disposable> & {
    dup?(): RetainedProcessEventBatch;
    onRpcBroken?(callback: (error: unknown) => void): void;
  };

function retainProcessEventBatch(processEventBatch: ProcessEventBatch): RetainedProcessEventBatch {
  const retainable = processEventBatch as RetainableProcessEventBatch;
  const retained = retainable.dup?.() ?? retainable;
  const dispose = retained[Symbol.dispose]?.bind(retained);
  const callback: RetainedProcessEventBatch = Object.assign(
    (batch: Parameters<ProcessEventBatch>[0]) => retained(batch),
    {
      onRpcBroken: retained.onRpcBroken?.bind(retained),
      [Symbol.dispose]() {
        dispose?.();
      },
    },
  );
  return callback;
}

function disposeIgnoredRpcResult(result: unknown): void {
  if (
    result !== null &&
    (typeof result === "object" || typeof result === "function") &&
    Symbol.dispose in result
  ) {
    (result as Disposable)[Symbol.dispose]();
  }
}
