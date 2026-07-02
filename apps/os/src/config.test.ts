import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { parseAppConfigFromEnv } from "@iterate-com/shared/config";
import { AppConfig } from "./config.ts";

const baseConfig = {
  openAiApiKey: "openai-api-key",
};

describe("AppConfig", () => {
  it("keeps TypeID prefix visible because it is not a secret", () => {
    const parsed = parseAppConfigFromEnv({
      configSchema: AppConfig,
      prefix: "APP_CONFIG_",
      env: {
        APP_CONFIG: JSON.stringify(baseConfig),
      },
    });

    expect(parsed.typeIdPrefix).toBe("os");
    expect(inspect(parsed)).toContain("typeIdPrefix: 'os'");
  });

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

  it("accepts structured Slack and Google integration runtime config", () => {
    const parsed = parseAppConfigFromEnv({
      configSchema: AppConfig,
      prefix: "APP_CONFIG_",
      env: {
        APP_CONFIG: JSON.stringify(baseConfig),
        APP_CONFIG_INTEGRATIONS__SLACK: JSON.stringify({
          oauthClientId: "slack-client-id",
          oauthClientSecret: "slack-client-secret",
          webhookSigningSecret: "slack-signing-secret",
        }),
        APP_CONFIG_INTEGRATIONS__GOOGLE: JSON.stringify({
          oauthClientId: "google-client-id",
          oauthClientSecret: "google-client-secret",
        }),
      },
    });

    expect(parsed.integrations.slack?.oauthClientId).toEqual("slack-client-id");
    expect(parsed.integrations.slack?.oauthClientSecret.exposeSecret()).toEqual(
      "slack-client-secret",
    );
    expect(parsed.integrations.slack?.webhookSigningSecret.exposeSecret()).toEqual(
      "slack-signing-secret",
    );
    expect(parsed.integrations.google?.oauthClientId).toEqual("google-client-id");
    expect(parsed.integrations.google?.oauthClientSecret.exposeSecret()).toEqual(
      "google-client-secret",
    );
  });

  it("requires an OpenAI API key for upcoming OS AI-backed features", () => {
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
});
