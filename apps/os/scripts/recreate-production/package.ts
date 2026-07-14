import { z } from "zod";
import { StreamRecoveryRestoreInput } from "../../src/domains/streams/recovery.ts";

export const PRODUCTION_RECOVERY_FORMAT = "iterate-production-recovery" as const;
export const PRODUCTION_RECOVERY_VERSION = 1 as const;

const ProjectIdentity = z
  .object({
    id: z.string().trim().min(1),
    slug: z.string().trim().min(1),
    organizationId: z.string().nullable(),
    organizationName: z.string().nullable(),
    organizationSlug: z.string().nullable(),
  })
  .strict();

const IntegrationInventoryEntry = z
  .object({
    connection: z.string().nullable(),
    integration: z.string(),
    path: z.string(),
    source: z.enum(["builtin", "provided"]),
  })
  .strict();

const SecretInventoryEntry = z
  .object({
    path: z.string(),
    hasMaterial: z.boolean(),
    egressUrls: z.array(z.string()),
    refresh: z.string().nullable(),
  })
  .strict();

const ConfigRepo = z
  .object({
    path: z.literal("/repos/config"),
    exportedHead: z.string(),
    github: z
      .object({
        connection: z.string(),
        installationId: z.string(),
        owner: z.string(),
        repo: z.string(),
      })
      .strict(),
  })
  .strict();

export const ProductionRecoveryPackage = z
  .object({
    format: z.literal(PRODUCTION_RECOVERY_FORMAT),
    version: z.literal(PRODUCTION_RECOVERY_VERSION),
    exportedAt: z.string(),
    breakingChange: z.string().optional(),
    source: z
      .object({
        baseUrl: z.string().url(),
        dopplerConfig: z.string().optional(),
      })
      .strict(),
    projects: z
      .array(
        z
          .object({
            identity: ProjectIdentity,
            streams: z.array(StreamRecoveryRestoreInput),
            integrationInventory: z.array(IntegrationInventoryEntry),
            secretInventory: z.array(SecretInventoryEntry),
            configRepo: ConfigRepo,
          })
          .strict(),
      )
      .min(1),
    globalStreams: z.array(StreamRecoveryRestoreInput),
  })
  .strict();

export type ProductionRecoveryPackage = z.infer<typeof ProductionRecoveryPackage>;

export function packageProjectIds(value: ProductionRecoveryPackage): string[] {
  return value.projects.map((project) => project.identity.id).sort();
}

export function expectedRestoreConfirmation(value: ProductionRecoveryPackage): string {
  return `RESTORE:${packageProjectIds(value).join(",")}`;
}
