import { eq, and } from "drizzle-orm";
import type { DB } from "../db/client.ts";
import * as schema from "../db/schema.ts";

export const getSlackAccessTokenForEstate = async (db: DB, estateId: string) => {
  const result = await db
    .select({
      accessToken: schema.account.accessToken,
    })
    .from(schema.estateAccountsPermissions)
    .innerJoin(schema.account, eq(schema.estateAccountsPermissions.accountId, schema.account.id))
    .where(
      and(
        eq(schema.estateAccountsPermissions.estateId, estateId),
        eq(schema.account.providerId, "slack-bot"),
      ),
    )
    .limit(1);

  return result[0]?.accessToken || null;
};
