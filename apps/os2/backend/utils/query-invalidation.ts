import { eq } from "drizzle-orm";
import type { DB } from "../db/client.ts";
import { organizationUserMembership } from "../db/schema.ts";
import type { CloudflareEnv } from "../../env.ts";
import { logger } from "../tag-logger.ts";

export async function invalidateQueriesForUser(
  db: DB,
  env: CloudflareEnv,
  userId: string,
): Promise<void> {
  const memberships = await db.query.organizationUserMembership.findMany({
    where: eq(organizationUserMembership.userId, userId),
  });

  logger.info(`Invalidating queries for user ${userId} across ${memberships.length} organizations`);

  const results = await Promise.allSettled(
    memberships.map(async (membership) => {
      const id = env.TANSTACK_QUERY_INVALIDATOR.idFromName(membership.organizationId);
      const stub = env.TANSTACK_QUERY_INVALIDATOR.get(id);
      const response = await stub.fetch(new Request("http://internal/invalidate", { method: "POST" }));
      if (!response.ok) {
        throw new Error(`Failed to invalidate for org ${membership.organizationId}: ${response.status}`);
      }
      const result = await response.json() as { success: boolean; sent: number; failed: number };
      logger.info(`Invalidated org ${membership.organizationId}: sent=${result.sent}, failed=${result.failed}`);
      return result;
    }),
  );

  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length > 0) {
    logger.error(`Failed to invalidate ${failed.length} organizations`, failed);
  }
}
