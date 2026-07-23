import type { ItxExpression } from "../../itx/expression.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { buildHostedProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import { integrationConnectionStreamPath } from "./utils.ts";

/**
 * The subscription that makes an integration connection stream wake
 * its router processor. Connection setup owns this append; webhook ingress
 * never configures that processor. This module deliberately has no
 * runtime bindings so setup and Node E2E fixtures build the same public facts.
 *
 * The idempotency key fingerprints the persisted capability name itself. A
 * future expression or processor-slug change therefore appends one replacement
 * configuration per connection without a hand-written data migration.
 */
export function buildIntegrationRouterSubscriptionConfiguredEvent(input: {
  connection: string;
  processorSlug: string;
  projectId: string;
  slug: string;
}) {
  const streamPath = integrationConnectionStreamPath(input.slug, input.connection);
  const processor = [
    "integrations",
    input.slug,
    ["get", input.connection],
    "processor",
  ] satisfies ItxExpression;
  return buildHostedProcessorSubscriptionConfiguredEvent({
    durableObjectName: DurableObjectNameCodec.stringify({
      projectId: input.projectId,
      path: streamPath,
    }),
    idempotencyKey: `integration-router-subscription:${JSON.stringify({
      processor,
      processorSlug: input.processorSlug,
    })}`,
    processor,
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
