import type { ItxExpression } from "../../itx/expression.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { buildDurableObjectProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import { integrationConnectionStreamPath } from "./utils.ts";

/**
 * The desired durable subscription from an integration connection journal to
 * its router processor. Connection setup owns this append; webhook ingress
 * never creates or subscribes a processor. This module deliberately has no
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
  return buildDurableObjectProcessorSubscriptionConfiguredEvent({
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

/** Birth certificate paired with a connection router subscription. The
 * provider owns the event type; the connection is processor config, not an
 * identity inferred from the stream path. */
export function buildIntegrationRouterCreatedEvent(input: { connection: string; slug: string }) {
  return {
    type: `events.iterate.com/${input.slug}/created`,
    idempotencyKey: `integration-router-created:${input.slug}:${input.connection}`,
    payload: { config: { connection: input.connection } },
  };
}
