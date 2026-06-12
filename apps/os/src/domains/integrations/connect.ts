// Connecting an integration account is ONE append: encrypt the credentials
// at the edge, then put `integration/connect-requested` on the account's
// stream. The integration PROCESSOR owns the choreography from there
// (secret/set appends, the connected fact, routing-key claims) — see
// stream-processors/integration. Whether the credentials came from a
// first-party OAuth callback, a customer's own app registration, or a CLI
// paste, every connect path reduces to this append.

import { env } from "cloudflare:workers";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "~/domains/streams/stream-runtime.ts";
import { getIntegration } from "~/domains/integrations/registry.ts";
import {
  DEFAULT_INTEGRATION_ACCOUNT,
  integrationAccountStreamPath,
} from "~/domains/integrations/integration-events.ts";
import { ensureIntegrationStub } from "~/domains/integrations/durable-objects/integration-durable-object.ts";
import { encryptSecretMaterial, importSecretsKey } from "~/domains/secrets/secret-crypto.ts";
import { SecretDerivation } from "~/domains/secrets/secret-derivation.ts";
import type {
  SecretSensitivity,
  SecretTier,
} from "~/domains/secrets/stream-processors/secret/contract.ts";

type ConnectEnv = {
  SECRETS_ENCRYPTION_KEY?: string;
  STREAM: StreamDurableObjectNamespace;
};

export type ConnectIntegrationInput = {
  integration: string;
  /** The instance name — omit for the unnamed single-account case. */
  account?: string;
  projectId: string;
  ownership: "first-party" | "customer";
  /** Provider-side identity of the connection (installation id, guild id…). */
  externalId: string;
  displayName?: string;
  /** Routing keys this account claims (e.g. ["installation:123"]). */
  routingKeys: string[];
  /** Secrets this account provides, by PROVIDED-SECRET NAME (the definition's
   * providedSecrets); slugs compose as {integration}/{account}/{name}. */
  secrets: {
    name: string;
    material?: string;
    metadata?: Record<string, unknown>;
    tier?: SecretTier;
    sensitivity?: SecretSensitivity;
    derivation?: SecretDerivation;
    expiresAt?: string;
  }[];
};

export async function connectIntegration(input: ConnectIntegrationInput) {
  const definition = getIntegration(input.integration);
  const account = input.account ?? DEFAULT_INTEGRATION_ACCOUNT;
  const connectEnv = env as unknown as ConnectEnv;

  // Encrypt at the edge: plaintext never rides on the stream, even inside
  // the connect request.
  if (input.secrets.some((secret) => secret.material != null)) {
    if (!connectEnv.SECRETS_ENCRYPTION_KEY) {
      throw new Error("SECRETS_ENCRYPTION_KEY is not configured for this deployment.");
    }
  }
  const key = connectEnv.SECRETS_ENCRYPTION_KEY
    ? await importSecretsKey(connectEnv.SECRETS_ENCRYPTION_KEY)
    : null;
  const secrets = await Promise.all(
    input.secrets.map(async ({ material, derivation, ...secret }) => ({
      ...secret,
      ...(derivation == null ? {} : { derivation: SecretDerivation.parse(derivation) }),
      ...(material == null
        ? {}
        : { encryptedMaterial: await encryptSecretMaterial({ key: key!, material }) }),
    })),
  );

  const accountStream = await getInitializedStreamStub({
    durableObjectNamespace: connectEnv.STREAM,
    namespace: input.projectId,
    path: integrationAccountStreamPath(definition.slug, account),
  });
  await accountStream.append({
    type: "events.iterate.com/integration/connect-requested",
    idempotencyKey: `integration-connect:${definition.slug}:${account}:${input.externalId}:${crypto.randomUUID()}`,
    payload: {
      integration: definition.slug,
      account,
      projectId: input.projectId,
      ownership: input.ownership,
      externalId: input.externalId,
      ...(input.displayName == null ? {} : { displayName: input.displayName }),
      routingKeys: input.routingKeys,
      secrets,
    },
  });

  // Wake the account's domain object and wait for its processor to run the
  // choreography (blockProcessorWhile means catch-up implies completion).
  const stub = await ensureIntegrationStub({
    account,
    integration: definition.slug,
    projectId: input.projectId,
  });
  await stub.ensureReady();

  return { integration: definition.slug, account, projectId: input.projectId };
}
