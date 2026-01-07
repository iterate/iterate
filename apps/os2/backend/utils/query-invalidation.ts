import { eq } from "drizzle-orm";
import type { DB } from "../db/client.ts";
import { organizationUserMembership } from "../db/schema.ts";
import type { CloudflareEnv } from "../../env.ts";

export async function invalidateQueriesForUser(
  db: DB,
  env: CloudflareEnv,
  userId: string,
): Promise<void> {
  const memberships = await db.query.organizationUserMembership.findMany({
    where: eq(organizationUserMembership.userId, userId),
  });

  await Promise.all(
    memberships.map(async (membership) => {
      const id = env.TANSTACK_QUERY_INVALIDATOR.idFromName(membership.organizationId);
      const stub = env.TANSTACK_QUERY_INVALIDATOR.get(id);
      await stub.fetch(new Request("http://internal/invalidate", { method: "POST" }));
    }),
  );
}
