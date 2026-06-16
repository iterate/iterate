// Test/example processor host DO for the streams worker harness. It hosts only
// the echo and circuit-breaker example processors so stream-engine tests and
// the streams example app can exercise Callable subscription delivery without
// implying that apps/os production uses a standalone StreamProcessorRunner.

import { newWorkersRpcResponse } from "capnweb";
import { DurableObject } from "cloudflare:workers";
import { makeRpcTargetClass } from "../../shared/rpc-target.ts";
import { EchoExampleProcessor } from "../../processors/examples/echo/implementation.ts";
import { CircuitBreakerProcessor } from "../../processors/circuit-breaker/implementation.ts";
import {
  createStreamProcessorHost,
  type HostedProcessorRuntimeState,
  type RequestStreamSubscriptionArgs,
} from "../stream-processor-host.ts";

export class StreamProcessorRunner extends DurableObject {
  host = createStreamProcessorHost(this.ctx);
  echo = this.host.add("echo-example", (deps) => new EchoExampleProcessor(deps));
  circuitBreaker = this.host.add("circuit-breaker", (deps) => new CircuitBreakerProcessor(deps));

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
}

export const StreamProcessorRunnerRpcTarget = makeRpcTargetClass<
  Pick<StreamProcessorRunner, "requestStreamSubscription" | "runtimeState">,
  StreamProcessorRunner
>(StreamProcessorRunner);
