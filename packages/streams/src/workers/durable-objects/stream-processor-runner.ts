import { newWorkersRpcResponse } from "capnweb";
import { DurableObject } from "cloudflare:workers";
import { makeRpcTargetClass } from "../../shared/rpc-target.ts";
import {
  createProcessorRunner,
  type ProcessorRunner,
  type Snapshot,
} from "../../processor-runner.ts";
import { echoExampleProcessor } from "../../processors/examples/echo/implementation.ts";
import { circuitBreakerProcessor } from "../../processors/circuit-breaker/implementation.ts";
import type { StreamCoreProcessorState } from "../../types.ts";
import type { SubscriptionConfiguredEvent } from "../../processors/core/contract.ts";
import type {
  ProcessEventBatch,
  StreamProcessorRunnerRpc,
  StreamRpc,
  StreamSubscriptionHandle,
} from "../../types.ts";
import type { Processor } from "../../processor.ts";

type HostedProcessor = Processor<any, undefined>;
type HostedProcessorRunnerSnapshot = Snapshot<unknown>;

export class StreamProcessorRunner extends DurableObject {
  #stream: RetainedStreamRpc | undefined;
  #runner: ProcessorRunner | undefined;
  #subscriptionHandle: StreamSubscriptionHandle | undefined;
  #processing: Promise<void> = Promise.resolve();

  // Legacy/external Cap'n Web entrypoint. Same-account Stream Durable Objects call
  // requestSubscription() directly over Workers RPC.
  async fetch(request: Request) {
    return newWorkersRpcResponse(request, new StreamProcessorRunnerRpcTarget(this));
  }

  // The Stream Durable Object calls this over Workers RPC. The runner then
  // subscribes itself to the stream with a processEventBatch callback.
  async requestSubscription(args: {
    stream: StreamRpc;
    subscriptionKey: string;
    streamMaxOffset: number;
    subscriptionConfiguredEvent: SubscriptionConfiguredEvent;
    streamRuntimeState: { coreProcessorState: StreamCoreProcessorState };
  }): Promise<void> {
    const subscriber = args.subscriptionConfiguredEvent.payload.subscriber;
    if (subscriber.type !== "built-in") {
      throw new Error("StreamProcessorRunner only supports built-in subscribers");
    }
    if (subscriber.transport !== "workers-rpc") {
      throw new Error("StreamProcessorRunner only supports workers-rpc subscribers");
    }
    const processor = getBuiltInProcessor(subscriber.processorSlug);
    if (processor === undefined) {
      throw new Error(`Unknown built-in processor slug: ${subscriber.processorSlug}`);
    }

    this.#subscriptionHandle?.unsubscribe();
    await this.#processing.catch(() => {});
    this.#stream?.[Symbol.dispose]();
    // Workers RPC parameter stubs are disposed when the call returns unless
    // duplicated. Processor side effects may append later, so keep this stream
    // capability until the next subscription replaces it.
    // https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/
    this.#stream = retainStreamRpc(args.stream);
    this.ctx.storage.kv.put("processorSlug", subscriber.processorSlug);
    // Same runner path as Node/browser. KV is the storage port; the stream stub is
    // the exact Stream RPC API passed to processor afterAppend.
    this.#runner = createProcessorRunner({
      processor,
      deps: undefined,
      storage: {
        load: () => this.ctx.storage.kv.get<HostedProcessorRunnerSnapshot>("snapshot"),
        save: (snapshot) => void this.ctx.storage.kv.put("snapshot", snapshot),
      },
      stream: this.#stream,
      sideEffectAnchor: {
        offset: args.subscriptionConfiguredEvent.offset,
        createdAt: args.subscriptionConfiguredEvent.createdAt,
      },
    });
    const snapshot = await this.#runner.snapshot();

    const processEventBatch: ProcessEventBatch = (batch) => {
      const currentRunner = this.#runner;
      if (currentRunner === undefined) return;
      const next = this.#processing.then(() => currentRunner.processEventBatch(batch));
      this.#processing = next;
      this.ctx.waitUntil(next);
    };

    this.#subscriptionHandle = await (this.#stream as OutboundStreamRpc).subscribeOutbound({
      subscriptionKey: args.subscriptionKey,
      processEventBatch,
      replayAfterOffset: snapshot?.offset ?? args.subscriptionConfiguredEvent.offset,
    });
  }

  /** Returns durable processor state for test fixtures and operator inspection. */
  runtimeState() {
    return {
      processorSlug: this.ctx.storage.kv.get<string>("processorSlug"),
      snapshot: this.ctx.storage.kv.get<HostedProcessorRunnerSnapshot>("snapshot"),
    };
  }
}

export const StreamProcessorRunnerRpcTarget = makeRpcTargetClass<
  StreamProcessorRunnerRpc,
  StreamProcessorRunner
>(StreamProcessorRunner);

function getBuiltInProcessor(slug: string): HostedProcessor | undefined {
  if (slug === "echo-example") return echoExampleProcessor;
  if (slug === "circuit-breaker") return circuitBreakerProcessor;
  return undefined;
}

type RetainedStreamRpc = StreamRpc &
  Disposable & {
    onRpcBroken?(callback: (error: unknown) => void): void;
  };
type OutboundStreamRpc = RetainedStreamRpc & {
  subscribeOutbound(
    args: Parameters<StreamRpc["subscribe"]>[0],
  ): ReturnType<StreamRpc["subscribe"]>;
};

type RetainableStreamRpc = StreamRpc &
  Partial<Disposable> & {
    dup?(): RetainedStreamRpc;
    onRpcBroken?(callback: (error: unknown) => void): void;
  };

function retainStreamRpc(stream: StreamRpc): RetainedStreamRpc {
  const retainable = stream as RetainableStreamRpc;
  const retained = retainable.dup?.() ?? retainable;
  const dispose = retained[Symbol.dispose]?.bind(retained);
  return Object.assign(retained, {
    [Symbol.dispose]() {
      dispose?.();
    },
  }) as RetainedStreamRpc;
}
