// The secret processor CONTRACT. Self-contained: state schema, events,
// consumes/emits — and it OWNS every nested data structure (birth certificate,
// egress pin, encrypted material, refresh strategy); consumers reach into this
// module for pieces, never the other way around. Schemas are spelled INLINE in
// the contract; the ones it needs more than once (the birth certificate, the
// egress pin, the encrypted-material blob, the refresh strategy) are hoisted
// functions defined below the contract, so the contract still opens the file.
//
// The DO in secret-durable-object.ts is the write side: it encrypts material
// (crypto.ts) before anything reaches the stream, so no event here ever
// carries plaintext — the whole vocabulary is policy, ciphertext, and audit.

import { z } from "zod";
import { defineProcessorContract } from "iterate/processors";

export const SecretProcessorContract = defineProcessorContract({
  slug: "secret",
  version: "0.7.0",
  description:
    "Reduces one path-addressed secret — birth policy, encrypted material, egress pin, " +
    "refresh strategy, usage audit — without ever exposing material.",
  stateSchema: z.object({
    birthCertificate: secretBirthCertificateSchema()
      .nullable()
      .default(null)
      .meta({
        description:
          "Existence marker: null until secret/created reduces. Stores the created payload " +
          "verbatim — the immutable birth policy, most importantly `visibility`, which later " +
          "events can never change.",
      }),
    audit: z
      .object({
        lastUsedAt: z
          .string()
          .optional()
          .meta({ description: "ISO timestamp of the newest secret/used fact." }),
        lastUsedBy: z
          .string()
          .optional()
          .meta({ description: "Who last substituted the material (usually the project id)." }),
        lastUsedUrl: z
          .string()
          .optional()
          .meta({ description: "The egress URL the material was last substituted into." }),
        usedCount: z
          .number()
          .int()
          .min(0)
          .default(0)
          .meta({ description: "How many secret/used facts have reduced in total." }),
      })
      .default({ usedCount: 0 })
      .meta({
        description:
          "Usage audit trail — the only always-visible evidence a write-only secret leaves. " +
          "The optional last* fields mirror the NEWEST used fact exactly: a used event " +
          "without usedBy/url clears them rather than showing a stale attribution.",
      }),
    egress: egressSchema().default({ urls: [] }).meta({
      description:
        "The egress pin currently in force: birth policy until a secret/updated replaces it.",
    }),
    encryptedMaterial: encryptedMaterialSchema()
      .extend({
        offset: z
          .number()
          .int()
          .positive()
          .meta({
            description:
              "The stream offset the material committed at — reducer-owned, deliberately not " +
              "caller input. AES-GCM authenticates this position, so a blob replayed at " +
              "another offset cannot decrypt.",
          }),
      })
      .nullable()
      .default(null)
      .meta({
        description:
          "The stored ciphertext (never plaintext — the DO encrypts before appending), or " +
          "null when no material is retained. Even this leaves the DO only as a hasMaterial " +
          "boolean.",
      }),
    updatedOffset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .meta({
        description:
          "Offset of the newest secret/created or secret/updated fact — the secret's material/" +
          "policy revision. The DO fences refreshes and conditional clears on it, so a stale " +
          "strategy or a late provider rejection cannot act on a rotated credential — even " +
          "against an attacker replaying an otherwise identical configuration.",
      }),
    refresh: secretRefreshSchema()
      .nullable()
      .default(null)
      .meta({
        description:
          "The refresh strategy this secret runs on a 401 / missing field, if any. Stored as " +
          "one fact: the configure-time declaration is the trust event.",
      }),
  }),
  events: {
    "events.iterate.com/secret/created": {
      description:
        "Creates a secret processor on this stream. The payload is the immutable birth " +
        "certificate; the DO copies this event to the project root stream, where the " +
        "project processor catalogs the secret.",
      payloadSchema: secretBirthCertificateSchema(),
    },
    "events.iterate.com/secret/updated": {
      description:
        "Updates secret material, egress URL config, and/or the refresh strategy. An update " +
        "is a complete material decision: omitting encryptedMaterial DESTROYS the retained " +
        "value (egress-only and refresh-only updates clear material on purpose).",
      payloadSchema: z.object({
        egress: egressSchema()
          .optional()
          .meta({ description: "Replacement egress pin; omitted leaves the pin unchanged." }),
        encryptedMaterial: encryptedMaterialSchema()
          .optional()
          .meta({
            description:
              "Replacement ciphertext, encrypted by the DO for this exact commit position. " +
              "OMITTED means no material: every material-less update clears what was stored.",
          }),
        refresh: secretRefreshSchema()
          .nullable()
          .optional()
          .meta({
            description:
              "Replacement refresh strategy; `null` clears a configured strategy, omitted " +
              "leaves it unchanged.",
          }),
      }),
    },
    "events.iterate.com/secret/used": {
      description:
        "Records that secret material was substituted into an egress request — the audit " +
        "fact behind the description's usage counters.",
      payloadSchema: z.object({
        usedAt: z
          .string()
          .meta({ description: "ISO timestamp of the substitution, stamped by the DO." }),
        usedBy: z
          .string()
          .optional()
          .meta({ description: "Who substituted the material (usually the project id)." }),
        url: z
          .string()
          .optional()
          .meta({ description: "The pinned egress URL the request targeted." }),
      }),
    },
  },
  consumes: [
    "events.iterate.com/secret/created",
    "events.iterate.com/secret/updated",
    "events.iterate.com/secret/used",
  ],
  // The catalog copy: secret/created is re-appended onto the project
  // root stream so the project processor can list this secret.
  emits: ["events.iterate.com/secret/created"],
});

