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

  test("a WebClient call rides project egress with a placeholder auth header", async () => {
    const slack = connectionSlackClient({ connection: "main", projectId: "prj_1" });
    const result = await slack.chat.postMessage({ channel: "C1", text: "hi" });

    expect(result.ok).toBe(true);
    const request = mocks.requests[0]!;
    expect(new URL(request.url).href).toBe("https://slack.com/api/chat.postMessage");
    expect(request.headers.get("authorization")).toBe(
      'Bearer getSecret({ path: "/secrets/integrations/slack/main/bot-token" })',
    );
  });

  test("an invalid connection token retries with the same-workspace deployment token", async () => {
    mocks.primaryResult = { error: "invalid_auth", ok: false };

    const slack = connectionSlackClient({ connection: "main", projectId: "prj_1" });
    const result = await slack.chat.postMessage({ channel: "C1", text: "hi" });

    expect(result.ok).toBe(true);
    expect(mocks.requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/chat.postMessage",
    ]);
    expect(mocks.deploymentRequests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/auth.test",
      "/api/chat.postMessage",
    ]);
    expect(mocks.deploymentRequests.map((request) => request.headers.get("authorization"))).toEqual(
      ["Bearer deployment-slack-token", "Bearer deployment-slack-token"],
    );
  });

  test("does not retry with a deployment token from another workspace", async () => {
    mocks.primaryResult = { error: "invalid_auth", ok: false };
    mocks.fallbackTeamId = "T_OTHER";

    const slack = connectionSlackClient({ connection: "main", projectId: "prj_1" });

    await expect(slack.chat.postMessage({ channel: "C1", text: "hi" })).rejects.toThrow(
      "invalid_auth",
    );
    expect(mocks.requests).toHaveLength(1);
    expect(mocks.deploymentRequests).toHaveLength(1);
  });

  test("the hand-rolled Web API path uses the same recovery policy", async () => {
    mocks.primaryResult = { error: "token_revoked", ok: false };

    const result = await callProjectSlackWebApi({
      body: { channel: "C1", name: "eyes", timestamp: "1700000000.000100" },
      connection: "main",
      method: "reactions.add",
      projectId: "prj_1",
    });

    expect(result.ok).toBe(true);
    expect(mocks.deploymentRequests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/auth.test",
      "/api/reactions.add",
    ]);
  });

  test("never retries auth.revoke with the deployment credential", async () => {
    mocks.primaryResult = { error: "invalid_auth", ok: false };

    await expect(
      callProjectSlackWebApi({
        body: {},
        connection: "main",
        method: "auth.revoke",
        projectId: "prj_1",
      }),
    ).rejects.toThrow("invalid_auth");
    expect(mocks.deploymentRequests).toHaveLength(0);
  });
});

describe("normalizeSlackError", () => {
  test("a secret-pipeline error names the connection and points at discovery", () => {
    const err = normalizeSlackError({ data: { error: "secret_no_material" } }, "main");
    expect(err.message).toContain('Slack connection "main"');
    expect(err.message).toContain("itx.integrations.list()");
  });

  // The forgot-the-connection shape: `slack.chat.postMessage(...)` makes the
  // replay treat `chat` as the connection and try `postMessage` on the
  // WebClient, which misses. That miss must surface as the call grammar, not
  // the raw path-proxy string.
  test("a path-resolution miss becomes the call grammar", () => {
    const err = normalizeSlackError(
      new Error("Capability path postMessage did not resolve to a function."),
      "chat",
    );
    expect(err.message).toBe(SLACK_CALL_GRAMMAR);
    expect(err.message).toMatch(/use itx\.integrations\.list\(\) to see connections/);
  });

  // A MID-path miss (an invented namespace like `.api.postMessage`) dies on
  // `api` being undefined, not on the leaf — same grammar answer.
  test("a mid-path miss (hit undefined) becomes the call grammar", () => {
    const err = normalizeSlackError(
      new Error("Capability path api.postMessage hit undefined."),
      "main",
    );
    expect(err.message).toBe(SLACK_CALL_GRAMMAR);
  });

  test("an unrecognized Slack error passes through verbatim", () => {
    const err = normalizeSlackError({ message: "channel_not_found" }, "main");
    expect(err.message).toBe("channel_not_found");
  });
});
