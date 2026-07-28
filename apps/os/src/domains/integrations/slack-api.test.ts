// connectionSlackClient: the wrapped WebClient's transport must ride the
// project egress door with the bot-token PLACEHOLDER (never a real token), so
// the itx caller surface (slack.get("<conn>").chat.postMessage(...) etc.) keeps
// the token in its Secret DO. Only the egress stub is mocked; the WebClient is real
// (proving the custom Axios adapter works end to end).

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  expectedTeamId: "T0675PSN873",
  fallbackTeamId: "T0675PSN873",
  primaryResult: { ok: true, ts: "1700000000.000100" } as Record<string, unknown>,
  deploymentRequests: [] as Request[],
  requests: [] as Request[],
}));
vi.mock("../../env.ts", () => ({ itxEnv: { PROJECT: {} } }));
vi.mock("~/config.ts", () => ({
  parseConfig: () => ({
    integrations: {
      slack: { botToken: { exposeSecret: () => "deployment-slack-token" } },
    },
  }),
}));
vi.mock("../projects/egress.ts", () => ({
  projectStub: () => ({
    fetch: async (request: Request) => {
      mocks.requests.push(request);
      return Response.json(mocks.primaryResult);
    },
  }),
}));
vi.mock("./integration-streams.ts", () => ({
  latestStreamEventOfTypes: async () => ({
    payload: { teamId: mocks.expectedTeamId },
    type: "events.iterate.com/slack/connected",
  }),
}));

const { callProjectSlackWebApi, connectionSlackClient, normalizeSlackError, SLACK_CALL_GRAMMAR } =
  await import("./slack-api.ts");

