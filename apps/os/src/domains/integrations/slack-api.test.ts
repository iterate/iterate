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

const { connectionSlackClient } = await import("./slack-api.ts");

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
