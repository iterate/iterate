/**
 * Archil integration — persistent POSIX volumes backed by Cloudflare R2.
 *
 * Every project gets an Archil disk with a per-project R2 prefix.
 * The disk is mounted at /mnt/persist inside the sandbox so user files
 * survive machine reprovisioning.
 *
 * @see https://docs.archil.com/api-reference/introduction
 */
import { Archil, ArchilApiError } from "@archildata/client/api";
import { and, eq, inArray } from "drizzle-orm";
import type { CloudflareEnv } from "../../../env.ts";
import type { DB } from "../../db/client.ts";
import * as schema from "../../db/schema.ts";
import { logger } from "../../tag-logger.ts";

function createArchilClient(env: CloudflareEnv): Archil {
  return new Archil({ apiKey: env.ARCHIL_API_KEY, region: env.ARCHIL_REGION });
}

/**
 * Ensure a project has an Archil disk. Creates one if it doesn't exist yet,
 * and stores the disk config as project env vars so every machine picks it up.
 *
 * Idempotent: if the project already has ARCHIL_DISK_NAME set, returns early.
 */
export async function ensureProjectArchilDisk(
  db: DB,
  env: CloudflareEnv,
  params: { projectId: string; projectSlug: string },
): Promise<void> {
  // Idempotent: check if already provisioned
  const existingDisk = await db.query.projectEnvVar.findFirst({
    where: (e, { eq: whereEq, and: whereAnd }) =>
      whereAnd(whereEq(e.projectId, params.projectId), whereEq(e.key, "ARCHIL_DISK_NAME")),
  });
  if (existingDisk) {
    return;
  }

  const { diskId, mountToken } = await createArchilDisk(env, params);

  // Store as project env vars — these flow to every machine via buildMachineEnvVars.
  // Delete any stale archil env vars first (from previous broken provisioning attempts).
  await db
    .delete(schema.projectEnvVar)
    .where(
      and(
        eq(schema.projectEnvVar.projectId, params.projectId),
        inArray(schema.projectEnvVar.key, [
          "ARCHIL_DISK_NAME",
          "ARCHIL_MOUNT_TOKEN",
          "ARCHIL_REGION",
        ]),
      ),
    );

  const archilVars = [
    { key: "ARCHIL_DISK_NAME", value: diskId },
    { key: "ARCHIL_MOUNT_TOKEN", value: mountToken },
    { key: "ARCHIL_REGION", value: env.ARCHIL_REGION },
  ];
  for (const { key, value } of archilVars) {
    await db.insert(schema.projectEnvVar).values({
      projectId: params.projectId,
      key,
      value,
    });
  }

  logger.info(`[Archil] Disk provisioned for project=${params.projectId} diskId=${diskId}`);
}

/**
 * Create an Archil disk backed by R2.
 *
 * Idempotent: if a disk with the same name already exists, creates a new
 * auth token on the existing disk rather than failing.
 */
async function createArchilDisk(
  env: CloudflareEnv,
  params: { projectId: string; projectSlug: string },
): Promise<{ diskId: string; mountToken: string }> {
  const archil = createArchilClient(env);
  const diskName = `iterate-${params.projectSlug}-${params.projectId.slice(-8)}`;

  // Generate a mount token
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const tokenHex = Array.from(tokenBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const mountToken = `archil-${tokenHex}`;

  const authMethod = {
    type: "token" as const,
    principal: mountToken,
    nickname: `machine-${params.projectSlug}`,
    tokenSuffix: tokenHex.slice(-4),
  };

  try {
    const disk = await archil.disks.create({
      name: diskName,
      mounts: [
        {
          type: "r2",
          bucketName: env.ARCHIL_R2_BUCKET_NAME,
          bucketEndpoint: env.ARCHIL_R2_ENDPOINT,
          accessKeyId: env.ARCHIL_R2_ACCESS_KEY_ID,
          secretAccessKey: env.ARCHIL_R2_SECRET_ACCESS_KEY,
          bucketPrefix: `projects/${params.projectSlug}/`,
        },
      ],
      authMethods: [authMethod],
    });

    return { diskId: disk.id, mountToken };
  } catch (err) {
    // Disk name collision — look up existing disk and add our token to it
    if (err instanceof ArchilApiError && err.status === 409) {
      logger.info(`[Archil] Disk ${diskName} already exists, adding new auth token`);
      return addTokenToExistingDisk(env, diskName, mountToken, authMethod);
    }
    throw err;
  }
}

/**
 * Look up a disk by name and add a new auth token to it.
 * Used when re-provisioning a project whose env vars were deleted
 * but the Archil disk still exists.
 */
async function addTokenToExistingDisk(
  env: CloudflareEnv,
  diskName: string,
  mountToken: string,
  authMethod: {
    type: "token";
    principal: string;
    nickname: string;
    tokenSuffix: string;
  },
): Promise<{ diskId: string; mountToken: string }> {
  const archil = createArchilClient(env);

  const disks = await archil.disks.list();
  const disk = disks.find((d) => d.name === diskName);
  if (!disk) {
    throw new Error(`Archil disk ${diskName} not found despite 409 conflict`);
  }

  try {
    await disk.addUser(authMethod);
  } catch (err) {
    const detail = err instanceof ArchilApiError ? `${err.status} ${err.message}` : String(err);
    logger.warn(`[Archil] Failed to add auth token to disk ${disk.id}: ${detail}`);
    // Fall through — the disk exists, we'll use it. The token might fail at mount time.
  }

  return { diskId: disk.id, mountToken };
}

/**
 * Delete an Archil disk (cleanup when project is deleted).
 */
export async function deleteArchilDisk(env: CloudflareEnv, diskId: string): Promise<void> {
  const archil = createArchilClient(env);

  try {
    const disk = await archil.disks.get(diskId);
    await disk.delete();
    logger.info(`[Archil] Disk deleted diskId=${diskId}`);
  } catch (err) {
    if (err instanceof ArchilApiError) {
      logger.warn(
        `[Archil] Failed to delete disk diskId=${diskId} status=${err.status} ${err.message}`,
      );
      return;
    }
    throw err;
  }
}
