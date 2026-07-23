// Unit tests for the GitHub half of completeConnect. The setup callback's
// installation_id is deliberately untrusted: it is carried through a signed
// second state, then a GitHub user token must enumerate that installation
// before completeConnect records any secret, fact, or directory claim.

import { afterEach, describe, expect, test, vi } from "vitest";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { completeConnect, confirmGithubSteal } from "./connect-flows.ts";
import { createOAuthState, verifyOAuthState } from "./oauth-state.ts";
import { INTEGRATION_DIRECTORY_STREAM_PATH, githubConnectionSecretPath } from "./utils.ts";
import { parseConfig } from "~/config.ts";

const network = await vi.hoisted(async () => {
  const { createFakeItxEnv } = await import("../../test/fake-itx-env.ts");
  return createFakeItxEnv();
});

const SECRET_ENCRYPTION_KEY = "test-secret-encryption-key";

// connect-flows imports slack-api (disconnect's auth.revoke) and telegram-api
// (disconnect's deleteWebhook), which drag the worker-only egress entrypoint
// into the module graph; sever those edges — these tests never touch either.
vi.mock("./slack-api.ts", () => ({ callProjectSlackWebApi: vi.fn() }));
vi.mock("./telegram-api.ts", () => ({
  callProjectTelegramBotApi: vi.fn(),
  telegramApiBaseUrl: (config: { integrations: { telegram: { apiBaseUrl: string } } }) =>
    config.integrations.telegram.apiBaseUrl.replace(/\/$/, ""),
}));

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
    vi.unstubAllGlobals();
  });

  test("proves user access before claiming the installation", async () => {
    const state = await createOAuthState(
      { projectId: PROJECT_ID, provider: "github", userId: "user_1" },
      SECRET_ENCRYPTION_KEY,
    );

    const setupResult = await completeConnect({
      config: testConfig(),
      installationId: "789",
      projectId: PROJECT_ID,
      provider: "github",
      state,
      userId: "user_1",
    });
    expect(setupResult.ok).toBe(true);
    const authorizationUrl = new URL(setupResult.callbackUrl!);
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(network.secrets.size).toBe(0);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: RequestInfo | URL) => {
        const url = String(request);
        if (url === "https://github.com/login/oauth/access_token") {
          return Response.json({ access_token: "ghu_user" });
        }
        if (url.startsWith("https://api.github.com/user/installations?")) {
          return Response.json({ installations: [{ id: 789 }] });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    const result = await completeConnect({
      code: "oauth-code",
      config: testConfig(),
      projectId: PROJECT_ID,
      provider: "github",
      state: authorizationUrl.searchParams.get("state")!,
      userId: "user_1",
    });
    expect(result).toEqual({ callbackUrl: null, ok: true });

    // The installation id names the connection (install-<id>) and — being
    // public — lives in the strategy config, not in material. Material starts
    // empty: the Secret DO's strategy mints the token on first use, signing
    // with the first-party App key resolved from deployment config.
    const secretName = DurableObjectNameCodec.stringify({
      projectId: PROJECT_ID,
      path: githubConnectionSecretPath("install-789"),
    });
    const stored = network.secrets.get(secretName);
    expect(stored?.material).toEqual({});
    expect(stored?.egress?.urls).toContain("https://api.github.com");
    expect(stored?.refresh).toEqual({
      kind: "github-app-installation",
      apiBase: "https://api.github.com",
      appId: "123456",
      installationId: "789",
      privateKey: { platform: "integrations.github" },
    });

    // Connected fact on the connection stream.
    const journalName = DurableObjectNameCodec.stringify({
      projectId: PROJECT_ID,
      path: "/integrations/github/install-789",
    });
    const connected = network.streams
      .get(journalName)
      ?.find((event) => event.type === "events.iterate.com/github/connected");
    expect(connected?.payload).toMatchObject({
      connection: "install-789",
      externalId: "789",
      installationId: "789",
    });

    // Directory claim (installation_id → project + connection) so the generic
    // webhook door can route inbound App webhooks.
    const claim = [...network.streams.values()]
      .flat()
      .find((event) => event.type === "events.iterate.com/integration/connection-claimed");
    expect(claim?.payload).toMatchObject({
      connection: "install-789",
      externalId: "789",
      slug: "github",
    });
  });

  test("spoofed installation id is rejected when the GitHub user cannot access it", async () => {
    const state = await createOAuthState(
      { projectId: PROJECT_ID, provider: "github", userId: "user_1" },
      SECRET_ENCRYPTION_KEY,
    );
    const setupResult = await completeConnect({
      config: testConfig(),
      installationId: "789",
      projectId: PROJECT_ID,
      provider: "github",
      state,
      userId: "user_1",
    });
    const secondState = new URL(setupResult.callbackUrl!).searchParams.get("state")!;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: RequestInfo | URL) => {
        const url = String(request);
        if (url === "https://github.com/login/oauth/access_token") {
          return Response.json({ access_token: "ghu_user" });
        }
        if (url.startsWith("https://api.github.com/user/installations?")) {
          return Response.json({ installations: [{ id: 456 }] });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    await expect(
      completeConnect({
        code: "oauth-code",
        config: testConfig(),
        projectId: PROJECT_ID,
        provider: "github",
        state: secondState,
        userId: "user_1",
      }),
    ).resolves.toEqual({
      callbackUrl: null,
      error: "github_installation_not_authorized",
      ok: false,
    });
    expect(network.secrets.size).toBe(0);
  });

  test("a foreign claim returns a signed confirmation proof without changing storage", async () => {
    const directoryName = DurableObjectNameCodec.stringify(
      { path: INTEGRATION_DIRECTORY_STREAM_PATH, projectId: null },
      { allowNullProjectId: true },
    );
    await network.STREAM.getByName(directoryName).append({
      payload: {
        connection: "install-789",
        externalId: "789",
        projectId: "prj_other",
        slug: "github",
      },
      type: "events.iterate.com/integration/connection-claimed",
    });
    const state = await createOAuthState(
      { projectId: PROJECT_ID, provider: "github", userId: "user_1" },
      SECRET_ENCRYPTION_KEY,
    );
    const setupResult = await completeConnect({
      config: testConfig(),
      installationId: "789",
      projectId: PROJECT_ID,
      provider: "github",
      state,
      userId: "user_1",
    });
    const secondState = new URL(setupResult.callbackUrl!).searchParams.get("state")!;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: RequestInfo | URL) => {
        const url = String(request);
        if (url === "https://github.com/login/oauth/access_token") {
          return Response.json({ access_token: "ghu_user" });
        }
        if (url.startsWith("https://api.github.com/user/installations?")) {
          return Response.json({ installations: [{ id: 789 }] });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const result = await completeConnect({
      code: "oauth-code",
      config: testConfig(),
      projectId: PROJECT_ID,
      provider: "github",
      state: secondState,
      userId: "user_1",
    });
    expect(result).toMatchObject({
      callbackUrl: null,
      error: "github_installation_already_claimed",
      githubStealState: expect.stringMatching(/^v1\./),
      ok: false,
    });
    if (!result.ok && "githubStealState" in result) {
      await expect(
        verifyOAuthState(
          { provider: "github", state: result.githubStealState },
          SECRET_ENCRYPTION_KEY,
        ),
      ).resolves.toMatchObject({
        githubInstallationAuthorized: true,
        githubInstallationId: "789",
        projectId: PROJECT_ID,
        userId: "user_1",
      });
    }
    expect(network.secrets.size).toBe(0);
  });

  test("confirming the signed proof moves the installation and dispossesses the old project", async () => {
    const directoryName = DurableObjectNameCodec.stringify(
      { path: INTEGRATION_DIRECTORY_STREAM_PATH, projectId: null },
      { allowNullProjectId: true },
    );
    await network.STREAM.getByName(directoryName).append({
      payload: {
        connection: "their-installation",
        externalId: "789",
        projectId: "prj_other",
        slug: "github",
      },
      type: "events.iterate.com/integration/connection-claimed",
    });
    const oldSecretName = DurableObjectNameCodec.stringify({
      projectId: "prj_other",
      path: githubConnectionSecretPath("their-installation"),
    });
    await network.SECRET.getByName(oldSecretName).create({
      egress: { urls: ["https://api.github.com"] },
      material: {},
    });
    const state = await createOAuthState(
      { projectId: PROJECT_ID, provider: "github", userId: "user_1" },
      SECRET_ENCRYPTION_KEY,
    );
    const setupResult = await completeConnect({
      config: testConfig(),
      installationId: "789",
      projectId: PROJECT_ID,
      provider: "github",
      state,
      userId: "user_1",
    });
    const secondState = new URL(setupResult.callbackUrl!).searchParams.get("state")!;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: RequestInfo | URL) => {
        const url = String(request);
        if (url === "https://github.com/login/oauth/access_token") {
          return Response.json({ access_token: "ghu_user" });
        }
        if (url.startsWith("https://api.github.com/user/installations?")) {
          return Response.json({ installations: [{ id: 789 }] });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    const conflict = await completeConnect({
      code: "oauth-code",
      config: testConfig(),
      projectId: PROJECT_ID,
      provider: "github",
      state: secondState,
      userId: "user_1",
    });
    if (conflict.ok || !("githubStealState" in conflict)) {
      throw new Error("expected a GitHub steal confirmation state");
    }

    await expect(
      confirmGithubSteal({
        config: testConfig(),
        projectId: PROJECT_ID,
        state: conflict.githubStealState,
        userId: "user_1",
      }),
    ).resolves.toEqual({ connection: "install-789", ok: true });

    expect(network.secrets.get(oldSecretName)).toMatchObject({ egress: { urls: [] } });
    const oldJournalName = DurableObjectNameCodec.stringify({
      projectId: "prj_other",
      path: "/integrations/github/their-installation",
    });
    expect(network.streams.get(oldJournalName)?.at(-1)).toMatchObject({
      type: "events.iterate.com/github/disconnected",
      payload: {
        connection: "their-installation",
        projectId: "prj_other",
        reason: "stolen-by-another-project",
      },
    });
    expect(network.streams.get(directoryName)?.slice(-2)).toMatchObject([
      {
        type: "events.iterate.com/integration/connection-unclaimed",
        payload: {
          connection: "their-installation",
          externalId: "789",
          projectId: "prj_other",
          slug: "github",
        },
      },
      {
        type: "events.iterate.com/integration/connection-claimed",
        payload: {
          connection: "install-789",
          externalId: "789",
          projectId: PROJECT_ID,
          slug: "github",
        },
      },
    ]);
    const newSecretName = DurableObjectNameCodec.stringify({
      projectId: PROJECT_ID,
      path: githubConnectionSecretPath("install-789"),
    });
    expect(network.secrets.get(newSecretName)).toMatchObject({
      egress: {
        urls: expect.arrayContaining(["https://api.github.com", "https://uploads.github.com"]),
      },
      refresh: {
        appId: "123456",
        installationId: "789",
        kind: "github-app-installation",
      },
    });

    const directoryEventCount = network.streams.get(directoryName)?.length;
    const oldJournalEventCount = network.streams.get(oldJournalName)?.length;
    await expect(
      confirmGithubSteal({
        config: testConfig(),
        projectId: PROJECT_ID,
        state: conflict.githubStealState,
        userId: "user_1",
      }),
    ).resolves.toEqual({ connection: "install-789", ok: true });
    expect(network.streams.get(directoryName)).toHaveLength(directoryEventCount!);
    expect(network.streams.get(oldJournalName)).toHaveLength(oldJournalEventCount!);
  });

  test("confirmation rejects a different user, project, or unsigned authorization", async () => {
    const authorizedState = await createOAuthState(
      {
        githubInstallationAuthorized: true,
        githubInstallationId: "789",
        projectId: PROJECT_ID,
        provider: "github",
        userId: "user_1",
      },
      SECRET_ENCRYPTION_KEY,
    );
    const unprovedState = await createOAuthState(
      {
        githubInstallationId: "789",
        projectId: PROJECT_ID,
        provider: "github",
        userId: "user_1",
      },
      SECRET_ENCRYPTION_KEY,
    );

    await expect(
      confirmGithubSteal({
        config: testConfig(),
        projectId: PROJECT_ID,
        state: authorizedState,
        userId: "user_2",
      }),
    ).rejects.toThrow("Invalid or expired GitHub installation move confirmation.");
    await expect(
      confirmGithubSteal({
        config: testConfig(),
        projectId: "prj_other",
        state: authorizedState,
        userId: "user_1",
      }),
    ).rejects.toThrow("Invalid or expired GitHub installation move confirmation.");
    await expect(
      confirmGithubSteal({
        config: testConfig(),
        projectId: PROJECT_ID,
        state: unprovedState,
        userId: "user_1",
      }),
    ).rejects.toThrow("Invalid or expired GitHub installation move confirmation.");
    expect(network.secrets.size).toBe(0);
    expect(network.streams.size).toBe(0);
  });

  test("confirmation connects normally if the old project releases its claim first", async () => {
    const directoryName = DurableObjectNameCodec.stringify(
      { path: INTEGRATION_DIRECTORY_STREAM_PATH, projectId: null },
      { allowNullProjectId: true },
    );
    const directory = network.STREAM.getByName(directoryName);
    await directory.append({
      payload: {
        connection: "their-installation",
        externalId: "789",
        projectId: "prj_other",
        slug: "github",
      },
      type: "events.iterate.com/integration/connection-claimed",
    });
    const state = await createOAuthState(
      {
        githubInstallationAuthorized: true,
        githubInstallationId: "789",
        projectId: PROJECT_ID,
        provider: "github",
        userId: "user_1",
      },
      SECRET_ENCRYPTION_KEY,
    );
    await directory.append({
      payload: {
        connection: "their-installation",
        externalId: "789",
        projectId: "prj_other",
        slug: "github",
      },
      type: "events.iterate.com/integration/connection-unclaimed",
    });

    await expect(
      confirmGithubSteal({
        config: testConfig(),
        projectId: PROJECT_ID,
        state,
        userId: "user_1",
      }),
    ).resolves.toEqual({ connection: "install-789", ok: true });
    expect(network.streams.get(directoryName)?.at(-1)).toMatchObject({
      type: "events.iterate.com/integration/connection-claimed",
      payload: {
        connection: "install-789",
        externalId: "789",
        projectId: PROJECT_ID,
      },
    });
    const oldJournalName = DurableObjectNameCodec.stringify({
      projectId: "prj_other",
      path: "/integrations/github/their-installation",
    });
    expect(network.streams.has(oldJournalName)).toBe(false);
  });

  test("a steal retry bricks every owner it displaced, not only the final one", async () => {
    const directoryName = DurableObjectNameCodec.stringify(
      { path: INTEGRATION_DIRECTORY_STREAM_PATH, projectId: null },
      { allowNullProjectId: true },
    );
    const directory = network.STREAM.getByName(directoryName);
    await directory.append({
      payload: {
        connection: "project-a-installation",
        externalId: "789",
        projectId: "prj_a",
        slug: "github",
      },
      type: "events.iterate.com/integration/connection-claimed",
    });
    const projectASecretName = DurableObjectNameCodec.stringify({
      projectId: "prj_a",
      path: githubConnectionSecretPath("project-a-installation"),
    });
    const projectCSecretName = DurableObjectNameCodec.stringify({
      projectId: "prj_c",
      path: githubConnectionSecretPath("project-c-installation"),
    });
    const targetSecretName = DurableObjectNameCodec.stringify({
      projectId: PROJECT_ID,
      path: githubConnectionSecretPath("install-789"),
    });
    await network.SECRET.getByName(projectASecretName).create({
      egress: { urls: ["https://api.github.com"] },
      material: {},
    });
    await network.SECRET.getByName(projectCSecretName).create({
      egress: { urls: ["https://api.github.com"] },
      material: {},
    });
    const state = await createOAuthState(
      {
        githubInstallationAuthorized: true,
        githubInstallationId: "789",
        projectId: PROJECT_ID,
        provider: "github",
        userId: "user_1",
      },
      SECRET_ENCRYPTION_KEY,
    );

    // This project commits [unclaim A, claim target]. Before its verification
    // read, project C commits [unclaim target, claim C]. The retry then moves
    // C to the target. Both displaced owners must lose token-minting access.
    network.streamAppendHooks.push(async ({ events, name }) => {
      if (
        name !== directoryName ||
        !events.some(
          (event) =>
            event.type === "events.iterate.com/integration/connection-claimed" &&
            (event.payload as { projectId?: string }).projectId === PROJECT_ID,
        )
      ) {
        return false;
      }
      await directory.append(
        {
          payload: {
            connection: "install-789",
            externalId: "789",
            projectId: PROJECT_ID,
            slug: "github",
          },
          type: "events.iterate.com/integration/connection-unclaimed",
        },
        {
          payload: {
            connection: "project-c-installation",
            externalId: "789",
            projectId: "prj_c",
            slug: "github",
          },
          type: "events.iterate.com/integration/connection-claimed",
        },
      );
      // Project C's successful steal dispossesses the target before this
      // confirmation retries and wins ownership back.
      await network.SECRET.getByName(targetSecretName).update({ egress: { urls: [] } });
    });

    await expect(
      confirmGithubSteal({
        config: testConfig(),
        projectId: PROJECT_ID,
        state,
        userId: "user_1",
      }),
    ).resolves.toEqual({ connection: "install-789", ok: true });

    expect(network.secrets.get(projectASecretName)).toMatchObject({ egress: { urls: [] } });
    expect(network.secrets.get(projectCSecretName)).toMatchObject({ egress: { urls: [] } });
    expect(network.secrets.get(targetSecretName)).toMatchObject({
      egress: {
        urls: expect.arrayContaining(["https://api.github.com", "https://uploads.github.com"]),
      },
    });
  });

  test("a concurrent foreign claim wins once and bricks the losing connection", async () => {
    const directoryName = DurableObjectNameCodec.stringify(
      { path: INTEGRATION_DIRECTORY_STREAM_PATH, projectId: null },
      { allowNullProjectId: true },
    );
    const state = await createOAuthState(
      { projectId: PROJECT_ID, provider: "github", userId: "user_1" },
      SECRET_ENCRYPTION_KEY,
    );
    const setupResult = await completeConnect({
      config: testConfig(),
      installationId: "789",
      projectId: PROJECT_ID,
      provider: "github",
      state,
      userId: "user_1",
    });
    const secondState = new URL(setupResult.callbackUrl!).searchParams.get("state")!;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: RequestInfo | URL) => {
        const url = String(request);
        if (url === "https://github.com/login/oauth/access_token") {
          return Response.json({ access_token: "ghu_user" });
        }
        if (url.startsWith("https://api.github.com/user/installations?")) {
          return Response.json({ installations: [{ id: 789 }] });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    // Both projects saw the installation as unclaimed. The other project's
    // append lands while this project starts recording its connection.
    network.secretUpdateHooks.push(async () => {
      await network.STREAM.getByName(directoryName).append({
        payload: {
          connection: "install-789",
          externalId: "789",
          projectId: "prj_other",
          slug: "github",
        },
        type: "events.iterate.com/integration/connection-claimed",
      });
    });

    const result = await completeConnect({
      code: "oauth-code",
      config: testConfig(),
      projectId: PROJECT_ID,
      provider: "github",
      state: secondState,
      userId: "user_1",
    });
    expect(result).toMatchObject({
      callbackUrl: null,
      error: "github_installation_already_claimed",
      githubStealState: expect.stringMatching(/^v1\./),
      ok: false,
    });

    const secretName = DurableObjectNameCodec.stringify({
      projectId: PROJECT_ID,
      path: githubConnectionSecretPath("install-789"),
    });
    expect(network.secrets.get(secretName)?.egress?.urls).toEqual([]);
    const journalName = DurableObjectNameCodec.stringify({
      projectId: PROJECT_ID,
      path: "/integrations/github/install-789",
    });
    expect(network.streams.get(journalName)?.map((event) => event.type)).toContain(
      "events.iterate.com/github/disconnected",
    );
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

  test("missing installation id and OAuth code → github_missing_installation_id", async () => {
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
