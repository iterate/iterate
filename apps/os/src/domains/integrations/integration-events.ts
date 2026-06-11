// Shared event types and stream paths for the integrations domain. One
// vocabulary for every provider — `integration/event-received` carries an
// `integration` slug and a `transport` instead of each provider minting its
// own `{provider}/webhook-received` type.

import { z } from "zod";
import { StreamPath } from "@iterate-com/shared/streams/types";

/** Project-namespace lifecycle stream: `{projectId}:/integrations/{slug}`. */
export function integrationStreamPath(slug: string): StreamPath {
  return StreamPath.parse(`/integrations/${slug}`);
}

/** GLOBAL-namespace ingress capture stream: `{global}:/integrations/{slug}/webhooks`.
 * Raw provider events (webhook bodies, gateway dispatches) land here verbatim
 * before any routing decision — capture gates the 200, interpretation never
 * does. */
export function integrationIngressStreamPath(slug: string): StreamPath {
  return StreamPath.parse(`/integrations/${slug}/webhooks`);
}

export const INTEGRATION_EVENT_RECEIVED = "events.iterate.com/integration/event-received";
export const INTEGRATION_ROUTE_REGISTERED = "events.iterate.com/integration/route-registered";
export const INTEGRATION_ROUTE_REMOVED = "events.iterate.com/integration/route-removed";
export const INTEGRATION_CONNECTED = "events.iterate.com/integration/connected";
export const INTEGRATION_DISCONNECTED = "events.iterate.com/integration/disconnected";

export const IntegrationEventReceivedPayload = z.object({
  integration: z.string(),
  transport: z.enum(["webhook", "gateway"]),
  routingKey: z.string().nullable(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.unknown(),
});
export type IntegrationEventReceivedPayload = z.infer<typeof IntegrationEventReceivedPayload>;

export const IntegrationRouteRegisteredPayload = z.object({
  integration: z.string(),
  routingKey: z.string(),
  projectId: z.string(),
});

export const IntegrationRouteRemovedPayload = z.object({
  integration: z.string(),
  routingKey: z.string(),
});

export const IntegrationConnectedPayload = z.object({
  integration: z.string(),
  projectId: z.string(),
  /** Whose app registration backs this connection — see definition.ts. */
  ownership: z.enum(["first-party", "customer"]),
  externalId: z.string(),
  displayName: z.string().optional(),
  /** Routing keys this connection claims on the global ingress stream. */
  routingKeys: z.array(z.string()),
  /** Slugs of the Secrets this connection provided (streams under /secrets/). */
  providedSecretSlugs: z.array(z.string()),
});

export const IntegrationDisconnectedPayload = z.object({
  integration: z.string(),
  projectId: z.string(),
  externalId: z.string().optional(),
});
