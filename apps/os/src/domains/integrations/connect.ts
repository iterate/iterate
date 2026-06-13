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
  IntegrationAccount,
  integrationAccountStreamPath,
} from "~/domains/integrations/integration-events.ts";
import { ensureIntegrationStub } from "~/domains/integrations/durable-objects/integration-durable-object.ts";
import { ensureIntegrationIngressStub } from "~/domains/integrations/durable-objects/integration-ingress-durable-object.ts";
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
  /** Consented takeover of already-owned routing keys (the interstitial). */
  takeover?: boolean;
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

/** A requested routing key is already owned by someone else and the connect
 * didn't carry consent (`takeover: true`) — the caller must run the takeover
 * interstitial (or pass takeover explicitly from a trusted path). */
export class RoutingKeyConflictError extends Error {
  readonly routingKey: string;
  readonly owner: { projectId: string; account: string };

  constructor(input: {
    integration: string;
    routingKey: string;
    owner: { projectId: string; account: string };
  }) {
    super(
      `Routing key "${input.routingKey}" for ${input.integration} is already connected to ` +
        `project ${input.owner.projectId} (account "${input.owner.account}"). ` +
        `Reconnecting it here requires an explicit takeover.`,
    );
    this.name = "RoutingKeyConflictError";
    this.routingKey = input.routingKey;
    this.owner = input.owner;
  }
}

export async function connectIntegration(input: ConnectIntegrationInput) {
  const definition = getIntegration(input.integration);
  const account = IntegrationAccount.parse(input.account ?? DEFAULT_INTEGRATION_ACCOUNT);
  const connectEnv = env as unknown as ConnectEnv;

  // Fail loudly on routing-key theft BEFORE journaling anything: the ingress
  // fold is still the authority (first claim wins there regardless), but
  // without this guard a conflicting connect would report success while the
  // provider's events kept routing to the existing owner. Reads of the route
  // table are best-effort (two simultaneous connects can both pass); the
  // fold settles ties. The OAuth interstitial path passes takeover: true
  // after the user consents.
  if (input.takeover !== true && input.routingKeys.length > 0) {
    const router = await ensureIntegrationIngressStub(definition.slug);
    const snapshot = (await router.ensureReady()) as {
      state: { routes: Record<string, { projectId: string; account: string }> };
    };
    for (const routingKey of input.routingKeys) {
      const owner = snapshot.state.routes[routingKey];
      if (owner != null && (owner.projectId !== input.projectId || owner.account !== account)) {
        throw new RoutingKeyConflictError({
          integration: definition.slug,
          routingKey,
          owner,
        });
      }
    }
  }

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
  // Idempotency keyed by a digest of the connect CONTENT (computed over the
  // plaintext inputs, before per-encryption IVs make ciphertexts unique):
  // a retried connect with identical inputs dedupes to one event; a genuine
  // reconnect with new credentials digests differently and re-runs the
  // choreography.
  const contentDigest = await sha256Hex(
    JSON.stringify({
      integration: definition.slug,
      account,
      ownership: input.ownership,
      externalId: input.externalId,
      displayName: input.displayName ?? null,
      routingKeys: input.routingKeys,
      takeover: input.takeover === true,
      secrets: input.secrets,
    }),
  );
  await accountStream.append({
    type: "events.iterate.com/integration/connect-requested",
    idempotencyKey: `integration-connect:${definition.slug}:${account}:${contentDigest}`,
    payload: {
      integration: definition.slug,
      account,
      projectId: input.projectId,
      ownership: input.ownership,
      externalId: input.externalId,
      ...(input.displayName == null ? {} : { displayName: input.displayName }),
      routingKeys: input.routingKeys,
      ...(input.takeover === true ? { takeover: true } : {}),
      secrets,
    },
  });

  // Wake the account's domain object and wait for its processor to run the
  // choreography (blockProcessorWhile means catch-up implies completion).
  // Routing freshness: that completion includes the claimRoute append, so by
  // the time connect returns, `route-registered` is DURABLY on the global
  // capture stream. The ingress router makes its per-event routing decision
  // against the fold at each event's offset — every webhook captured after
  // that append routes correctly regardless of when the router's checkpoint
  // catches up, so waiting on the global fold here would add cross-DO
  // latency without changing any outcome.
  const stub = await ensureIntegrationStub({
    account,
    integration: definition.slug,
    projectId: input.projectId,
  });
  await stub.ensureReady();

  return { integration: definition.slug, account, projectId: input.projectId };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
