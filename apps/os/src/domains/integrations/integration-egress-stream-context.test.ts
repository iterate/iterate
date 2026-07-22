import { expect, test, vi } from "vitest";
import { takeStreamContext } from "../projects/stream-context.ts";

const requests = vi.hoisted(() => [] as Request[]);

vi.mock("../../env.ts", () => ({ itxEnv: { PROJECT: {} } }));
vi.mock("~/config.ts", () => ({
  parseConfig: () => ({
    integrations: {
      slack: { botToken: { exposeSecret: () => "deployment-slack-token" } },
      telegram: { apiBaseUrl: "https://api.telegram.org" },
    },
  }),
}));
vi.mock("../projects/egress.ts", () => ({
  projectStub: () => ({
    fetch: async (request: Request) => {
      requests.push(request);
      if (request.url.includes("api.telegram.org")) return Response.json({ ok: true, result: {} });
      if (request.url.includes("waitrose.com")) {
        return Response.json({ componentsAndProducts: [], totalMatches: 0 });
      }
      return Response.json({ ok: true });
    },
  }),
}));

test("script-driven built-in integrations preserve stream context at project egress", async () => {
  const streamContext = {
    executionId: "exec_approval",
    kind: "script-execution" as const,
    scriptRunRequestedEventOffset: 42,
    streamPath: "/agents/approval-test",
  };
  const { connectionSlackClient } = await import("./slack-api.ts");
  const { callProjectTelegramBotApi } = await import("./telegram-api.ts");
  const { connectionWaitroseClient } = await import("./waitrose-api.ts");

  await connectionSlackClient({
    connection: "main",
    projectId: "prj_1",
    streamContext,
  }).chat.postMessage({ channel: "C1", text: "hi" });
  await callProjectTelegramBotApi({
    body: { chat_id: 1, text: "hi" },
    connection: "main",
    method: "sendMessage",
    projectId: "prj_1",
    streamContext,
  });
  await connectionWaitroseClient({
    connection: "main",
    projectId: "prj_1",
    streamContext,
  }).searchProducts("oat milk");

  expect(requests.map((request) => takeStreamContext(request).streamContext)).toEqual([
    streamContext,
    streamContext,
    streamContext,
  ]);
});
