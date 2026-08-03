import { buildFacetProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";

/**
 * The subscription that makes an integration connection stream wake
 * its router processor (hosted as a facet of the connection stream's own
 * Durable Object). Connection setup owns this append; webhook ingress
 * never configures that processor. This module deliberately has no
 * runtime bindings so setup and Node E2E fixtures build the same public facts.
 *
 * The idempotency key fingerprints the receiver itself. A future
 * processor-slug or placement change therefore appends one replacement
 * configuration per connection without a hand-written data migration.
 */
export function buildIntegrationRouterSubscriptionConfiguredEvent(input: {
  connection: string;
  processorSlug: string;
  projectId: string;
  slug: string;
}) {
  return buildFacetProcessorSubscriptionConfiguredEvent({
    idempotencyKey: `integration-router-subscription:${JSON.stringify({
      placement: "facet",
      processorSlug: input.processorSlug,
    })}`,
    processorSlug: input.processorSlug,
  });
}

/** Birth certificate paired with the connection router's subscription. The
 * provider owns the event type; the connection is processor config, not an
 * identity inferred from the stream path. */
export function buildIntegrationRouterCreatedEvent(input: { connection: string; slug: string }) {
  return {
    type: `events.iterate.com/${input.slug}/created`,
    idempotencyKey: `integration-router-created:${input.slug}:${input.connection}`,
    payload: { config: { connection: input.connection } },
  };
}
