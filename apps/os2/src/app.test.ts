import { describe, expect, it } from "vitest";
import { parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import { AppConfig } from "./app.ts";

const baseConfig = {
  clerk: {
    publishableKey: "pk_test_example",
    secretKey: "sk_test_example",
    jwtKey: "jwt-key",
  },
  mcpProofSecret: "proof-secret",
  openAiApiKey: "openai-api-key",
};

describe("AppConfig", () => {
  it("accepts an optional admin API secret for proof and automation clients", () => {
    expect(
      parseAppConfigFromEnv({
        configSchema: AppConfig,
        prefix: "APP_CONFIG_",
        env: {
          APP_CONFIG: JSON.stringify(baseConfig),
          APP_CONFIG_ADMIN_API_SECRET: "admin-api-secret-example",
        },
      }).adminApiSecret?.exposeSecret(),
    ).toEqual("admin-api-secret-example");
  });

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

  it("accepts an optional Slack bot token for codemode Slack examples", () => {
    expect(
      parseAppConfigFromEnv({
        configSchema: AppConfig,
        prefix: "APP_CONFIG_",
        env: {
          APP_CONFIG: JSON.stringify(baseConfig),
          APP_CONFIG_SLACK_BOT_TOKEN: "xoxb-example",
        },
      }).slackBotToken?.exposeSecret(),
    ).toEqual("xoxb-example");
  });

  it("requires an OpenAI API key for upcoming OS2 AI-backed features", () => {
    const { openAiApiKey: _openAiApiKey, ...missingOpenAiConfig } = baseConfig;

    expect(() => AppConfig.parse(missingOpenAiConfig)).toThrow();
    expect(
      parseAppConfigFromEnv({
        configSchema: AppConfig,
        prefix: "APP_CONFIG_",
        env: {
          APP_CONFIG: JSON.stringify(missingOpenAiConfig),
          APP_CONFIG_OPEN_AI_API_KEY: "sk-openai-example",
        },
      }).openAiApiKey.exposeSecret(),
    ).toEqual("sk-openai-example");
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
