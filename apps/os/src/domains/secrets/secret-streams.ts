// Write-side helpers for journal-backed Secrets: encrypt material and append
// the lifecycle event to `/secrets/{slug}` in the owning project's namespace.
// This is the ONE place plaintext meets the encryption key on the way in; on
// the way out it's the Secret Durable Object.

import { env } from "cloudflare:workers";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "~/domains/streams/stream-runtime.ts";
import { encryptSecretMaterial, importSecretsKey } from "~/domains/secrets/secret-crypto.ts";
import {
  secretStreamPath,
  type SecretTier,
} from "~/domains/secrets/stream-processors/secret/contract.ts";
import {
  getSecretDurableObjectName,
  getSecretStub,
} from "~/domains/secrets/durable-objects/secret-durable-object.ts";

type SecretsEnv = {
  SECRETS_ENCRYPTION_KEY?: string;
  STREAM: StreamDurableObjectNamespace;
};

export type SetJournaledSecretInput = {
  projectId: string;
  slug: string;
  material: string;
  metadata?: Record<string, unknown>;
  tier?: SecretTier;
  expiresAt?: string;
  /** Plaintext refresh inputs — encrypted here before they touch the journal. */
  refresh?: {
    tokenEndpoint: string;
    clientId: string;
    clientSecretSecretSlug?: string;
    refreshToken?: string;
    refreshLeewaySeconds?: number;
  };
  source?: Record<string, unknown>;
};

export async function setJournaledSecret(input: SetJournaledSecretInput) {
  const secretsEnv = env as unknown as SecretsEnv;
  if (!secretsEnv.SECRETS_ENCRYPTION_KEY) {
    throw new Error("SECRETS_ENCRYPTION_KEY is not configured for this deployment.");
  }
  const key = await importSecretsKey(secretsEnv.SECRETS_ENCRYPTION_KEY);

  const stream = await getInitializedStreamStub({
    durableObjectNamespace: secretsEnv.STREAM,
    namespace: input.projectId,
    path: secretStreamPath(input.slug),
  });
  const event = await stream.append({
    type: "events.iterate.com/secret/set",
    idempotencyKey: `secret-set:${input.slug}:${crypto.randomUUID()}`,
    payload: {
      slug: input.slug,
      encryptedMaterial: await encryptSecretMaterial({ key, material: input.material }),
      ...(input.metadata == null ? {} : { metadata: input.metadata }),
      ...(input.tier == null ? {} : { tier: input.tier }),
      ...(input.expiresAt == null ? {} : { expiresAt: input.expiresAt }),
      ...(input.refresh == null
        ? {}
        : {
            refresh: {
              kind: "oauth-refresh-token" as const,
              tokenEndpoint: input.refresh.tokenEndpoint,
              clientId: input.refresh.clientId,
              ...(input.refresh.clientSecretSecretSlug == null
                ? {}
                : { clientSecretSecretSlug: input.refresh.clientSecretSecretSlug }),
              ...(input.refresh.refreshToken == null
                ? {}
                : {
                    encryptedRefreshToken: await encryptSecretMaterial({
                      key,
                      material: input.refresh.refreshToken,
                    }),
                  }),
              refreshLeewaySeconds: input.refresh.refreshLeewaySeconds ?? 300,
            },
          }),
      ...(input.source == null ? {} : { source: input.source }),
    },
  });

  // Wake the Secret DO so its subscription lands and refresh alarms arm.
  const stub = getSecretStub({ projectId: input.projectId, slug: input.slug });
  await stub.initialize({
    name: getSecretDurableObjectName({ projectId: input.projectId, slug: input.slug }),
  });
  await stub.ensureReady();

  return event;
}

/**
 * Platform-trusted material dereference, used by first-party loopback
 * capabilities (e.g. IntegrationsCapability building an SDK client). Tries the
 * project's journaled Secret first; `fallbackEnvVar` covers first-party
 * deployment-level credentials (e.g. a shared bot token in Doppler) so dev
 * environments work before any per-project connect flow has run.
 */
export async function revealJournaledSecretForPlatformUse(input: {
  projectId: string;
  slug: string;
  usedBy: string;
  fallbackEnvVar?: string;
}): Promise<string> {
  const stub = getSecretStub({ projectId: input.projectId, slug: input.slug });
  try {
    return await stub.revealForPlatformUse({ usedBy: input.usedBy });
  } catch (error) {
    const fallback = input.fallbackEnvVar
      ? (env as unknown as Record<string, string | undefined>)[input.fallbackEnvVar]
      : undefined;
    if (fallback) return fallback;
    throw error;
  }
}
