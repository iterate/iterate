import { eq, and, isNull } from "drizzle-orm";
import { typeid } from "typeid-js";
import type { CloudflareEnv } from "../../env.ts";
import type { DB } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { createMachineProvider } from "../providers/index.ts";
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
  type: (typeof schema.MachineType)[number];
  metadata?: Record<string, unknown>;
};

/**
 * Create a machine for a project.
 * This is the core machine creation logic shared between tRPC and webhooks.
 * Returns the created machine and optionally the API key (for local machines).
 */
export async function createMachineForProject(params: CreateMachineParams): Promise<{
  machine: typeof schema.machine.$inferSelect;
  apiKey?: string;
}> {
  const {
    db,
    env,
    projectId,
    organizationId,
    organizationSlug,
    projectSlug,
    name,
    type,
    metadata,
  } = params;

  const machineId = typeid("mach").toString();

  // Get or create the project-level access token
  const { apiKey } = await getOrCreateProjectMachineToken(db, projectId);

  // Create provider for creation
  const provider = await createMachineProvider({
    type,
    env,
    externalId: "",
    metadata: metadata ?? {},
    buildProxyUrl: () => "",
  });

  // Get project-level env vars (plain text, not secrets)
  const globalEnvVars = await db.query.projectEnvVar.findMany({
    where: and(
      eq(schema.projectEnvVar.projectId, projectId),
      isNull(schema.projectEnvVar.machineId),
    ),
  });

  const envVars = Object.fromEntries(globalEnvVars.map((envVar) => [envVar.key, envVar.value]));

  // Create the machine via the provider
  const providerResult = await provider.create({
    machineId,
    name,
    envVars: {
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
      // When raw secrets mode is enabled, tell pidnap to skip proxy/CA env vars
      ...(env.DANGEROUS_RAW_SECRETS_ENABLED === "true" ? { ITERATE_SKIP_PROXY: "true" } : {}),
      GH_TOKEN: `getIterateSecret({secretKey: "github.access_token"})`,
      GITHUB_TOKEN: `getIterateSecret({secretKey: "github.access_token"})`,
    },
  });

  // Detach older "starting" machines and insert the new one atomically.
  // This prevents concurrent readiness probes and avoids orphaning a project
  // if the insert were to fail after a non-transactional detach.
  const [newMachine] = await db
    .transaction(async (tx) => {
      await tx
        .update(schema.machine)
        .set({ state: "detached" })
        .where(and(eq(schema.machine.projectId, projectId), eq(schema.machine.state, "starting")));

      return tx
        .insert(schema.machine)
        .values({
          id: machineId,
          name,
          type,
          projectId,
          state: "starting",
          metadata: { ...(metadata ?? {}), ...(providerResult.metadata ?? {}) },
          externalId: providerResult.externalId,
        })
        .returning();
    })
    .catch(async (err) => {
      // Cleanup: delete the provider resource if DB transaction fails
      try {
        const cleanupProvider = await createMachineProvider({
          type,
          env,
          externalId: providerResult.externalId,
          metadata: providerResult.metadata ?? {},
          buildProxyUrl: () => "",
        });
        await cleanupProvider.delete();
      } catch {
        // Ignore cleanup errors
      }
      throw err;
    });

  if (!newMachine) {
    throw new Error("Failed to create machine");
  }

  logger.info("Machine created", { machineId, projectId, type });

  return {
    machine: newMachine,
    apiKey: type === "local" ? apiKey : undefined,
  };
}
