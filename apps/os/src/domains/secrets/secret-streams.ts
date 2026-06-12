// Write-side helpers for journal-backed Secrets: encrypt material and append
// the lifecycle event to `/secrets/{slug}` in the owning project's namespace.
// This is the ONE place plaintext meets the encryption key on the way in; on
// the way out it's the Secret Durable Object.

import { env } from "cloudflare:workers";
import { getD1ObjectCatalogRecord } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "~/domains/streams/stream-runtime.ts";
import { encryptSecretMaterial, importSecretsKey } from "~/domains/secrets/secret-crypto.ts";
import { SecretDerivation } from "~/domains/secrets/secret-derivation.ts";
import {
  secretStreamPath,
  type SecretSensitivity,
  type SecretTier,
} from "~/domains/secrets/stream-processors/secret/contract.ts";
import {
  ensureSecretStub,
  getSecretDurableObjectName,
  getSecretStub,
} from "~/domains/secrets/durable-objects/secret-durable-object.ts";

type SecretsEnv = {
  DO_CATALOG?: D1Database;
  SECRETS_ENCRYPTION_KEY?: string;
  STREAM: StreamDurableObjectNamespace;
};

export type SetJournaledSecretInput = {
  projectId: string;
  slug: string;
  /** Optional: derived Secrets are born material-less and compute on first use. */
  material?: string;
  metadata?: Record<string, unknown>;
  tier?: SecretTier;
  sensitivity?: SecretSensitivity;
  expiresAt?: string;
  /** How to (re)compute material from other secrets — see secret-derivation.ts. */
  derivation?: SecretDerivation;
  source?: Record<string, unknown>;
};

export async function setJournaledSecret(input: SetJournaledSecretInput) {
  const secretsEnv = env as unknown as SecretsEnv;
  if (!secretsEnv.SECRETS_ENCRYPTION_KEY) {
    throw new Error("SECRETS_ENCRYPTION_KEY is not configured for this deployment.");
  }
  if (input.material == null && input.derivation == null) {
    throw new Error(`Secret ${input.slug} needs material, a derivation, or both.`);
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
      ...(input.material == null
        ? {}
        : { encryptedMaterial: await encryptSecretMaterial({ key, material: input.material }) }),
      ...(input.metadata == null ? {} : { metadata: input.metadata }),
      ...(input.tier == null ? {} : { tier: input.tier }),
      ...(input.sensitivity == null ? {} : { sensitivity: input.sensitivity }),
      ...(input.expiresAt == null ? {} : { expiresAt: input.expiresAt }),
      ...(input.derivation == null ? {} : { derivation: SecretDerivation.parse(input.derivation) }),
      ...(input.source == null ? {} : { source: input.source }),
    },
  });

  // Wake the Secret DO so its subscription lands and refresh alarms arm.
  const stub = await ensureSecretStub({ projectId: input.projectId, slug: input.slug });
  await stub.ensureReady();

  return event;
}

/**
 * Material dereference INSIDE the secret system's trust zone. After the
 * egress pipe learned to DELEGATE (the secrets' own DOs substitute and
 * fetch), the callers are down to: the Discord gateway's identify frame (a
 * websocket message has no fetch hop to substitute at) and sibling Secret
 * DOs resolving derivation sources. SDKs and the egress pipe never see
 * material.
 */
export async function revealJournaledSecretForPlatformUse(input: {
  projectId: string;
  slug: string;
  usedBy: string;
}): Promise<string> {
  return await getSecretStub({ projectId: input.projectId, slug: input.slug }).revealForPlatformUse(
    { usedBy: input.usedBy },
  );
}

/**
 * The pipe-side half of egress DELEGATION. The terminal pipe never touches
 * journaled material: it splits a request's `getSecret({ key })` references
 * into journaled keys (each backed by a Secret DO) and legacy D1 keys, and
 * hands the request into the journaled CHAIN — the first secret's DO
 * substitutes its own reference (re-deriving inline if stale) and forwards;
 * the LAST hop performs the outbound fetch. Material only exists inside
 * Secret DOs and the wire to the API.
 *
 * Existence is checked against the DO catalog — probing an arbitrary key
 * must not mint an empty Secret DO (and its stream) as a side effect.
 */
export async function splitJournaledSecretKeys(input: {
  projectId: string;
  keys: string[];
}): Promise<{ journaled: string[]; legacy: string[] }> {
  const secretsEnv = env as unknown as SecretsEnv;
  const journaled: string[] = [];
  const legacy: string[] = [];
  for (const key of input.keys) {
    const record = secretsEnv.DO_CATALOG
      ? await getD1ObjectCatalogRecord(secretsEnv.DO_CATALOG, {
          className: "SecretDurableObject",
          name: getSecretDurableObjectName({ projectId: input.projectId, slug: key }),
        })
      : null;
    (record == null ? legacy : journaled).push(key);
  }
  return { journaled, legacy };
}

/** Hand the request to the chain's first Secret DO; the last hop fetches. */
export async function delegateEgressFetchToSecretChain(input: {
  projectId: string;
  keys: string[];
  request: Request;
}): Promise<Response> {
  return await getSecretStub({ projectId: input.projectId, slug: input.keys[0]! }).egressFetch({
    request: input.request,
    keys: input.keys,
  });
}
