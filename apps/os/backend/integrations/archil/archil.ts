/**
 * Archil integration — persistent POSIX volumes backed by Cloudflare R2.
 *
 * Every project gets an Archil disk with a per-project R2 prefix.
 * The disk is mounted at /mnt/persist inside the sandbox so user files
 * survive machine reprovisioning.
 *
 * @see https://docs.archil.com/api-reference/introduction
 */
import { and, eq, inArray } from "drizzle-orm";
import type { CloudflareEnv } from "../../../env.ts";
import type { DB } from "../../db/client.ts";
import * as schema from "../../db/schema.ts";
import { logger } from "../../tag-logger.ts";

interface ArchilApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

interface CreateDiskResult {
  diskId: string;
}

/**
 * Ensure a project has an Archil disk. Creates one if it doesn't exist yet,
 * and stores the disk config as project env vars so every machine picks it up.
 *
 * Idempotent: if the project already has ARCHIL_DISK_NAME set, returns early.
 * Non-fatal: if Archil is not configured (missing env vars) or creation fails,
 * logs a warning and returns false — the machine works fine without persistence.
 */
export async function ensureProjectArchilDisk(
  db: DB,
  env: CloudflareEnv,
  params: { projectId: string; projectSlug: string },
): Promise<boolean> {
  // Skip if Archil is not configured
  if (!env.ARCHIL_API_KEY || !env.ARCHIL_R2_BUCKET_NAME) {
    return false;
  }

  // Idempotent: check if already provisioned
  const existingDisk = await db.query.projectEnvVar.findFirst({
    where: (e, { eq: whereEq, and: whereAnd }) =>
      whereAnd(whereEq(e.projectId, params.projectId), whereEq(e.key, "ARCHIL_DISK_NAME")),
  });
  if (existingDisk) {
    return true;
  }

  try {
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
    return true;
  } catch (err) {
    logger.error("[Archil] Disk creation failed, machine will run without persistence", err);
    return false;
  }
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
  const diskName = `iterate-${params.projectSlug}-${params.projectId.slice(-8)}`;
  const baseUrl = `https://control.green.${env.ARCHIL_REGION}.aws.prod.archil.com`;

  // Generate a mount token
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const tokenHex = Array.from(tokenBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const mountToken = `archil-${tokenHex}`;
  const tokenSuffix = tokenHex.slice(-4);

  const authMethod = {
    type: "token" as const,
    principal: mountToken,
    nickname: `machine-${params.projectSlug}`,
    tokenSuffix,
  };

  const resp = await fetch(`${baseUrl}/api/disks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: env.ARCHIL_API_KEY,
    },
    body: JSON.stringify({
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
    }),
  });

  if (resp.ok) {
    const result = (await resp.json()) as ArchilApiResponse<CreateDiskResult>;
    if (!result.success || !result.data) {
      throw new Error(`Archil disk creation failed: ${result.error ?? "unknown error"}`);
    }
    return { diskId: result.data.diskId, mountToken };
  }

  // Disk name collision — look up existing disk and add our token to it
  const text = await resp.text();
  if (resp.status === 409 || text.includes("already exists")) {
    logger.info(`[Archil] Disk ${diskName} already exists, adding new auth token`);
    return addTokenToExistingDisk(env, diskName, mountToken, authMethod);
  }

  throw new Error(`Archil disk creation failed: HTTP ${resp.status} — ${text}`);
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
  const baseUrl = `https://control.green.${env.ARCHIL_REGION}.aws.prod.archil.com`;

  // List disks and find the one with our name
  const listResp = await fetch(`${baseUrl}/api/disks`, {
    headers: { Authorization: env.ARCHIL_API_KEY },
  });
  if (!listResp.ok) {
    throw new Error(`Archil list disks failed: HTTP ${listResp.status}`);
  }

  const listResult = (await listResp.json()) as ArchilApiResponse<
    Array<{ diskId: string; name: string }>
  >;
  const disk = listResult.data?.find((d) => d.name === diskName);
  if (!disk) {
    throw new Error(`Archil disk ${diskName} not found despite 409 conflict`);
  }

  // Add new auth token to the existing disk
  const addResp = await fetch(`${baseUrl}/api/disks/${disk.diskId}/auth-methods`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: env.ARCHIL_API_KEY,
    },
    body: JSON.stringify(authMethod),
  });

  if (!addResp.ok) {
    const addText = await addResp.text();
    logger.warn(
      `[Archil] Failed to add auth token to disk ${disk.diskId}: ${addResp.status} ${addText}`,
    );
    // Fall through — the disk exists, we'll use it. The token might fail at mount time.
  }

  return { diskId: disk.diskId, mountToken };
}

/**
 * Create an Archil disk backed by R2.
 * Each project gets its own prefix in a shared R2 bucket.
 */
export async function deleteArchilDisk(env: CloudflareEnv, diskId: string): Promise<void> {
  const baseUrl = `https://control.green.${env.ARCHIL_REGION}.aws.prod.archil.com`;

  const resp = await fetch(`${baseUrl}/api/disks/${diskId}`, {
    method: "DELETE",
    headers: { Authorization: env.ARCHIL_API_KEY },
  });

  if (!resp.ok) {
    const text = await resp.text();
    logger.warn(
      `[Archil] Failed to delete disk diskId=${diskId} status=${resp.status} body=${text}`,
    );
    return;
  }

  logger.info(`[Archil] Disk deleted diskId=${diskId}`);
}
