// Test/example processor host DO for the streams worker harness. It hosts only
// the echo and circuit-breaker example processors so stream-engine tests and
// the streams example app can exercise Callable subscription delivery without
// implying that apps/os production uses a standalone StreamProcessorRunner.

import { newWorkersRpcResponse } from "capnweb";
import { DurableObject } from "cloudflare:workers";
import { makeRpcTargetClass } from "../../shared/rpc-target.ts";
import { EchoExampleProcessor } from "../../processors/examples/echo/implementation.ts";
import { CircuitBreakerProcessor } from "../../processors/circuit-breaker/implementation.ts";
import type { Stream } from "../durable-objects/stream.ts";
import { getStreamRpcStub } from "../../../stream-runtime.ts";
import { parseDurableObjectName } from "../../../../durable-object-names.ts";
import {
  createStreamProcessorHost,
  type HostedProcessorRuntimeState,
  type RequestStreamSubscriptionArgs,
} from "../stream-processor-host.ts";

type StreamProcessorRunnerEnv = {
  STREAM: DurableObjectNamespace<Stream>;
};

export class StreamProcessorRunner extends DurableObject<StreamProcessorRunnerEnv> {
  host = createStreamProcessorHost(this.ctx);
  echo = this.host.add(
    "echo-example",
    (deps) => new EchoExampleProcessor({ ...deps, stream: this.streamRpc() }),
  );
  circuitBreaker = this.host.add(
    "circuit-breaker",
    (deps) => new CircuitBreakerProcessor({ ...deps, stream: this.streamRpc() }),
  );

  // Legacy/external Cap'n Web entrypoint. Same-account Stream Durable Objects
  // dispatch the subscription callable straight at requestStreamSubscription.
  async fetch(request: Request) {
    return newWorkersRpcResponse(request, new StreamProcessorRunnerRpcTarget(this));
  }

  requestStreamSubscription(args: RequestStreamSubscriptionArgs): Promise<void> {
    return this.host.requestStreamSubscription(args);
  }

  /** Returns durable processor state for test fixtures and operator inspection. */
  runtimeState(args?: { processorName?: string }): HostedProcessorRuntimeState {
    return this.host.runtimeState(args?.processorName);
  }

  /**
   * Subscriber-side idle teardown (belt-and-braces companion to the Stream DO's):
   * drop retained stream stubs so this DO and the producer can hibernate. The
   * idle timer calls this automatically; exposed for tests/operators.
   */
  runIdleDisconnectNow(): void {
    this.host.runIdleDisconnectNow();
  }

  private streamRpc() {
    const name = this.ctx.id.name;
    if (!name) {
      throw new Error("StreamProcessorRunner must be addressed by name.");
    }
    const separator = name.lastIndexOf(":");
    if (separator <= 0) {
      throw new Error(
        `StreamProcessorRunner name must be "{streamDurableObjectName}:{subscriptionKey}", got ${JSON.stringify(name)}.`,
      );
    }
    const streamName = name.slice(0, separator);
    const coordinate = parseDurableObjectName(streamName);
    return getStreamRpcStub({
      durableObjectNamespace: this.env.STREAM,
      projectId: coordinate.projectId,
      path: coordinate.path,
    });
  }
}

export const StreamProcessorRunnerRpcTarget = makeRpcTargetClass<
  Pick<StreamProcessorRunner, "requestStreamSubscription" | "runtimeState">,
  StreamProcessorRunner
>(StreamProcessorRunner);
