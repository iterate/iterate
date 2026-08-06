import {
  CoreProcessorContract,
  type SubscriptionConfiguredPayload,
} from "./core-processor-contract.ts";

export { resolveStreamPath } from "iterate/processors";

// The `${durableObjectName}#${processorSlug}` subscription-key convention
// builder died with the subscription-model redesign
// (docs/stream-subscription-model-redesign.md): names are opaque, and hosted
// processor subscriptions carry a required `processorSlug` plus placement in
// the receiver instead of encoding either into the name.

/**
 * Builds the public `events.iterate.com/stream/subscription-configured` event
 * for a first-party processor hosted as a FACET of the stream's own Durable
 * Object (docs/stream-subscription-model-redesign.md +
 * tasks/stream-processors-as-facets.md).
 *
 * The subscription name is the contract slug — the stream's catalog key, the
 * facet name, and the progress-key component are all this exact string (one
 * identity; validation rejects a processor-wake subscription named anything
 * else). Names never carry a hostname or Durable Object name — placement
 * must not leak into identity.
 *
 * Birth-batch call sites pass a stable `idempotencyKey`, so an ambiguous
 * create retry reuses the same configuration event. The event itself remains
 * the public interface: callers may append it directly.
 */
export function buildFacetProcessorSubscriptionConfiguredEvent(input: {
  idempotencyKey?: string;
  processorSlug: string;
}) {
  return CoreProcessorContract.buildEvent({
    type: "events.iterate.com/stream/subscription-configured",
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    payload: {
      name: input.processorSlug,
      receiver: {
        action: "processor-wake",
        placement: "facet",
        processorSlug: input.processorSlug,
      },
    } satisfies SubscriptionConfiguredPayload,
  });
}
