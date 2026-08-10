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
 * create retry reuses the same configuration event. Facet placement is
 * PLATFORM-INTERNAL: the stream's core processor rejects it on the public
 * append lane (core-processor.ts validate), so this event only commits
 * through a platform (core-event) append — the trusted creation doors'
 * platform lane, the facet composition's processor stream, or the Durable
 * Object's own core-event verbs.
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
        action: "facet-processor",
        source: { kind: "builtin" },
      },
    } satisfies SubscriptionConfiguredPayload,
  });
}

/** Stable across Workers RPC, which does not preserve custom error classes. */
const UNCONFIGURED_SUBSCRIPTION_ERROR_PREFIX = "stream-subscription-unconfigured: ";

/** Build the Stream DO refusal for a processor name absent from its committed catalog. */
export function unconfiguredSubscriptionError(name: string): Error {
  return new Error(
    `${UNCONFIGURED_SUBSCRIPTION_ERROR_PREFIX}subscription ${JSON.stringify(name)} does not exist`,
  );
}

/**
 * The Stream DO's processor doors refuse a name the committed catalog does not
 * configure — a read must never materialize a facet (`ctx.facets.get` creates
 * one on first dial). Selected domain reads classify that refusal and answer
 * with the processor contract's initial fold while preserving every other
 * error. The owned prefix prevents unrelated "does not exist" errors from
 * being mistaken for this condition across Workers RPC.
 */
export function isUnconfiguredSubscriptionError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith(UNCONFIGURED_SUBSCRIPTION_ERROR_PREFIX);
}
