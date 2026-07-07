// Unit tests for the GitHub half of completeConnect — now a GitHub App
// installation (D5), not an OAuth-user code exchange. There is NO network: the
// callback carries an `installation_id`, and completeConnect records the
// connection secret (`{ installationId }` + the in-jail install worker), the
// connected fact, and the directory claim the webhook door routes on. The seam
// is the same in-memory itxEnv the google tests use.

import { afterEach, describe, expect, test, vi } from "vitest";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { completeConnect } from "./connect-flows.ts";
import { createOAuthState } from "./oauth-state.ts";
import {
  CONNECTION_CLAIMED_EVENT_TYPE,
  GITHUB_CONNECTED_EVENT_TYPE,
  githubConnectionSecretPath,
} from "./utils.ts";
import { parseConfig } from "~/config.ts";

const network = vi.hoisted(() => {
  const streams = new Map<string, Array<{ payload: unknown; type: string }>>();
  const secrets = new Map<
    string,
    { egress: { urls: string[] }; material: unknown; worker?: unknown }
  >();
  return {
    SECRET: {
      getByName(name: string) {
        return {
          async update(input: { egress: { urls: string[] }; material: unknown; worker?: unknown }) {
            secrets.set(name, input);
          },
        };
      },
    },
    STREAM: {
      getByName(name: string) {
        let events = streams.get(name);
        if (!events) {
          events = [];
          streams.set(name, events);
        }
        const stored = events;
        return {
          async append(...inputs: Array<{ payload: unknown; type: string }>) {
            stored.push(...inputs);
            return inputs.map((input, index) => ({ ...input, offset: stored.length + index }));
          },
        };
      },
    },
    reset() {
      streams.clear();
      secrets.clear();
    },
    secrets,
    streams,
  };
});

const SECRET_ENCRYPTION_KEY = "test-secret-encryption-key";

// connect-flows imports slack-api (disconnect's auth.revoke), which drags the
// worker-only egress entrypoint into the module graph; sever that edge — these
// tests never touch slack.
vi.mock("./slack-api.ts", () => ({ callProjectSlackWebApi: vi.fn() }));

vi.mock("../../env.ts", () => ({
  itxEnv: {
    SECRET: network.SECRET,
    SECRET_ENCRYPTION_KEY: "test-secret-encryption-key",
    STREAM: network.STREAM,
  },
}));

const PROJECT_ID = "prj_test";

describe("completeConnect (github App installation)", () => {
  afterEach(() => {
    network.reset();
  });

  test("claims the installation: stores { installationId } + install worker, records fact + directory claim", async () => {
    const state = await createOAuthState(
      { projectId: PROJECT_ID, provider: "github", userId: "user_1" },
      SECRET_ENCRYPTION_KEY,
    );

    const result = await completeConnect({
      config: testConfig(),
      installationId: "789",
      projectId: PROJECT_ID,
      provider: "github",
      state,
      userId: "user_1",
    });
    expect(result).toEqual({ callbackUrl: null, ok: true });

    // The installation id names the connection (install-<id>) and is the secret
    // material; the connection secret hosts the in-jail install worker.
    const secretName = DurableObjectNameCodec.stringify({
      projectId: PROJECT_ID,
      path: githubConnectionSecretPath("install-789"),
    });
    const stored = network.secrets.get(secretName);
    expect(stored?.material).toEqual({ installationId: "789" });
    expect(stored?.egress.urls).toContain("https://api.github.com");
    expect(stored?.worker).toBeDefined();

    // Connected fact on the connection stream.
    const journalName = DurableObjectNameCodec.stringify({
      projectId: PROJECT_ID,
      path: "/integrations/github/install-789",
    });
    const connected = network.streams
      .get(journalName)
      ?.find((event) => event.type === GITHUB_CONNECTED_EVENT_TYPE);
    expect(connected?.payload).toMatchObject({
      connection: "install-789",
      externalId: "789",
      installationId: "789",
    });

    // Directory claim (installation_id → project + connection) so the generic
    // webhook door can route inbound App webhooks.
    const claim = [...network.streams.values()]
      .flat()
      .find((event) => event.type === CONNECTION_CLAIMED_EVENT_TYPE);
    expect(claim?.payload).toMatchObject({
      connection: "install-789",
      externalId: "789",
      slug: "github",
    });
  });

  test("no App configured → github_app_not_configured, storage untouched", async () => {
    const state = await createOAuthState(
      { projectId: PROJECT_ID, provider: "github", userId: "user_1" },
      SECRET_ENCRYPTION_KEY,
    );
    const result = await completeConnect({
      config: testConfigWithoutApp(),
      installationId: "789",
      projectId: PROJECT_ID,
      provider: "github",
      state,
      userId: "user_1",
    });
    expect(result).toEqual({ callbackUrl: null, error: "github_app_not_configured", ok: false });
    expect(network.secrets.size).toBe(0);
    expect(network.streams.size).toBe(0);
  });

  test("missing installation id → github_missing_installation_id", async () => {
    const state = await createOAuthState(
      { projectId: PROJECT_ID, provider: "github", userId: "user_1" },
      SECRET_ENCRYPTION_KEY,
    );
    const result = await completeConnect({
      config: testConfig(),
      projectId: PROJECT_ID,
      provider: "github",
      state,
      userId: "user_1",
    });
    expect(result).toEqual({
      callbackUrl: null,
      error: "github_missing_installation_id",
      ok: false,
    });
    expect(network.secrets.size).toBe(0);
  });
});

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
        },
      },
      openAiApiKey: "openai-test-key",
    }),
  });
}

function testConfigWithoutApp() {
  return parseConfig({
    APP_CONFIG: JSON.stringify({
      baseUrl: "https://os.example.test",
      integrations: {
        github: {
          oauthClientId: "github-client-id",
          oauthClientSecret: "github-client-secret",
        },
      },
      openAiApiKey: "openai-test-key",
    }),
  });
}
