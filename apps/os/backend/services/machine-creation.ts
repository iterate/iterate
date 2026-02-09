import { eq, and, isNull } from "drizzle-orm";
import { typeid } from "typeid-js";
import { createMachineRuntime } from "@iterate-com/sandbox/providers/machine-runtime";
import type { CloudflareEnv } from "../../env.ts";
import type { DB } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { decrypt, encrypt } from "../utils/encryption.ts";
import { logger } from "../tag-logger.ts";

/**
 * Generate a project access token API key.
 * Format: pak_<tokenId>_<randomHex>
 */
export function generateProjectAccessKey(tokenId: string): string {
  const array = new Uint8Array(24);
  crypto.getRandomValues(array);
  const randomHex = Array.from(array)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `pak_${tokenId}_${randomHex}`;
}

/**
 * Get or create the project-level access token for machines.
 * Returns the token ID and decrypted API key.
 */
export async function getOrCreateProjectMachineToken(
  db: DB,
  projectId: string,
): Promise<{ tokenId: string; apiKey: string }> {
  // Look for an existing non-revoked token for the project
  const existingToken = await db.query.projectAccessToken.findFirst({
    where: and(
      eq(schema.projectAccessToken.projectId, projectId),
      isNull(schema.projectAccessToken.revokedAt),
    ),
    orderBy: (token, { asc }) => [asc(token.createdAt)],
  });

  if (existingToken) {
    const apiKey = await decrypt(existingToken.encryptedToken);
    return { tokenId: existingToken.id, apiKey };
  }

  // No existing token - create a new one
  const tokenId = typeid("pat").toString();
  const apiKey = generateProjectAccessKey(tokenId);
  const encryptedToken = await encrypt(apiKey);

  await db.insert(schema.projectAccessToken).values({
    id: tokenId,
    projectId,
    name: "Machine Access Token",
    encryptedToken,
  });

  return { tokenId, apiKey };
}

export type CreateMachineParams = {
  db: DB;
  env: CloudflareEnv;
  projectId: string;
  organizationId: string;
  organizationSlug: string;
  projectSlug: string;
  name: string;
  metadata?: Record<string, unknown>;
};

/**
 * Build the full env var map for a new machine.
 */
async function buildMachineEnvVars(params: {
  db: DB;
  env: CloudflareEnv;
  projectId: string;
  organizationId: string;
  organizationSlug: string;
  projectSlug: string;
  machineId: string;
  name: string;
  apiKey: string;
}): Promise<Record<string, string>> {
  const {
    db,
    env,
    projectId,
    organizationId,
    organizationSlug,
    projectSlug,
    machineId,
    name,
    apiKey,
  } = params;

  const globalEnvVars = await db.query.projectEnvVar.findMany({
    where: and(
      eq(schema.projectEnvVar.projectId, projectId),
      isNull(schema.projectEnvVar.machineId),
    ),
  });

  const envVars = Object.fromEntries(globalEnvVars.map((envVar) => [envVar.key, envVar.value]));

  return {
    ...envVars,
    ITERATE_OS_BASE_URL: env.VITE_PUBLIC_URL,
    ITERATE_OS_API_KEY: apiKey,
    ITERATE_MACHINE_ID: machineId,
    ITERATE_MACHINE_NAME: name,
    ITERATE_ORG_ID: organizationId,
    ITERATE_ORG_SLUG: organizationSlug,
    ITERATE_PROJECT_ID: projectId,
    ITERATE_PROJECT_SLUG: projectSlug,
    ITERATE_EGRESS_PROXY_URL: `${env.VITE_PUBLIC_URL}/api/egress-proxy`,
    ...(env.DANGEROUS_RAW_SECRETS_ENABLED === "true" ? { ITERATE_SKIP_PROXY: "true" } : {}),
    GH_TOKEN: `getIterateSecret({secretKey: "github.access_token"})`,
    GITHUB_TOKEN: `getIterateSecret({secretKey: "github.access_token"})`,
  };
}

/**
 * Create a machine for a project.
 * This is the core machine creation logic shared between tRPC and webhooks.
 *
 * For "local" machines, creation is instant and fully synchronous.
 * For provider-backed machines (docker, daytona, fly), the DB record is created
 * immediately and a `provisionPromise` is returned for background provisioning.
 * Callers should pass this to `waitUntil()` or `await` it directly.
 */