describe("connectionSlackClient", () => {
  beforeEach(() => {
    mocks.expectedTeamId = "T0675PSN873";
    mocks.fallbackTeamId = "T0675PSN873";
    mocks.primaryResult = { ok: true, ts: "1700000000.000100" };
    mocks.deploymentRequests.length = 0;
    mocks.requests.length = 0;
    vi.stubGlobal("fetch", async (request: Request) => {
      mocks.deploymentRequests.push(request);
      if (new URL(request.url).pathname === "/api/auth.test") {
        return Response.json({ ok: true, team_id: mocks.fallbackTeamId });
      }
      return Response.json({ ok: true, ts: "1700000000.000200" });
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  test.for([
    {
      name: "a WebClient call rides project egress and succeeds first try",
      act: () =>
        connectionSlackClient({
          connection: "main",
          projectId: "prj_1",
          streamContext: { kind: "scope", scopePath: "/" },
        }).chat.postMessage({
          channel: "C1",
          text: "hi",
        }),
      expectedEgressUrls: ["https://slack.com/api/chat.postMessage"],
      expectedDeploymentPaths: [],
    },
    {
      name: "an invalid connection token retries with the same-workspace deployment token",
      primaryResult: { error: "invalid_auth", ok: false },
      act: () =>
        connectionSlackClient({
          connection: "main",
          projectId: "prj_1",
          streamContext: { kind: "scope", scopePath: "/" },
        }).chat.postMessage({
          channel: "C1",
          text: "hi",
        }),
      expectedEgressUrls: ["https://slack.com/api/chat.postMessage"],
      expectedDeploymentPaths: ["/api/auth.test", "/api/chat.postMessage"],
    },
    {
      name: "does not retry with a deployment token from another workspace",
      primaryResult: { error: "invalid_auth", ok: false },
      fallbackTeamId: "T_OTHER",
      act: () =>
        connectionSlackClient({
          connection: "main",
          projectId: "prj_1",
          streamContext: { kind: "scope", scopePath: "/" },
        }).chat.postMessage({
          channel: "C1",
          text: "hi",
        }),
      expectedRejection: "invalid_auth",
      expectedEgressUrls: ["https://slack.com/api/chat.postMessage"],
      expectedDeploymentPaths: ["/api/auth.test"],
    },
    {
      name: "the hand-rolled Web API path uses the same recovery policy",
      primaryResult: { error: "token_revoked", ok: false },
      act: () =>
        callProjectSlackWebApi({
          body: { channel: "C1", name: "eyes", timestamp: "1700000000.000100" },
          connection: "main",
          method: "reactions.add",
          projectId: "prj_1",
          streamContext: { kind: "scope", scopePath: "/" },
        }),
      expectedEgressUrls: ["https://slack.com/api/reactions.add"],
      expectedDeploymentPaths: ["/api/auth.test", "/api/reactions.add"],
    },
    {
      name: "never retries auth.revoke with the deployment credential",
      primaryResult: { error: "invalid_auth", ok: false },
      act: () =>
        callProjectSlackWebApi({
          body: {},
          connection: "main",
          method: "auth.revoke",
          projectId: "prj_1",
          streamContext: { kind: "scope", scopePath: "/" },
        }),
      expectedRejection: "invalid_auth",
      expectedEgressUrls: ["https://slack.com/api/auth.revoke"],
      expectedDeploymentPaths: [],
    },
  ])(
    "$name",
    async ({
      act,
      expectedDeploymentPaths,
      expectedEgressUrls,
      expectedRejection,
      fallbackTeamId,
      primaryResult,
    }) => {
      if (primaryResult !== undefined) mocks.primaryResult = primaryResult;
      if (fallbackTeamId !== undefined) mocks.fallbackTeamId = fallbackTeamId;

      if (expectedRejection === undefined) {
        const result = await act();
        expect(result.ok).toBe(true);
      } else {
        await expect(act()).rejects.toThrow(expectedRejection);
      }

      expect(mocks.requests.map((request) => new URL(request.url).href)).toEqual(
        expectedEgressUrls,
      );
      expect(mocks.deploymentRequests.map((request) => new URL(request.url).pathname)).toEqual(
        expectedDeploymentPaths,
      );
      // Every egress request carries the placeholder (the real token never
      // leaves the Secret DO); every deployment-lane request carries the
      // deployment credential.
      for (const request of mocks.requests) {
        expect(request.headers.get("authorization")).toBe(
          'Bearer getSecret("/secrets/integrations/slack/main/bot-token")',
        );
      }
      for (const request of mocks.deploymentRequests) {
        expect(request.headers.get("authorization")).toBe("Bearer deployment-slack-token");
      }
    },
  );

  test("hand-rolled Web API failures expose Slack's structured error code", async () => {
    mocks.primaryResult = { error: "already_reacted", ok: false };

    await expect(
      callProjectSlackWebApi({
        body: { channel: "C1", name: "eyes", timestamp: "1700000000.000100" },
        connection: "main",
        method: "reactions.add",
        projectId: "prj_1",
        streamContext: { kind: "scope", scopePath: "/" },
      }),
    ).rejects.toMatchObject({ slackErrorCode: "already_reacted" });
  });
});

describe("normalizeSlackError", () => {
  test.for([
    {
      name: "a secret-pipeline error names the connection and points at discovery",
      error: { data: { error: "secret_no_material" } } as unknown,
      connection: "main",
      expectedContains: ['Slack connection "main"', "itx.integrations.list()"],
    },
    {
      // The forgot-the-connection shape: `slack.chat.postMessage(...)` makes
      // the replay treat `chat` as the connection and try `postMessage` on the
      // WebClient, which misses. That miss must surface as the call grammar,
      // not the raw path-proxy string.
      name: "a path-resolution miss becomes the call grammar",
      error: new Error("Capability path postMessage did not resolve to a function."),
      connection: "chat",
      expectedMessage: SLACK_CALL_GRAMMAR,
      expectedContains: ["use itx.integrations.list() to see connections"],
    },
    {
      // A MID-path miss (an invented namespace like `.api.postMessage`) dies
      // on `api` being undefined, not on the leaf — same grammar answer.
      name: "a mid-path miss (hit undefined) becomes the call grammar",
      error: new Error("Capability path api.postMessage hit undefined."),
      connection: "main",
      expectedMessage: SLACK_CALL_GRAMMAR,
    },
    {
      name: "an unrecognized Slack error passes through verbatim",
      error: { message: "channel_not_found" } as unknown,
      connection: "main",
      expectedMessage: "channel_not_found",
    },
  ])("$name", ({ connection, error, expectedContains, expectedMessage }) => {
    const err = normalizeSlackError(error, connection);
    if (expectedMessage !== undefined) {
      expect(err.message).toBe(expectedMessage);
    }
    for (const needle of expectedContains ?? []) {
      expect(err.message).toContain(needle);
    }
  });
});
