import { expect, test, vi } from "vitest";

const captured: { projectDurableObjectName?: string; request?: Request } = {};

vi.mock("../../env.ts", () => ({
  itxEnv: {
    PROJECT: {
      getByName: (name: string) => ({
        fetch: async (request: Request) => {
          captured.projectDurableObjectName = name;
          captured.request = request;
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
    streamContext: { kind: "scope", scopePath: "/agents/gmail" },
    projectId: "prj_1",
    request: {
      body: { raw: "base64url-mime" },
      method: "POST",
      path: "/users/me/messages/send",
    },
  });

  expect(response).toMatchObject({ data: { id: "message-123" }, status: 200 });
  expect(captured.projectDurableObjectName).toContain("prj_1");
  expect(JSON.parse(captured.request!.headers.get("x-iterate-internal-stream-context")!)).toEqual({
    kind: "scope",
    scopePath: "/agents/gmail",
  });
  expect(captured.request).toMatchObject({
    method: "POST",
    url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
  });
  expect(captured.request!.headers.get("authorization")).toContain('getSecret("/secrets/');
  await expect(captured.request!.clone().json()).resolves.toEqual({ raw: "base64url-mime" });
});