/**
 * The contract's type under the same identifier, so type-level helpers read
 * without `typeof`: `ProcessorState<SecretProcessorContract>`,
 * `ConsumedEvent<SecretProcessorContract>`.
 */
export type SecretProcessorContract = typeof SecretProcessorContract;

/**
 * The immutable birth certificate — used twice (the secret/created payload and
 * the reduced state's birthCertificate slot). Zod mirror of the trusted-code
 * input types in {@link import("./types.ts").SecretCreateInput}.
 */
function secretBirthCertificateSchema() {
  return z.strictObject({
    config: z
      .strictObject({
        egress: egressSchema().meta({
          description: "The egress pin the secret is born with.",
        }),
        encryptedMaterial: encryptedMaterialSchema().optional().meta({
          description: "Optional initial material, already encrypted by the DO.",
        }),
        refresh: secretRefreshSchema().nullable().meta({
          description: "The refresh strategy the secret is born with, or null for none.",
        }),
        visibility: z
          .enum(["write-only", "readable"])
          .default("write-only")
          .meta({
            description:
              'How the material may leave: "write-only" (never — the classic secret ' +
              'invariant) or "readable" (reveal() answers it, as often as asked). IMMUTABLE — ' +
              "a birth-certificate fact only, never updatable, so a write-only secret can " +
              "never be retro-flipped readable to exfiltrate it. An enum so future kinds " +
              "(e.g. reveal-once) extend it without a schema migration; defaulted so every " +
              "pre-existing stream reduces as write-only.",
          }),
      })
      .meta({ description: "The complete birth policy." }),
  });
}

/** The egress allowlist: material only ever moves toward these origins. */
function egressSchema() {
  return z.object({
    urls: z.array(z.string()).meta({
      description:
        "http(s) URLs whose ORIGINS the secret may reach: substituted requests, refresh " +
        "token exchanges, and credential redirects are all refused outside this pin.",
    }),
  });
}

/**
 * The encrypted-at-rest blob produced by crypto.ts. AES-GCM additionally
 * authenticates the secret's identity and policy (projectId, path, egress
 * origins, commit offset), so ciphertext copied from another secret — or the
 * same secret at another position — cannot decrypt.
 */
function encryptedMaterialSchema() {
  return z.strictObject({
    algorithm: z.literal("AES-GCM-SHA256+SECRET-CELL-V1").meta({
      description: "The one supported scheme; a crypto change would mint a new literal.",
    }),
    ciphertext: z
      .string()
      .trim()
      .min(1)
      .meta({ description: "Base64 AES-GCM ciphertext of the JSON-encoded material." }),
    iv: z.string().trim().min(1).meta({ description: "Base64 96-bit initialization vector." }),
  });
}

/**
 * A named refresh strategy the secret runs in its own trusted DO code (one
 * shared implementation per protocol, not a worker copied into every secret).
 * Zod mirror of {@link import("./types.ts").SecretRefresh}; exchange endpoints
 * must fall within the secret's own egress pin.
 */
function secretRefreshSchema() {
  return z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("oauth-refresh-token"),
      tokenEndpoint: z
        .string()
        .trim()
        .min(1)
        .meta({
          description:
            "RFC 6749 refresh_token grant target (the provider's /token URL); its origin " +
            "must fall within the secret's egress pin.",
        }),
      clientCreds: z.union([platformCredsRefSchema(), z.literal("material")]).meta({
        description:
          'Where the client credential comes from: "material" reads clientId/clientSecret ' +
          "from this secret's own material (bring-your-own-app); a platform ref names a " +
          "deployment-owned credential.",
      }),
    }),
    z.strictObject({
      kind: z.literal("github-app-installation"),
      apiBase: z.string().trim().min(1).meta({
        description: "GitHub API origin (or a stand-in in e2e); must fall within the egress pin.",
      }),
      appId: z.string().trim().min(1).meta({ description: "The App id — the JWT issuer." }),
      installationId: z.string().trim().min(1).meta({
        description: "The installation this connection acts as (public — an external id).",
      }),
      privateKey: z.union([platformCredsRefSchema(), z.literal("material")]).meta({
        description:
          'Where the App\'s RS256 private key comes from: "material" reads the privateKey ' +
          "field of this secret's own material (bring-your-own-App); a platform ref names " +
          "the first-party App key.",
      }),
    }),
    z.strictObject({
      kind: z.literal("waitrose-session"),
      graphqlUrl: z
        .string()
        .trim()
        .min(1)
        .meta({
          description:
            "The Waitrose GraphQL endpoint the NewSession login mutation is POSTed to " +
            "(re-login IS the refresh — Waitrose has no token grant); must fall within the " +
            "egress pin.",
        }),
    }),
  ]);
}

/**
 * A reference to a deployment-owned platform credential, resolved from typed
 * AppConfig in trusted code (platform-secrets.ts) — never stored in project
 * material, never readable.
 */
function platformCredsRefSchema() {
  return z.strictObject({
    platform: z
      .string()
      .trim()
      .min(1)
      .meta({ description: 'The AppConfig path of the credential, e.g. "integrations.github".' }),
  });
}
