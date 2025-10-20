import { describe, expect, it } from "vitest";
import { formatMcpOAuthConnections } from "./integrations-helpers.ts";
import { account } from "../../db/schema.ts";

type AccountRecord = typeof account.$inferSelect;

function buildAccount(overrides: Partial<AccountRecord> = {}): AccountRecord {
  const now = new Date("2024-01-01T00:00:00.000Z");
  return {
    id: overrides.id ?? `acc_${Math.random().toString(36).slice(2)}`,
    accountId: overrides.accountId ?? "acct_123",
    providerId: overrides.providerId ?? "mcp.example",
    userId: overrides.userId ?? "usr_123",
    accessToken: overrides.accessToken ?? null,
    refreshToken: overrides.refreshToken ?? null,
    idToken: overrides.idToken ?? null,
    accessTokenExpiresAt: overrides.accessTokenExpiresAt ?? null,
    refreshTokenExpiresAt: overrides.refreshTokenExpiresAt ?? null,
    scope: overrides.scope ?? "scope:read",
    password: overrides.password ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

describe("formatMcpOAuthConnections", () => {
  it("marks estate-level connections as company and personal ones as personal", () => {
    const estateAccount = buildAccount({
      id: "acc_company",
      providerId: "mcp.remote",
      userId: "usr_company",
      createdAt: new Date("2024-01-02T00:00:00.000Z"),
    });
    const personalAccount = buildAccount({
      id: "acc_personal",
      providerId: "mcp.remote",
      userId: "usr_personal",
      createdAt: new Date("2024-01-03T00:00:00.000Z"),
    });

    const connections = formatMcpOAuthConnections({
      estateAccounts: [{ account: estateAccount }],
      personalAccounts: [personalAccount],
      knownOAuthProviders: ["github-app", "slack-bot", "google"],
    });

    expect(connections).toMatchObject([
      {
        id: "acc_company",
        mode: "company",
        providerId: "mcp.remote",
        userId: "usr_company",
      },
      {
        id: "acc_personal",
        mode: "personal",
        providerId: "mcp.remote",
        userId: "usr_personal",
      },
    ]);
  });

  it("filters out known oauth providers and avoids duplicates", () => {
    const estateAccount = buildAccount({
      id: "acc_slack",
      providerId: "slack",
    });
    const duplicatePersonalAccount = buildAccount({
      id: "acc_company",
      providerId: "mcp.unique",
    });
    const personalOnlyAccount = buildAccount({
      id: "acc_personal_only",
      providerId: "mcp.other",
    });

    const connections = formatMcpOAuthConnections({
      estateAccounts: [{ account: estateAccount }, { account: duplicatePersonalAccount }],
      personalAccounts: [duplicatePersonalAccount, personalOnlyAccount],
      knownOAuthProviders: ["github-app", "slack-bot", "google", "slack"],
    });

    expect(connections).toHaveLength(2);
    expect(connections).toMatchObject([
      {
        id: "acc_company",
        mode: "company",
        providerId: "mcp.unique",
      },
      {
        id: "acc_personal_only",
        mode: "personal",
        providerId: "mcp.other",
      },
    ]);
  });
});
