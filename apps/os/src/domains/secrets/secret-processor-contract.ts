import { z } from "zod";
import { defineProcessorContract } from "iterate/processors";

/** Zod mirror of {@link import("./types.ts").PlatformCredsRef} — a
 * deployment-owned credential resolved from typed AppConfig in trusted code. */
const PlatformCredsRef = z.strictObject({ platform: z.string().trim().min(1) });

/**
 * Zod mirror of {@link import("./types.ts").SecretRefresh} — the named
 * refresh strategy a secret runs in its own trusted DO code (one shared
 * implementation per protocol, not a worker copied into every secret).
 */
const SecretRefresh = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("oauth-refresh-token"),
    tokenEndpoint: z.string().trim().min(1),
    clientCreds: z.union([PlatformCredsRef, z.literal("material")]),
  }),
  z.strictObject({
    kind: z.literal("github-app-installation"),
    apiBase: z.string().trim().min(1),
    appId: z.string().trim().min(1),
    installationId: z.string().trim().min(1),
    privateKey: z.union([PlatformCredsRef, z.literal("material")]),
  }),
  z.strictObject({
    kind: z.literal("waitrose-session"),
    graphqlUrl: z.string().trim().min(1),
  }),
]);

/** The policy- and position-bound encrypted-at-rest blob produced by crypto.ts. */
const EncryptedMaterial = z.strictObject({
  algorithm: z.literal("AES-GCM-SHA256+SECRET-CELL-V1"),
  ciphertext: z.string().trim().min(1),
  iv: z.string().trim().min(1),
});

/** The reducer adds the committed offset; it is deliberately not caller input. */
const StoredEncryptedMaterial = EncryptedMaterial.extend({
  offset: z.number().int().positive(),
});

/** The egress allowlist: substituted requests may only target these origins. */
const Egress = z.object({ urls: z.array(z.string()) });

const SecretBirthCertificate = z.strictObject({
  config: z.strictObject({
    egress: Egress,
    encryptedMaterial: EncryptedMaterial.optional(),
    refresh: SecretRefresh.nullable(),
  }),
});
export const SecretProcessorContract = defineProcessorContract({
  slug: "secret",
  version: "0.5.0",
  description: "Folds one path-addressed secret without exposing material.",
  stateSchema: z.object({
    birthCertificate: SecretBirthCertificate.nullable().default(null),
    audit: z
      .object({
        lastUsedAt: z.string().optional(),
        lastUsedBy: z.string().optional(),
        lastUsedUrl: z.string().optional(),
        usedCount: z.number().int().min(0).default(0),
      })
      .default({ usedCount: 0 }),
    egress: Egress.default({ urls: [] }),
    encryptedMaterial: StoredEncryptedMaterial.nullable().default(null),
    // Last secret/updated fact, including a material-clearing public update.
    // Refresh uses this reducer-owned position to reject stale strategies even
    // when an attacker repeats an otherwise identical refresh configuration.
    updatedOffset: z.number().int().min(0).default(0),
    // The refresh strategy this secret runs on a 401 / missing field, if any.
    // Stored as one fact: configure-time declaration is the trust event.
    refresh: SecretRefresh.nullable().default(null),
  }),
  events: {
    "events.iterate.com/secret/created": {
      description: "Creates a secret processor on this stream.",
      payloadSchema: SecretBirthCertificate,
      examples: [
        {
          description: "A secret is born with an egress policy and no refresh strategy.",
          payload: {
            config: {
              egress: { urls: ["https://api.example.com"] },
              refresh: null,
            },
          },
        },
      ],
    },
    "events.iterate.com/secret/updated": {
      description: "Updates secret material, egress URL config, and/or the refresh strategy.",
      payloadSchema: z.object({
        egress: Egress.optional(),
        encryptedMaterial: EncryptedMaterial.optional(),
        // `null` clears a configured strategy; omitted leaves it unchanged.
        refresh: SecretRefresh.nullable().optional(),
      }),
      examples: [
        {
          description:
            "A Slack bot token is stored: encrypted-at-rest material plus the egress origins it may be substituted into.",
          payload: {
            encryptedMaterial: {
              algorithm: "AES-GCM-SHA256+SECRET-CELL-V1",
              ciphertext: "nJ2xkV8mPqvGdL5tYw3eBg==",
              iv: "9EMTZWEeC2Iy5W5m",
            },
            egress: { urls: ["https://slack.com", "https://files.slack.com"] },
          },
        },
        {
          description:
            "A GitHub connection secret gets the github-app-installation refresh strategy: the DO mints installation tokens on demand, signing with the platform-owned App key.",
          payload: {
            refresh: {
              kind: "github-app-installation",
              apiBase: "https://api.github.com",
              appId: "312345",
              installationId: "45678901",
              privateKey: { platform: "integrations.github" },
            },
          },
        },
      ],
    },
    "events.iterate.com/secret/used": {
      description: "Records that secret material was substituted into an egress request.",
      payloadSchema: z.object({
        usedAt: z.string(),
        usedBy: z.string().optional(),
        url: z.string().optional(),
      }),
      examples: [
        {
          description:
            "The secret's material was substituted into a Slack Web API call at the egress door.",
          payload: {
            usedAt: "2026-07-08T14:31:09.412Z",
            usedBy: "prj_b9f2c81d4e6a4f0a9c3d7e5b1a8f2c4d",
            url: "https://slack.com/api/chat.postMessage",
          },
        },
      ],
    },
  },
  consumes: [
    "events.iterate.com/secret/created",
    "events.iterate.com/secret/updated",
    "events.iterate.com/secret/used",
  ],
  emits: ["events.iterate.com/secret/created"],
});

/**
 * The contract's type under the same identifier, so type-level helpers read
 * without `typeof`: `ProcessorState<SecretProcessorContract>`,
 * `ConsumedEvent<SecretProcessorContract>`.
 */
export type SecretProcessorContract = typeof SecretProcessorContract;
