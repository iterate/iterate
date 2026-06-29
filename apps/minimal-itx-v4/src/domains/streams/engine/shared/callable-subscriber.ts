// Builds `subscription-configured` subscriber payloads that point a stream at a
// processor host. The Stream DO dispatches the callable with the subscription
// handshake; `transformInput.shallowMerge` bakes in which named processor on
// the host the subscription targets.

import type { Callable } from "@iterate-com/shared/callable/types.ts";

/**
 * Subscriber descriptor for a processor hosted on a Durable Object reachable
 * through an env binding on the worker that runs the Stream DO.
 */
export function durableObjectProcessorSubscriber(args: {
  /** Env binding name for the host DO namespace, e.g. "AGENT". */
  bindingName: string;
  /** The host DO instance name (`getByName`). */
  durableObjectName: string;
  /** The named processor registered on the host via `host.add(name, ...)`. */
  processorName: string;
  /** RPC method wired to `host.requestStreamSubscription`. */
  rpcMethod?: string;
}): { type: "callable"; callable: Callable } {
  return {
    type: "callable",
    callable: {
      type: "workers-rpc",
      via: {
        type: "env-binding",
        bindingType: "durable-object-namespace",
        bindingName: args.bindingName,
        durableObject: { name: args.durableObjectName },
      },
      rpcMethod: args.rpcMethod ?? "requestStreamSubscription",
      argsMode: "object",
      transformInput: { shallowMerge: { processorName: args.processorName } },
    },
  };
}
