import { z } from "zod";
import { defineProcessorContract } from "../streams/processor-contracts.ts";

/** Zod mirror of {@link import("../../types.ts").PlatformCredsRef} — a
 * deployment-owned credential resolved from typed AppConfig in trusted code. */
const PlatformCredsRef = z.strictObject({ platform: z.string().trim().min(1) });

/**
 * Zod mirror of {@link import("../../types.ts").SecretRefresh} — the named
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
]);

export const SecretProcessorContract = defineProcessorContract({
  slug: "secret",
  version: "0.3.0",
  description: "Folds one path-addressed secret without exposing material.",
  stateSchema: z.object({
    audit: z
      .object({
        lastUsedAt: z.string().optional(),
        lastUsedBy: z.string().optional(),
        lastUsedUrl: z.string().optional(),
        usedCount: z.number().int().min(0).default(0),
      })
      .default({ usedCount: 0 }),
    egress: z
      .object({
        urls: z.array(z.string()).default([]),
      })
      .default({ urls: [] }),
    encryptedMaterial: z
      .strictObject({
        algorithm: z.literal("AES-GCM-SHA256"),
        ciphertext: z.string().trim().min(1),
        iv: z.string().trim().min(1),
      })
      .nullable()
      .default(null),
    // The refresh strategy this secret runs on a 401 / missing field, if any.
    // Stored as one fact: configure-time declaration is the trust event.
    refresh: SecretRefresh.nullable().default(null),
  }),
  events: {
    "events.iterate.com/secret/updated": {
      description: "Updates secret material, egress URL config, and/or the refresh strategy.",
      payloadSchema: z.object({
        egress: z
          .object({
            urls: z.array(z.string()),
          })
          .optional(),
        encryptedMaterial: z
          .strictObject({
            algorithm: z.literal("AES-GCM-SHA256"),
            ciphertext: z.string().trim().min(1),
            iv: z.string().trim().min(1),
          })
          .optional(),
        // `null` clears a configured strategy; omitted leaves it unchanged.
        refresh: SecretRefresh.nullable().optional(),
      }),
    },
    "events.iterate.com/secret/used": {
      description: "Records that secret material was substituted into an egress request.",
      payloadSchema: z.object({
        usedAt: z.string(),
        usedBy: z.string().optional(),
        url: z.string().optional(),
      }),
    },
  },
  consumes: ["events.iterate.com/secret/updated", "events.iterate.com/secret/used"],
  emits: [],
});
