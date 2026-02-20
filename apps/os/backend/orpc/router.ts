import { implement, ORPCError } from "@orpc/server";
import type { RequestHeadersPluginContext } from "@orpc/server/plugins";
import { eq } from "drizzle-orm";

import { workerContract } from "../../../daemon/server/orpc/contract.ts";
import type { DB } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { logger } from "../tag-logger.ts";
import { parseTokenIdFromApiKey } from "../egress-proxy/api-key-utils.ts";
import { broadcastInvalidation } from "../utils/query-invalidation.ts";
import type { CloudflareEnv } from "../../env.ts";
import { outboxClient } from "../outbox/client.ts";

/** Initial context provided by the handler */
export type ORPCContext = RequestHeadersPluginContext & {
  db: DB;
  env: CloudflareEnv;
  executionCtx: ExecutionContext;
};

const os = implement(workerContract).$context<ORPCContext>();

/** Middleware that extracts and validates API key from Authorization header */
const withApiKey = os.middleware(async ({ context, next }) => {
  const authHeader = context.reqHeaders?.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new ORPCError("UNAUTHORIZED", { message: "Missing or invalid Authorization header" });
  }

  const apiKey = authHeader.slice(7); // Remove "Bearer " prefix
  return next({ context: { apiKey } });
});

/**
 * Authenticate an API key and return the associated machine.
 * API key format: pak_<tokenId>_<randomHex>
 *
 * The token is project-scoped (shared by all machines in the project).
 * Machine ID is provided separately to identify which machine is calling.
 */
async function authenticateApiKey(
  db: DB,
  apiKey: string,
  machineId: string,
): Promise<{
  machine: typeof schema.machine.$inferSelect & {
    project: typeof schema.project.$inferSelect;
  };
  tokenId: string;
}> {
  const tokenId = parseTokenIdFromApiKey(apiKey);
  if (!tokenId) {
    logger.warn("Invalid API key format", { apiKey: apiKey.slice(0, 20) + "..." });
    throw new ORPCError("UNAUTHORIZED", { message: "Invalid API key format" });
  }

  const accessToken = await db.query.projectAccessToken.findFirst({
    where: eq(schema.projectAccessToken.id, tokenId),
  });

  if (!accessToken) {
    logger.warn("Access token not found", { tokenId });
    throw new ORPCError("UNAUTHORIZED", { message: "Invalid API key" });
  }

  if (accessToken.revokedAt) {
    logger.warn("Access token revoked", { tokenId });
    throw new ORPCError("UNAUTHORIZED", { message: "Token has been revoked" });
  }

  const machine = await db.query.machine.findFirst({
    where: eq(schema.machine.id, machineId),
    with: { project: true },
  });

  if (!machine) {
    logger.warn("Machine not found", { machineId });
    throw new ORPCError("NOT_FOUND", { message: "Machine not found" });
  }

  if (machine.project.id !== accessToken.projectId) {
    logger.warn("Machine doesn't belong to token's project", {
      machineId,
      machineProjectId: machine.project.id,
      tokenProjectId: accessToken.projectId,
    });
    throw new ORPCError("FORBIDDEN", { message: "Machine doesn't belong to this project" });
  }

  // Touch last-used timestamp in background
  db.update(schema.projectAccessToken)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.projectAccessToken.id, tokenId))
    .catch(() => {});

  return { machine, tokenId };
}

export const reportStatus = os.machines.reportStatus
  .use(withApiKey)
  .handler(async ({ input, context }) => {
    const { db, env, executionCtx } = context;

    // Authenticate and get machine
    const { machine } = await authenticateApiKey(db, context.apiKey, input.machineId);

    // Re-fetch with organization for invalidation
    const machineWithOrg = await db.query.machine.findFirst({
      where: eq(schema.machine.id, machine.id),
      with: { project: { with: { organization: true } } },
    });

    if (!machineWithOrg) {
      throw new ORPCError("NOT_FOUND", { message: "Machine not found" });
    }

    const { status, message } = input;

    // Always emit the fact that the daemon reported status.
    // Consumers decide whether to act (e.g. push setup, start the probe pipeline).
    await outboxClient.send({ transaction: db, parent: db }, "machine:daemon-status-reported", {
      machineId: machine.id,
      projectId: machineWithOrg.projectId,
      status,
      message: message ?? "",
      externalId: machineWithOrg.externalId,
    });

    logger.info("Machine daemon status reported", { machineId: machine.id, status });

    // Broadcast invalidation to update UI in real-time
    executionCtx.waitUntil(
      broadcastInvalidation(env).catch((err) => {
        logger.error("Failed to broadcast invalidation", err);
      }),
    );

    return { success: true };
  });

export const workerRouter = os.router({
  machines: {
    reportStatus,
  },
});
