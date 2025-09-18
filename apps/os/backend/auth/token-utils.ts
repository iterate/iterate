import { eq, and } from "drizzle-orm";
import type { DB } from "../db/client.ts";
import * as schema from "../db/schema.ts";

export const getSlackAccessTokenForEstate = async (db: DB, slackTeamId: string) => {
  const result = await db
    .select({
      accessToken: schema.account.accessToken,
    })
    .from(schema.providerEstateMapping)
    .innerJoin(
      schema.estateAccountsPermissions,
      eq(schema.providerEstateMapping.internalEstateId, schema.estateAccountsPermissions.estateId),
    )
    .innerJoin(schema.account, eq(schema.estateAccountsPermissions.accountId, schema.account.id))
    .where(
      and(
        eq(schema.providerEstateMapping.externalId, slackTeamId),
        eq(schema.account.providerId, "slack-bot"),
      ),
    )
    .limit(1);

  return result[0]?.accessToken ?? null;
};
