import { expect, test, vi } from "vitest";

const captured: { projectDurableObjectName?: string; request?: Request; source?: unknown } = {};

vi.mock("../../env.ts", () => ({
  itxEnv: {
    PROJECT: {
      getByName: (name: string) => ({
        egress: async (request: Request, source: unknown) => {
          captured.projectDurableObjectName = name;
          captured.request = request;
          captured.source = source;
          return Response.json({ id: "message-123" });
        },
      }),
    },
  },
}));

const { callGmailApi } = await import("./gmail-api.ts");

test("a Gmail API request enters project egress with its access-token placeholder", async () => {
  const response = await callGmailApi({
    authorization:
      'Bearer getSecret("/secrets/integrations/google/alice", { field: "accessToken" })',
    egressSource: { kind: "scope", scopePath: "/agents/gmail" },
    projectId: "prj_1",
    request: {
      body: { raw: "base64url-mime" },
      method: "POST",
      path: "/users/me/messages/send",
    },
  });

  expect(response).toMatchObject({ data: { id: "message-123" }, status: 200 });
  expect(captured.projectDurableObjectName).toContain("prj_1");
  expect(captured.source).toEqual({ kind: "scope", scopePath: "/agents/gmail" });
  expect(captured.request).toMatchObject({
    method: "POST",
    url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
  });
  expect(captured.request!.headers.get("authorization")).toContain('getSecret("/secrets/');
  await expect(captured.request!.clone().json()).resolves.toEqual({ raw: "base64url-mime" });
});
