import { eq, and, isNull } from "drizzle-orm";
import { typeid } from "typeid-js";
import { buildCanonicalMachineExternalId } from "@iterate-com/sandbox/providers/naming";
import type { CloudflareEnv } from "../../env.ts";
import type { DB } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { outboxClient } from "../outbox/client.ts";
import { decrypt, encrypt } from "../utils/encryption.ts";
import { stripMachineStateMetadata } from "../utils/machine-metadata.ts";
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
 * Inserts the DB record and emits `machine:created` in the same transaction.
 * Provisioning is handled by the `provisionMachine` outbox consumer.
 */
export async function createMachineForProject(params: CreateMachineParams): Promise<{
  machine: typeof schema.machine.$inferSelect;
  apiKey?: string;
}> {
  const { db, env, projectId, name, metadata } = params;

  const machineId = typeid("mach").toString();

  const projectRecord = await db.query.project.findFirst({
    where: eq(schema.project.id, projectId),
  });

  if (!projectRecord) {
    throw new Error(`Project not found: ${projectId}`);
  }
  const type = projectRecord.sandboxProvider;
  const initialMachineMetadata = stripMachineStateMetadata(metadata ?? {});

  const machineExternalId = buildCanonicalMachineExternalId({
    prefix: env.SANDBOX_NAME_PREFIX,
    projectSlug: projectRecord.slug,
    machineId,
  });

  // Get or create the project-level access token
  const { apiKey } = await getOrCreateProjectMachineToken(db, projectId);

  // Detach older starting machines, insert new one, and emit machine:created — all in one tx.
  const { newMachine } = await outboxClient.sendTx(db, "machine:created", async (tx) => {
    await tx
      .update(schema.machine)
      .set({ state: "detached" })
      .where(and(eq(schema.machine.projectId, projectId), eq(schema.machine.state, "starting")));

    const [inserted] = await tx
      .insert(schema.machine)
      .values({
        id: machineId,
        name,
        type,
        projectId,
        state: "starting",
        metadata: initialMachineMetadata,
        externalId: machineExternalId,
      })
      .returning();

    if (!inserted) throw new Error("Failed to create machine");
    return { payload: { machineId }, newMachine: inserted };
  });

  logger.set({ machine: { id: machineId }, project: { id: projectId } });
  logger.info(`Machine record created type=${type}`);

  return { machine: newMachine, apiKey };
}
