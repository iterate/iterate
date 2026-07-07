// connectionOctokit: the wrapped Octokit's transport must ride the connection
// secret's fetch with an access-token PLACEHOLDER (never a real token), so the
// itx caller surface (github["<conn>"].rest.* / .request()) keeps the token in
// its Secret DO. Only the secret stub is mocked; the Octokit is real.

import { describe, expect, test, vi } from "vitest";

const captured: { request?: Request } = {};
vi.mock("../../env.ts", () => ({
  itxEnv: {
    SECRET: {
      getByName: () => ({
        fetch: async (request: Request) => {
          captured.request = request;
          return Response.json({ id: 1, login: "octocat" });
        },
      }),
    },
  },
}));

const { connectionOctokit, normalizeGithubError, GITHUB_CALL_GRAMMAR } =
  await import("./github-api.ts");

describe("normalizeGithubError", () => {
  // Both replayPathCall miss shapes must answer with the grammar: a live
  // agent invented `.api.request(...)` (a MID-path miss — "hit undefined"),
  // got a generic failure, and burned turns rediscovering the surface.
  test("mid-path miss (hit undefined) gets the call grammar", () => {
    const error = normalizeGithubError(
      new Error("Capability path api.request hit undefined."),
      "acme",
    );
    expect(error.message).toBe(GITHUB_CALL_GRAMMAR);
  });

  test("leaf miss (did not resolve to a function) gets the call grammar", () => {
    const error = normalizeGithubError(
      new Error("Capability path repos.list did not resolve to a function."),
      "acme",
    );
    expect(error.message).toBe(GITHUB_CALL_GRAMMAR);
  });

  test("real API failures keep their status and message", () => {
    const error = normalizeGithubError(
      Object.assign(new Error("Not Found"), { status: 404 }),
      "acme",
    );
    expect(error.message).toBe("GitHub API failed with HTTP 404: Not Found");
  });
});

describe("connectionOctokit", () => {
  test(".request() rides the connection secret's fetch with a placeholder auth header", async () => {
    const octokit = connectionOctokit({ connection: "acme", projectId: "prj_1" });
    const response = await octokit.request("GET /user");

    expect(response.status).toBe(200);
    expect((response.data as { login: string }).login).toBe("octocat");
    const request = captured.request!;
    expect(new URL(request.url).href).toBe("https://api.github.com/user");
    expect(request.headers.get("authorization")).toBe(
      'Bearer getSecret({ path: "/secrets/integrations/github/acme", field: "accessToken" })',
    );
  });

  test("rest.* namespaced methods hit the right path over the same jailed transport", async () => {
    const octokit = connectionOctokit({ connection: "acme", projectId: "prj_1" });
    await octokit.rest.repos.get({ owner: "iterate", repo: "os" });

    expect(new URL(captured.request!.url).pathname).toBe("/repos/iterate/os");
    expect(captured.request!.headers.get("authorization")).toContain("getSecret(");
  });
});
