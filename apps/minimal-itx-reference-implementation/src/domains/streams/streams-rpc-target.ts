import { env as workerEnv, RpcTarget } from "cloudflare:workers";
import type {
  ProcessEventBatch,
  StreamRpc,
} from "@iterate-com/os/src/domains/streams/engine/types.ts";
import {
  disposeIgnoredRpcResult,
  retainProcessEventBatch,
} from "@iterate-com/os/src/domains/streams/engine/workers/rpc-lifecycle.ts";
import type { Env } from "../../env.ts";
import { pathInvokerToProxy, type PathInvocation } from "../../itx/path-invoker.ts";
import { replayPath } from "../../itx/processor.ts";
import { formatDurableObjectName } from "../durable-object-names.ts";

export class StreamsRpcTarget extends RpcTarget {
  #projectId: string;

  constructor(input: { projectId: string }) {
    super();
    this.#projectId = input.projectId;
  }

  get(pathInput: string) {
    const path = normalizeStreamPath(pathInput);
    const stream = workerEnv.STREAM.getByName(
      formatDurableObjectName({ projectId: this.#projectId, path }),
    );
    return pathInvokerToProxy(new StreamRpcTarget(stream));
  }
}

export class StreamRpcTarget extends RpcTarget {
  constructor(readonly stream: StreamRpc) {
    super();
  }

  invokeCapability({ args = [], path }: PathInvocation) {
    if (path.length === 1 && path[0] === "subscribe") {
      return this.#subscribe(args[0] as Parameters<StreamRpc["subscribe"]>[0]);
    }
    return replayPath({ args, path, target: this.stream });
  }

  async #subscribe(args: Parameters<StreamRpc["subscribe"]>[0]) {
    // Most Stream methods can replay directly through the stub. subscribe() is
    // different: it receives a callback that the Stream Durable Object will call
    // later, after this RPC returns. Retain that callback locally and forward a
    // fire-and-forget callback to the Stream DO, mirroring apps/os production
    // behaviour without importing its generated StreamRpcTarget class.
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
        eventTypes: args.eventTypes,
        events: args.events,
        processEventBatch,
        replayAfterOffset: args.replayAfterOffset,
        subscriber: args.subscriber,
        subscriptionKey: args.subscriptionKey,
      });

      clientProcessEventBatch.onRpcBroken?.(() => {
        disposeIgnoredRpcResult(subscription.unsubscribe());
        dispose();
      });

      return {
        streamMaxOffset: subscription.streamMaxOffset,
        subscriptionKey: subscription.subscriptionKey,
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
}

function normalizeStreamPath(path: string): string {
  if (!path) throw new Error("stream path must not be empty");
  return path.startsWith("/") ? path : `/${path}`;
}
