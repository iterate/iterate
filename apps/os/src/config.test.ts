import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { parseAppConfigFromEnv } from "@iterate-com/shared/config";
import { AppConfig, parseConfig } from "./config.ts";

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

  it("exposes the bound Cloudflare Artifacts config as public config", () => {
    const config = parseConfig({
      APP_CONFIG: JSON.stringify(baseConfig),
      ARTIFACTS_ACCOUNT_ID: "04b3b57291ef2626c6a8daa9d47065a7",
      ARTIFACTS_NAMESPACE: "os-prd-repos",
      WORKER_SELF: "os-prd",
    });

    expect(config.cloudflare.accountId).toEqual("04b3b57291ef2626c6a8daa9d47065a7");
    expect(config.cloudflare.artifactsNamespace).toEqual("os-prd-repos");
    expect(config.cloudflare.workerName).toEqual("os-prd");
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

  it("accepts an explicit provider origin with platform Petshop client credentials", () => {
    const petshop = {
      baseUrl: "https://dummy-petshop.iterate-preview-3.com",
      oauthClientId: "petshop-client-id",
      oauthClientSecret: "petshop-client-secret",
    };
    const parsePetshop = (value: Record<string, string>) =>
      parseAppConfigFromEnv({
        configSchema: AppConfig,
        prefix: "APP_CONFIG_",
        env: {
          APP_CONFIG: JSON.stringify(baseConfig),
          APP_CONFIG_INTEGRATIONS__PETSHOP: JSON.stringify(value),
        },
      });

    expect(parsePetshop(petshop).integrations.petshop?.baseUrl).toBe(petshop.baseUrl);
    const { baseUrl: _baseUrl, ...withoutBaseUrl } = petshop;
    expect(parsePetshop(withoutBaseUrl).integrations.petshop?.baseUrl).toBeUndefined();
  });

  it("accepts platform Parallel integration runtime config", () => {
    const parsed = parseAppConfigFromEnv({
      configSchema: AppConfig,
      prefix: "APP_CONFIG_",
      env: {
        APP_CONFIG: JSON.stringify(baseConfig),
        APP_CONFIG_INTEGRATIONS__EXA: JSON.stringify({
          apiKey: "exa-api-key",
        }),
        APP_CONFIG_INTEGRATIONS__PARALLEL: JSON.stringify({
          apiKey: "parallel-api-key",
        }),
      },
    });

    expect(parsed.integrations.exa?.apiKey.exposeSecret()).toEqual("exa-api-key");
    expect(parsed.integrations.parallel?.apiKey.exposeSecret()).toEqual("parallel-api-key");
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
