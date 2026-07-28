import { afterEach, describe, expect, test, vi } from "vitest";
import { parseConfig } from "../../config.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { restoreIntegrationConnection } from "./connect-flows.ts";
import {
  googleConnectionSecretPath,
  githubConnectionSecretPath,
  INTEGRATION_DIRECTORY_STREAM_PATH,
  slackBotTokenSecretPath,
} from "./utils.ts";

const network = await vi.hoisted(async () => {
  const { createFakeItxEnv } = await import("../../test/fake-itx-env.ts");
  return createFakeItxEnv();
});

vi.mock("./slack-api.ts", () => ({ callProjectSlackWebApi: vi.fn() }));
vi.mock("./telegram-api.ts", () => ({
  callProjectTelegramBotApi: vi.fn(),
  telegramApiBaseUrl: (config: { integrations: { telegram: { apiBaseUrl: string } } }) =>
    config.integrations.telegram.apiBaseUrl.replace(/\/$/, ""),
}));
vi.mock("../../env.ts", () => ({
  itxEnv: {
    SECRET: network.SECRET,
    SECRET_ENCRYPTION_KEY: "project-seed-test-key",
    STREAM: network.STREAM,
  },
}));

const PROJECT_ID = "prj_iterate";

describe("restoreIntegrationConnection", () => {
  afterEach(() => network.reset());

  test("validates and reconstructs a Slack connection with its webhook claim", async () => {
    const result = await restoreIntegrationConnection(
      {
        botToken: "xoxb-project-seed",
        config: testConfig(),
        connection: "iterate",
        projectId: PROJECT_ID,
        provider: "slack",
        teamId: "T_ITERATE",
      },
      {
        fetch: async () =>
          Response.json(
            {
              ok: true,
              team: "Iterate",
              team_id: "T_ITERATE",
              url: "https://iterate.slack.com/",
            },
            { headers: { "x-oauth-scopes": "chat:write, channels:history" } },
          ),
      },
    );

    expect(result).toEqual({
      connection: "iterate",
      externalId: "T_ITERATE",
      provider: "slack",
    });
    const secretName = DurableObjectNameCodec.stringify({
      path: slackBotTokenSecretPath("iterate"),
      projectId: PROJECT_ID,
    });
    expect(network.secrets.get(secretName)).toMatchObject({
      material: "xoxb-project-seed",
    });
    expect(directoryClaims()).toContainEqual(
      expect.objectContaining({
        connection: "iterate",
        externalId: "T_ITERATE",
        projectId: PROJECT_ID,
        slug: "slack",
      }),
    );
  });

  test("validates and reconstructs a GitHub App installation", async () => {
    const validated: string[] = [];
    const result = await restoreIntegrationConnection(
      {
        config: testConfig(),
        connection: "iterate-github",
        installationId: "789",
        projectId: PROJECT_ID,
        provider: "github",
      },
      {
        validateGithubInstallation: async ({ installationId }) => {
          validated.push(installationId);
        },
      },
    );

    expect(validated).toEqual(["789"]);
    expect(result).toEqual({
      connection: "iterate-github",
      externalId: "789",
      provider: "github",
    });
    const secretName = DurableObjectNameCodec.stringify({
      path: githubConnectionSecretPath("iterate-github"),
      projectId: PROJECT_ID,
    });
    expect(network.secrets.get(secretName)).toMatchObject({
      material: {},
      refresh: {
        appId: "123456",
        installationId: "789",
        kind: "github-app-installation",
      },
    });
    expect(directoryClaims()).toContainEqual(
      expect.objectContaining({
        connection: "iterate-github",
        externalId: "789",
        projectId: PROJECT_ID,
        slug: "github",
      }),
    );
  });

  test("refreshes and reconstructs a Google connection after proving its user id", async () => {
    const requests: string[] = [];
    const result = await restoreIntegrationConnection(
      {
        config: testConfig(),
        connection: "jonas-example-com",
        googleUserId: "google-user-123",
        material: {
          accessToken: "expired-access-token",
          refreshToken: "durable-refresh-token",
        },
        projectId: PROJECT_ID,
        provider: "google",
      },
      {
        fetch: async (input, init) => {
          const url = input.toString();
          requests.push(url);
          if (url === "https://oauth2.googleapis.com/token") {
            expect(String(init?.body)).toContain("refresh_token=durable-refresh-token");
            return Response.json({
              access_token: "fresh-access-token",
              scope: "openid email https://www.googleapis.com/auth/gmail.modify",
            });
          }
          return Response.json({
            email: "jonas@example.com",
            id: "google-user-123",
            name: "Jonas",
          });
        },
      },
    );

    expect(requests).toEqual([
      "https://oauth2.googleapis.com/token",
      "https://www.googleapis.com/oauth2/v2/userinfo",
    ]);
    expect(result).toEqual({
      connection: "jonas-example-com",
      externalId: "google-user-123",
      provider: "google",
    });
    const secretName = DurableObjectNameCodec.stringify({
      path: googleConnectionSecretPath("jonas-example-com"),
      projectId: PROJECT_ID,
    });
    expect(network.secrets.get(secretName)).toMatchObject({
      material: {
        accessToken: "fresh-access-token",
        refreshToken: "durable-refresh-token",
      },
      refresh: {
        kind: "oauth-refresh-token",
        tokenEndpoint: "https://oauth2.googleapis.com/token",
      },
    });
  });
});

function directoryClaims() {
  const name = DurableObjectNameCodec.stringify(
    { path: INTEGRATION_DIRECTORY_STREAM_PATH, projectId: null },
    { allowNullProjectId: true },
  );
  return (network.streams.get(name) ?? [])
    .filter((event) => event.type === "events.iterate.com/integration/connection-claimed")
    .map((event) => event.payload);
}

function testConfig() {
  return parseConfig({
    APP_CONFIG: JSON.stringify({
      baseUrl: "https://os.example.test",
      integrations: {
        github: {
          appId: "123456",
          appSlug: "iterate-os",
          oauthClientId: "github-client-id",
          oauthClientSecret: "github-client-secret",
          privateKey: "unused-test-private-key",
        },
        google: {
          oauthClientId: "google-client-id",
          oauthClientSecret: "google-client-secret",
          scopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.modify"],
        },
        slack: {
          botToken: "unused-deployment-fallback",
          oauthClientId: "slack-client-id",
          oauthClientSecret: "slack-client-secret",
          scopes: ["chat:write"],
          webhookSigningSecret: "slack-signing-secret",
        },
      },
      openAiApiKey: "openai-test-key",
    }),
  });
}
