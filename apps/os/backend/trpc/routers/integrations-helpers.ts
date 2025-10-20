import { account } from "../../db/schema.ts";

type EstateAccountRecord = {
  account: typeof account.$inferSelect | null;
};

type PersonalAccountRecord = typeof account.$inferSelect;

export function formatMcpOAuthConnections(params: {
  estateAccounts: EstateAccountRecord[];
  personalAccounts: PersonalAccountRecord[];
  knownOAuthProviders: string[];
}) {
  const { estateAccounts, personalAccounts, knownOAuthProviders } = params;

  const estateConnections = estateAccounts
    .filter(({ account: estateAccount }) => {
      return estateAccount && !knownOAuthProviders.includes(estateAccount.providerId);
    })
    .map(({ account: estateAccount }) => {
      const accountRecord = estateAccount!;
      return {
        type: "mcp-oauth" as const,
        id: accountRecord.id,
        name: accountRecord.providerId,
        providerId: accountRecord.providerId,
        mode: "company" as const,
        scope: accountRecord.scope,
        connectedAt: accountRecord.createdAt,
        userId: accountRecord.userId,
      };
    });

  const estateAccountIds = new Set(estateConnections.map((connection) => connection.id));

  const personalConnections = personalAccounts
    .filter((personalAccount) => {
      return (
        !knownOAuthProviders.includes(personalAccount.providerId) &&
        !estateAccountIds.has(personalAccount.id)
      );
    })
    .map((personalAccount) => ({
      type: "mcp-oauth" as const,
      id: personalAccount.id,
      name: personalAccount.providerId,
      providerId: personalAccount.providerId,
      mode: "personal" as const,
      scope: personalAccount.scope,
      connectedAt: personalAccount.createdAt,
      userId: personalAccount.userId,
    }));

  return [...estateConnections, ...personalConnections];
}
