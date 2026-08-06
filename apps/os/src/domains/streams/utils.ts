import type { StreamEventInput } from "iterate/processors";
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
        action: "processor-wake",
        placement: "facet",
      },
    } satisfies SubscriptionConfiguredPayload,
  });
}

/**
 * True when the batch contains a first-hand event configuring a FACET-placed
 * processor-wake subscription. Facet placement is platform-internal (the
 * stream's core processor rejects it under public append authority), so
 * trusted first-party appenders use this predicate to route exactly these
 * batches through the Stream DO's platform (core-event) append lane while
 * every other append keeps public authority — circuit breaker included.
 */
export function containsFacetProcessorSubscription(events: readonly StreamEventInput[]): boolean {
  return events.some((event) => {
    if (event.type !== "events.iterate.com/stream/subscription-configured") return false;
    if (event.source?.copiedFrom !== undefined) return false;
    const receiver = (
      event.payload as { receiver?: { action?: unknown; placement?: unknown } } | undefined
    )?.receiver;
    return receiver?.action === "processor-wake" && receiver.placement === "facet";
  });
}

/**
 * The Stream DO's processor doors refuse a name the committed catalog does not
 * configure — a read must never MATERIALIZE a facet (`ctx.facets.get` creates
 * one on first dial). Domain doors that read a fold BEFORE its birth batch
 * commits (a secret's create-time offset probe, a device's pre-enrollment
 * read, an unborn project's catalog) use this to substitute the unborn shape
 * the facade used to fabricate. Matched on the message because this crosses a
 * Workers RPC hop, which does not carry error classes.
 */
export function isUnconfiguredSubscriptionError(error: unknown): boolean {
  return error instanceof Error && /^subscription ".*" does not exist$/.test(error.message);
}
