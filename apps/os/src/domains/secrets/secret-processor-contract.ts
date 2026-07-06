import { z } from "zod";
import { DynamicWorkerRef } from "../workers/schemas.ts";
import { defineProcessorContract } from "../streams/processor-contracts.ts";

export const SecretProcessorContract = defineProcessorContract({
  slug: "secret",
  version: "0.2.0",
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
    // The secret worker that overrides this secret's fetch(), if any. Stored as
    // one fact (design §2.2): install-time declaration is the trust event.
    worker: DynamicWorkerRef.nullable().default(null),
  }),
  events: {
    "events.iterate.com/secret/updated": {
      description: "Updates secret material, egress URL config, and/or the secret worker.",
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
        // `null` clears an installed worker; omitted leaves it unchanged.
        worker: DynamicWorkerRef.nullable().optional(),
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
