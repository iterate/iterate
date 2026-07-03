// Unit tests for the GitHub exchange half of completeConnect: code exchange,
// connection naming from the GitHub login, and the recorded storage facts
// (token secret + connected journal event). Network and DOs are mocked; the
// seam is the same in-memory itxEnv the google-tokens tests use.

import { afterEach, describe, expect, test, vi } from "vitest";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { completeConnect } from "./connect-flows.ts";
import { createOAuthState } from "./oauth-state.ts";
import { GITHUB_CONNECTED_EVENT_TYPE, githubTokenSecretPath } from "./utils.ts";
import { parseConfig } from "~/config.ts";

const network = vi.hoisted(() => {
  const streams = new Map<string, Array<{ payload: unknown; type: string }>>();
  const secrets = new Map<string, { egress: { urls: string[] }; material: string }>();
  return {
    SECRET: {
      getByName(name: string) {
        return {
          async update(input: { egress: { urls: string[] }; material: string }) {
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

describe("completeConnect (github)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    network.reset();
  });

  test("exchanges the code, names the connection from the login, and records token + fact", async () => {
    const state = await createOAuthState(
      { projectId: PROJECT_ID, provider: "github", userId: "user_1" },
      SECRET_ENCRYPTION_KEY,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://github.com/login/oauth/access_token") {
          return Response.json({ access_token: "ghu_test_token" });
        }
        if (url === "https://api.github.com/user") {
          return Response.json({ id: 12345, login: "Jonas-T" });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    const result = await completeConnect({
      code: "code-1",
      config: testConfig(),
      projectId: PROJECT_ID,
      provider: "github",
      state,
      userId: "user_1",
    });
    expect(result).toEqual({ callbackUrl: null, ok: true });

    // The login sanitizes into the connection name.
    const secretName = DurableObjectNameCodec.stringify({
      projectId: PROJECT_ID,
      path: githubTokenSecretPath("jonas-t"),
    });
    expect(network.secrets.get(secretName)).toMatchObject({
      material: "ghu_test_token",
      egress: { urls: expect.arrayContaining(["https://api.github.com", "https://github.com"]) },
    });

    const journalName = DurableObjectNameCodec.stringify({
      projectId: PROJECT_ID,
      path: "/integrations/github/jonas-t",
    });
    const connected = network.streams
      .get(journalName)
      ?.find((event) => event.type === GITHUB_CONNECTED_EVENT_TYPE);
    expect(connected?.payload).toMatchObject({
      connection: "jonas-t",
      externalId: "12345",
      login: "Jonas-T",
    });
  });

  test("a failed code exchange reports the provider error without touching storage", async () => {
    const state = await createOAuthState(
      { projectId: PROJECT_ID, provider: "github", userId: "user_1" },
      SECRET_ENCRYPTION_KEY,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "bad_verification_code" })),
    );

    const result = await completeConnect({
      code: "expired",
      config: testConfig(),
      projectId: PROJECT_ID,
      provider: "github",
      state,
      userId: "user_1",
    });
    expect(result).toEqual({ callbackUrl: null, error: "bad_verification_code", ok: false });
    expect(network.secrets.size).toBe(0);
    expect(network.streams.size).toBe(0);
  });
});

function testConfig() {
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
