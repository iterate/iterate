// connectionSlackClient: the wrapped WebClient's transport must ride the
// project egress door with the bot-token PLACEHOLDER (never a real token), so
// the itx caller surface (slack["<conn>"].chat.postMessage(...) etc.) keeps the
// token in its Secret DO. Only the egress stub is mocked; the WebClient is real
// (proving the custom Axios adapter works end to end).

import { describe, expect, test, vi } from "vitest";

const captured: { request?: Request } = {};
vi.mock("../../env.ts", () => ({ itxEnv: { PROJECT: {} } }));
vi.mock("../projects/egress.ts", () => ({
  projectStub: () => ({
    fetch: async (request: Request) => {
      captured.request = request;
      return Response.json({ ok: true, ts: "1700000000.000100" });
    },
  }),
}));

const { connectionSlackClient, normalizeSlackError, SLACK_CALL_GRAMMAR } =
  await import("./slack-api.ts");

describe("connectionSlackClient", () => {
  test("a WebClient call rides project egress with a placeholder auth header", async () => {
    const slack = connectionSlackClient({ connection: "main", projectId: "prj_1" });
    const result = await slack.chat.postMessage({ channel: "C1", text: "hi" });

    expect(result.ok).toBe(true);
    const request = captured.request!;
    expect(new URL(request.url).href).toBe("https://slack.com/api/chat.postMessage");
    expect(request.headers.get("authorization")).toBe(
      'Bearer getSecret({ path: "/secrets/integrations/slack/main/bot-token" })',
    );
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

  test("an unrecognized Slack error passes through verbatim", () => {
    const err = normalizeSlackError({ message: "channel_not_found" }, "main");
    expect(err.message).toBe("channel_not_found");
  });
});
