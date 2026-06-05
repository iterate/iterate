import { newWorkersRpcResponse, type RpcStub } from "capnweb";
import { DurableObject } from "cloudflare:workers";
import { makeRpcTargetClass } from "../../shared/rpc-target.ts";
import { createStreamSubscription, type StreamSubscription } from "../../subscription.ts";
import {
  createProcessorRunner,
  type ProcessorRunner,
  type Snapshot,
} from "../../processor-runner.ts";
import { echoExampleProcessor } from "../../processors/examples/echo/implementation.ts";
import { circuitBreakerProcessor } from "../../processors/circuit-breaker/implementation.ts";
import type { StreamCoreProcessorState } from "../../types.ts";
import type { SubscriptionConfiguredEvent } from "../../processors/core/contract.ts";
import type { StreamProcessorRunnerRpc, StreamRpc, SubscriptionSink } from "../../types.ts";
import type { Processor } from "../../processor.ts";

type HostedProcessor = Processor<any, undefined>;
type HostedProcessorRunnerSnapshot = Snapshot<unknown>;

export class StreamProcessorRunner extends DurableObject {
  #stream: RpcStub<StreamRpc> | undefined;
  #runner: ProcessorRunner | undefined;
  #subscription: StreamSubscription | undefined;
  #processing: AsyncDisposable | undefined;

  // Stream durable object calls fetch on us to wake us up and establish a capnweb rpc connection
  // whenever an event is appended to a stream that this StreamProcessorRunner is subscribed to,
  // but there isn't an active capnweb rpc connection between Stream and StreamProcessorRunner.
  async fetch(request: Request) {
    return newWorkersRpcResponse(request, new StreamProcessorRunnerRpcTarget(this));
  }

  // The Stream Durable Object calls this method and we have to return an RpcTarget
  // that implements processEventBatch.
  async requestSubscription(args: {
    stream: RpcStub<StreamRpc>;
    subscriptionKey: string;
    streamMaxOffset: number;
    subscriptionConfiguredEvent: SubscriptionConfiguredEvent;
    streamRuntimeState: { coreProcessorState: StreamCoreProcessorState };
  }): Promise<{ sink: SubscriptionSink; replayAfterOffset?: number }> {
    const processorSlug = getHostedProcessorSlug(args);
    const processor = getHostedProcessor(processorSlug);
    if (processor === undefined) {
      throw new Error(`Unknown hosted processor slug: ${processorSlug}`);
    }

    await this.#processing?.[Symbol.asyncDispose]();
    await this.#subscription?.[Symbol.asyncDispose]();
    this.#stream?.[Symbol.dispose]();
    this.#stream = args.stream.dup();
    this.ctx.storage.kv.put("processorSlug", processor.contract.slug);
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
    this.#subscription = createStreamSubscription({
      subscriptionKey: args.subscriptionKey,
    });
    this.#processing = this.#runner.run({
      subscription: this.#subscription,
    });
    return {
      sink: this.#subscription.sink,
      replayAfterOffset: snapshot?.offset,
    };
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

function getHostedProcessor(slug: string): HostedProcessor | undefined {
  if (slug === "echo-example") return echoExampleProcessor;
  if (slug === "circuit-breaker") return circuitBreakerProcessor;
  return undefined;
}

function getHostedProcessorSlug(args: {
  subscriptionKey: string;
  subscriptionConfiguredEvent: SubscriptionConfiguredEvent;
}): string {
  const url = args.subscriptionConfiguredEvent.payload.subscriber.url;
  return new URL(url).searchParams.get("processorSlug") ?? args.subscriptionKey;
}
