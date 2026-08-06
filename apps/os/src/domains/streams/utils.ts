import {
  CoreProcessorContract,
  type SubscriptionConfiguredPayload,
} from "./core-processor-contract.ts";

export { resolveStreamPath } from "iterate/processors";

// The `${durableObjectName}#${slug}` subscription-key convention builder died
// with the subscription-model redesign
// (docs/stream-subscription-model-redesign.md): names are opaque, and the
// subscription NAME alone selects which registered contract a hosted
// processor subscription runs — nothing else is encoded anywhere.

/**
 * Builds the public `events.iterate.com/stream/subscription-configured` event
 * for a first-party processor hosted as a FACET of the stream's own Durable
 * Object (docs/stream-subscription-model-redesign.md +
 * tasks/stream-processors-as-facets.md).
 *
 * `name` is the contract slug — the stream's catalog key, the facet name, and
 * the wake route are all this exact string (one identity; a name matching no
 * registered processor fails loudly at wake). Names never carry a hostname or
 * Durable Object name — placement must not leak into identity.
 *
 * Birth-batch call sites pass a stable `idempotencyKey`, so an ambiguous
 * create retry reuses the same configuration event. The event itself remains
 * the public interface: callers may append it directly.
 */
export function buildFacetProcessorSubscriptionConfiguredEvent(input: {
  idempotencyKey?: string;
  /** The subscription name == the registered contract slug. */
  name: string;
}) {
  return CoreProcessorContract.buildEvent({
    type: "events.iterate.com/stream/subscription-configured",
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    payload: {
      name: input.name,
      receiver: {
        action: "processor-wake",
        placement: "facet",
      },
    } satisfies SubscriptionConfiguredPayload,
  });
}
