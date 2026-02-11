import { eq, and, isNull } from "drizzle-orm";
import { typeid } from "typeid-js";
import type { CloudflareEnv } from "../../env.ts";
import type { DB } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { outboxClient } from "../outbox/client.ts";
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
export async function buildMachineEnvVars(params: {
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
 *
 * Inserts the DB row with `state=starting, externalId=""` and enqueues a
 * durable `machine:provision` outbox event in the same transaction.
 * Actual provider resource creation happens in the provision consumer.
 *
 * Returns immediately — no `waitUntil` or background promise needed.
 */
export async function createMachineForProject(params: CreateMachineParams): Promise<{
  machine: typeof schema.machine.$inferSelect;
}> {
  const { db, projectId, organizationId, organizationSlug, projectSlug, name, metadata } = params;

  const machineId = typeid("mach").toString();

  const projectRecord = await db.query.project.findFirst({
    where: eq(schema.project.id, projectId),
  });

  if (!projectRecord) {
    throw new Error(`Project not found: ${projectId}`);
  }
  const type = projectRecord.sandboxProvider;

  // Detach older starting machines, insert new row, and enqueue provision — all in one tx.
  await outboxClient.sendTx(db, "machine:provision", async (tx) => {
    await tx
      .update(schema.machine)
      .set({ state: "detached" })
      .where(and(eq(schema.machine.projectId, projectId), eq(schema.machine.state, "starting")));

    await tx.insert(schema.machine).values({
      id: machineId,
      name,
      type,
      projectId,
      state: "starting",
      metadata: metadata ?? {},
      externalId: "",
    });

    return {
      payload: {
        machineId,
        projectId,
        organizationId,
        organizationSlug,
        projectSlug,
        name,
        metadata: metadata ?? {},
      },
    };
  });

  // Read back the inserted machine (after tx commit).
  const newMachine = await db.query.machine.findFirst({
    where: eq(schema.machine.id, machineId),
  });
  if (!newMachine) throw new Error("Failed to create machine");

  logger.info("Machine record created, provision event enqueued", { machineId, projectId, type });

  return { machine: newMachine };
}
