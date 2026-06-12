// Shared event types and stream paths for the integrations domain. One
// vocabulary for every provider — `integration/event-received` carries an
// `integration` slug and a `transport` instead of each provider minting its
// own `{provider}/webhook-received` type.

import { z } from "zod";
import { StreamPath } from "@iterate-com/shared/streams/types";
import { EncryptedMaterial } from "~/domains/secrets/secret-crypto.ts";
import { SecretDerivation } from "~/domains/secrets/secret-derivation.ts";
import {
  SecretSensitivity,
  SecretTier,
} from "~/domains/secrets/stream-processors/secret/contract.ts";

/**
 * An integration ACCOUNT is the instance of an integration: "google" is the
 * type, "google as jonas@nustom.com" is an account. A project can hold many
 * accounts of the same integration; everything instance-shaped — the
 * lifecycle stream, the domain object, provided secrets, routing claims, the
 * itx address — is keyed by (integration, account). The unnamed common case
 * connects as account "default", so single-account projects never see the
 * dimension.
 */
export const IntegrationAccount = z
  .string()
  .trim()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "Account names are lowercase kebab-case")
  .refine((value) => value !== "webhooks", "'webhooks' is reserved");
export const DEFAULT_INTEGRATION_ACCOUNT = "default";

/** Project-namespace lifecycle stream for ONE account:
 * `{projectId}:/integrations/{slug}/{account}`. Accounts enumerate as the
 * child paths of `/integrations/{slug}`. */
export function integrationAccountStreamPath(slug: string, account: string): StreamPath {
  return StreamPath.parse(`/integrations/${slug}/${IntegrationAccount.parse(account)}`);
}

/** GLOBAL-namespace ingress capture stream: `{global}:/integrations/{slug}/webhooks`.
 * Raw provider events (webhook bodies, gateway dispatches) land here verbatim
 * before any routing decision — capture gates the 200, interpretation never
 * does. */
export function integrationIngressStreamPath(slug: string): StreamPath {
  return StreamPath.parse(`/integrations/${slug}/webhooks`);
}

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
  account: z.string(),
});

export const IntegrationRouteRemovedPayload = z.object({
  integration: z.string(),
  routingKey: z.string(),
});

/** The ONE connect fact: everything an account connection needs, in a single
 * event on the account's own stream. The integration PROCESSOR reacts with
 * the whole choreography (secret/set appends, the connected fact, routing-key
 * claims) — provider OAuth callbacks, CLI pastes, and customer app
 * registrations all reduce to appending this. Credential material rides
 * encrypted, like every secret-bearing payload. */
export const IntegrationConnectRequestedPayload = z.object({
  integration: z.string(),
  account: z.string(),
  projectId: z.string(),
  ownership: z.enum(["first-party", "customer"]),
  externalId: z.string(),
  displayName: z.string().optional(),
  routingKeys: z.array(z.string()),
  secrets: z.array(
    z.object({
      /** Provided-secret NAME; the slug composes as {slug}/{account}/{name}. */
      name: z.string(),
      encryptedMaterial: EncryptedMaterial.optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
      tier: SecretTier.optional(),
      sensitivity: SecretSensitivity.optional(),
      derivation: SecretDerivation.optional(),
      expiresAt: z.string().optional(),
    }),
  ),
});

export const IntegrationConnectedPayload = z.object({
  integration: z.string(),
  account: z.string(),
  projectId: z.string(),
  /** Whose app registration backs this connection — see definition.ts. */
  ownership: z.enum(["first-party", "customer"]),
  externalId: z.string(),
  displayName: z.string().optional(),
  /** Routing keys this account claims on the global ingress stream. */
  routingKeys: z.array(z.string()),
  /** Slugs of the Secrets this account provided (streams under /secrets/). */
  providedSecretSlugs: z.array(z.string()),
});

export const IntegrationDisconnectedPayload = z.object({
  integration: z.string(),
  account: z.string(),
  projectId: z.string(),
  externalId: z.string().optional(),
});
