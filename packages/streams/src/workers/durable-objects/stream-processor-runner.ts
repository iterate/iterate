// Generic processor host DO for the streams staging worker. Hosts the example
// processors (echo, circuit-breaker) on the class-based model so the streams
// e2e suite exercises the same Callable subscription path real apps use.

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
}

export const StreamProcessorRunnerRpcTarget = makeRpcTargetClass<
  Pick<StreamProcessorRunner, "requestStreamSubscription" | "runtimeState">,
  StreamProcessorRunner
>(StreamProcessorRunner);
