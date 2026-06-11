// Contract for the "secret" processor mounted on `/secrets/{slug}`.
//
// A Secret is a domain object: one stream per secret in the owning project's
// namespace, one Secret Durable Object folding that stream. The journal is the
// write authority for the whole lifecycle — set, rotation (refresh), every
// audited use, deletion — and material appears in payloads ONLY inside the
// AES-GCM envelope (secret-crypto.ts). Plaintext exists transiently inside the
// Secret DO.

import { z } from "zod";
import { defineProcessorContract } from "@iterate-com/streams/shared/stream-processors";
import { StreamPath } from "@iterate-com/shared/streams/types";
import { EncryptedMaterial } from "~/domains/secrets/secret-crypto.ts";

export const SECRETS_STREAM_PREFIX = "/secrets";

/** A Secret's stream path inside its project's namespace. Slugs may be
 * segmented ("github/access-token") so an integration's provided secrets group
 * under `/secrets/{integration}/...`. */
export function secretStreamPath(slug: string): StreamPath {
  return StreamPath.parse(`${SECRETS_STREAM_PREFIX}/${slug}`);
}

/**
 * Which egress hop substitutes (and may decrypt) this secret — the two-tier
 * groundwork:
 *
 * - "project": provided by the customer. Their agents see placeholders only;
 *   substitution happens at the project's egress hop.
 * - "iterate": iterate-owned first-party material (third-party API keys, our
 *   OAuth client secrets). Customers AND their agents see placeholders only;
 *   substitution happens at the platform's terminal egress hop, one level
 *   below project egress.
 */
export const SecretTier = z.enum(["project", "iterate"]);
export type SecretTier = z.infer<typeof SecretTier>;

/** How the Secret DO refreshes its own material before it expires. The
 * refresh token rides encrypted; the OAuth client secret is ANOTHER Secret,
 * referenced by slug — a secret consuming the secret system. */
export const SecretRefreshConfig = z.object({
  kind: z.literal("oauth-refresh-token"),
  tokenEndpoint: z.string(),
  clientId: z.string(),
  clientSecretSecretSlug: z.string().optional(),
  encryptedRefreshToken: EncryptedMaterial.optional(),
  refreshLeewaySeconds: z.number().default(300),
});
export type SecretRefreshConfig = z.infer<typeof SecretRefreshConfig>;

export const SecretProcessorContract = defineProcessorContract({
  slug: "secret",
  version: "0.1.0",
  description:
    "Folds one Secret's lifecycle journal at /secrets/{slug}: encrypted material versions, refresh config, and a per-use audit trail.",
  stateSchema: z.object({
    slug: z.string().optional(),
    status: z.enum(["unset", "set", "deleted"]).default("unset"),
    /** Increments on every set/rotation — a cheap rotation audit. */
    version: z.number().default(0),
    encryptedMaterial: EncryptedMaterial.optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
    tier: SecretTier.default("project"),
    refresh: SecretRefreshConfig.optional(),
    expiresAt: z.string().optional(),
    audit: z
      .object({
        uses: z.number().default(0),
        lastUsedAt: z.string().optional(),
        lastUsedBy: z.string().optional(),
      })
      .default({ uses: 0 }),
  }),
  initialState: {},
  events: {
    "events.iterate.com/secret/set": {
      description:
        "A Secret's material was set (or replaced) by its owner. Material is AES-GCM encrypted with the deployment key; plaintext never appears on the stream.",
      payloadSchema: z.object({
        slug: z.string(),
        encryptedMaterial: EncryptedMaterial,
        metadata: z.record(z.string(), z.unknown()).optional(),
        tier: SecretTier.optional(),
        refresh: SecretRefreshConfig.optional(),
        expiresAt: z.string().optional(),
        /** Provenance — e.g. { kind: "integration-oauth", integration: "github" }. */
        source: z.record(z.string(), z.unknown()).optional(),
      }),
    },
    "events.iterate.com/secret/rotated": {
      description:
        "The Secret DO replaced its own material, typically after an OAuth refresh. Appended by the DO itself.",
      payloadSchema: z.object({
        slug: z.string(),
        encryptedMaterial: EncryptedMaterial,
        expiresAt: z.string().optional(),
        reason: z.string(),
      }),
    },
    "events.iterate.com/secret/used": {
      description:
        "Audit record: the Secret's material was dereferenced (fetch-with-substitution or a platform-trusted reveal). Carries WHO and WHERE, never the material.",
      payloadSchema: z.object({
        slug: z.string(),
        usedBy: z.string(),
        usage: z.enum(["fetch", "reveal"]),
        urlHost: z.string().optional(),
        at: z.string(),
      }),
    },
    "events.iterate.com/secret/deleted": {
      description: "The Secret was deleted; the fold drops its material.",
      payloadSchema: z.object({ slug: z.string() }),
    },
  },
  consumes: [
    "events.iterate.com/secret/set",
    "events.iterate.com/secret/rotated",
    "events.iterate.com/secret/used",
    "events.iterate.com/secret/deleted",
  ],
  emits: ["events.iterate.com/secret/rotated", "events.iterate.com/secret/used"],
});

export type SecretProcessorState = z.infer<typeof SecretProcessorContract.stateSchema>;