export async function createMachineForProject(params: CreateMachineParams): Promise<{
  machine: typeof schema.machine.$inferSelect;
  apiKey?: string;
  provisionPromise?: Promise<void>;
}> {
  const { db, env, projectId, organizationId, organizationSlug, projectSlug, name, metadata } =
    params;

  const machineId = typeid("mach").toString();

  const projectRecord = await db.query.project.findFirst({
    where: eq(schema.project.id, projectId),
  });

  if (!projectRecord) {
    throw new Error(`Project not found: ${projectId}`);
  }
  const type = projectRecord.sandboxProvider;

  // Get or create the project-level access token
  const { apiKey } = await getOrCreateProjectMachineToken(db, projectId);

  const fullEnvVars = await buildMachineEnvVars({
    db,
    env,
    projectId,
    organizationId,
    organizationSlug,
    projectSlug,
    machineId,
    name,
    apiKey,
  });

  // Local machines are instant — create synchronously
  if (type === "local") {
    const runtime = await createMachineRuntime({
      type,
      env,
      externalId: "",
      metadata: metadata ?? {},
    });
    const runtimeResult = await runtime.create({ machineId, name, envVars: fullEnvVars });
    const machineMetadata = { ...(metadata ?? {}), ...(runtimeResult.metadata ?? {}) };

    const [newMachine] = await db
      .insert(schema.machine)
      .values({
        id: machineId,
        name,
        type,
        projectId,
        state: "starting",
        metadata: machineMetadata,
        externalId: runtimeResult.externalId,
      })
      .returning();

    if (!newMachine) throw new Error("Failed to create machine");
    logger.info("Machine created", { machineId, projectId, type });
    return { machine: newMachine, apiKey };
  }

  // Provider-backed machines: create DB record first, provision in background
  const [newMachine] = await db
    .insert(schema.machine)
    .values({
      id: machineId,
      name,
      type,
      projectId,
      state: "starting",
      metadata: metadata ?? {},
      externalId: "",
    })
    .returning();

  if (!newMachine) throw new Error("Failed to create machine");
  logger.info("Machine record created, starting provisioning", { machineId, projectId, type });

  const provisionPromise = (async () => {
    try {
      const runtime = await createMachineRuntime({
        type,
        env,
        externalId: "",
        metadata: metadata ?? {},
      });
      const runtimeResult = await runtime.create({ machineId, name, envVars: fullEnvVars });

      // Read current metadata — the daemon status handler may have set daemonStatus/daemonReadyAt
      // while provisioning was in progress. Merge to preserve those fields.
      const currentMachine = await db.query.machine.findFirst({
        where: eq(schema.machine.id, machineId),
      });
      const currentMetadata = (currentMachine?.metadata as Record<string, unknown>) ?? {};
      const machineMetadata = { ...currentMetadata, ...(runtimeResult.metadata ?? {}) };

      // If daemon already reported ready while we were provisioning, activate now
      // (the daemon handler defers activation when externalId is empty).
      const daemonReady = currentMetadata.daemonStatus === "ready";
      if (daemonReady) {
        // Activate with machine handoff (detach old active machines) in a transaction
        await db.transaction(async (tx) => {
          const activeMachines = await tx.query.machine.findMany({
            where: and(eq(schema.machine.projectId, projectId), eq(schema.machine.state, "active")),
          });

          for (const activeMachine of activeMachines) {
            await tx
              .update(schema.machine)
              .set({ state: "detached" })
              .where(eq(schema.machine.id, activeMachine.id));
            logger.info("Detached existing active machine during provisioning", {
              machineId: activeMachine.id,
            });
          }

          await tx
            .update(schema.machine)
            .set({
              externalId: runtimeResult.externalId,
              metadata: machineMetadata,
              state: "active",
            })
            .where(eq(schema.machine.id, machineId));
        });
      } else {
        // Daemon hasn't reported yet — just set externalId and metadata.
        // The daemon handler will activate when it reports ready.
        await db
          .update(schema.machine)
          .set({ externalId: runtimeResult.externalId, metadata: machineMetadata })
          .where(eq(schema.machine.id, machineId));
      }

      logger.info("Machine provisioned", { machineId, projectId, type });
    } catch (err) {
      logger.error("Machine provisioning failed", { machineId, projectId, type, err });
      // Store provisioning error in metadata so the UI can show it
      await db
        .update(schema.machine)
        .set({
          metadata: {
            ...(metadata ?? {}),
            provisioningError: err instanceof Error ? err.message : String(err),
          },
        })
        .where(eq(schema.machine.id, machineId))
        .catch(() => {});
    }
  })();

  return { machine: newMachine, provisionPromise };
}
