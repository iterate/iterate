import { describe, expect, it } from "vitest";
import { parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import { AppConfig } from "./app.ts";

const baseConfig = {
  eventsBaseUrl: "https://events.iterate.com",
  clerk: {
    publishableKey: "pk_test_example",
    secretKey: "sk_test_example",
    jwtKey: "jwt-key",
  },
  mcpProofSecret: "proof-secret",
};

describe("AppConfig", () => {
  it("defaults MCP resource scopes to Clerk user data scopes only", () => {
    expect(AppConfig.parse(baseConfig).clerk.mcpOauthScopes).toEqual(["email", "profile"]);
  });

  it("accepts deprecated static Clerk OAuth app config keys", () => {
    expect(
      AppConfig.parse({
        ...baseConfig,
        clerk: {
          ...baseConfig.clerk,
          oauthClientId: "legacy-client-id",
          oauthClientSecret: "legacy-client-secret",
        },
      }).clerk.mcpOauthScopes,
    ).toEqual(["email", "profile"]);
  });

  it("accepts deprecated static Clerk OAuth app env overrides", () => {
    expect(
      parseAppConfigFromEnv({
        configSchema: AppConfig,
        prefix: "APP_CONFIG_",
        env: {
          APP_CONFIG: JSON.stringify(baseConfig),
          APP_CONFIG_CLERK__OAUTH_CLIENT_ID: "legacy-client-id",
          APP_CONFIG_CLERK__OAUTH_CLIENT_SECRET: "legacy-client-secret",
          APP_CONFIG_CLERK__MCP_OAUTH_SCOPES: JSON.stringify(["openid", "email", "profile"]),
        },
      }).clerk.mcpOauthScopes,
    ).toEqual(["email", "profile"]);
  });

  it("strips legacy openid from MCP resource scopes", () => {
    expect(
      AppConfig.parse({
        ...baseConfig,
        clerk: {
          ...baseConfig.clerk,
          mcpOauthScopes: ["openid", "email", "profile"],
        },
      }).clerk.mcpOauthScopes,
    ).toEqual(["email", "profile"]);
  });

  it("rejects unknown MCP resource scopes", () => {
    expect(() =>
      AppConfig.parse({
        ...baseConfig,
        clerk: {
          ...baseConfig.clerk,
          mcpOauthScopes: ["offline_access", "email", "profile"],
        },
      }),
    ).toThrow();
  });
});
