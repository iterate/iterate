import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { durableObjectProcessorSubscriber } from "./engine/shared/callable-subscriber.ts";
import type { Stream } from "./types.ts";

/**
 * Builds a `subscription-configured` event that points a stream at a named
 * processor hosted on a Durable Object.
 *
 * `subscriptionKey` is the sole identity of the subscription — uniformly
 * `${processorName}:${durableObjectName}`, which is unique across processors on
 * one stream (they differ by `processorName`) and the same processor on
 * different hosts (they differ by name). The stream reducer is keyed by it, so
 * re-appending the same key reconfigures the same subscription rather than
 * adding a new one. There is no separate idempotency key: callers that re-run
 * this on every operation should append only when the key is not already in the
 * stream's reduced subscriptions (see `AgentRpcTarget#ensureProcessorsConfigured`).
 */
export function subscriptionConfiguredEvent(input: {
  projectId: string;
  path: string;
  bindingName: string;
  processorName: string;
}) {
  const durableObjectName = DurableObjectNameCodec.stringify({
    projectId: input.projectId,
    path: input.path,
  });
  return {
    type: "events.iterate.com/stream/subscription-configured" as const,
    payload: {
      subscriptionKey: `${input.processorName}:${durableObjectName}`,
      subscriber: durableObjectProcessorSubscriber({
        bindingName: input.bindingName,
        durableObjectName,
        processorName: input.processorName,
      }),
    },
  } satisfies Parameters<Stream["append"]>[0];
}
