// connectionOctokit: the wrapped Octokit's transport must ride project egress
// with an access-token PLACEHOLDER (never a real token), so the
// itx caller surface (github.get("<conn>").octokit.rest.* / .octokit.graphql()
// / .octokit.request()) keeps the token in its Secret DO. Only project egress
// is mocked; the all-in-one Octokit is real.

import { beforeEach, describe, expect, test, vi } from "vitest";

const captured: {
  projectDurableObjectName?: string;
  request?: Request;
  requestCount: number;
  responseStatus?: number;
} = {
  requestCount: 0,
};
vi.mock("../../env.ts", () => ({
  itxEnv: {
    PROJECT: {
      getByName: (name: string) => ({
        fetch: async (request: Request) => {
          captured.projectDurableObjectName = name;
          captured.request = request;
          captured.requestCount += 1;
          if (captured.responseStatus !== undefined) {
            return Response.json(
              { message: "transient GitHub failure" },
              { status: captured.responseStatus },
            );
          }
          if (new URL(request.url).pathname === "/graphql") {
            return Response.json({ data: { repository: { name: "iterate" } } });
          }
          if (new URL(request.url).pathname === "/repos/iterate/os/pulls/42/files") {
            return Response.json([{ filename: "apps/os/package.json" }]);
          }
          return Response.json({ id: 1, login: "octocat" });
        },
      }),
    },
  },
}));

const { connectionOctokit, normalizeGithubError, GITHUB_CALL_GRAMMAR } =
  await import("./github-api.ts");

beforeEach(() => {
  captured.projectDurableObjectName = undefined;
  captured.request = undefined;
  captured.requestCount = 0;
  captured.responseStatus = undefined;
});

describe("normalizeGithubError", () => {
  test("the public call grammar makes the Octokit namespace mandatory", () => {
    expect(GITHUB_CALL_GRAMMAR).toContain("get(connection?).octokit.<path>");
    expect(GITHUB_CALL_GRAMMAR).toContain(".octokit.rest.apps");
    expect(GITHUB_CALL_GRAMMAR).toContain(".octokit.graphql(query, variables)");
  });

  test.for([
    {
      // Both replayPathCall miss shapes must answer with the grammar: a live
      // agent invented `.api.request(...)` (a MID-path miss — "hit
      // undefined"), got a generic failure, and burned turns rediscovering
      // the surface.
      name: "mid-path miss (hit undefined) gets the call grammar",
      error: new Error("Capability path api.request hit undefined."),
      expectedMessage: GITHUB_CALL_GRAMMAR,
    },
    {
      name: "leaf miss (did not resolve to a function) gets the call grammar",
      error: new Error("Capability path repos.list did not resolve to a function."),
      expectedMessage: GITHUB_CALL_GRAMMAR,
    },
    {
      name: "real API failures keep their status and message",
      error: Object.assign(new Error("Not Found"), { status: 404 }),
      expectedMessage: "GitHub API failed with HTTP 404: Not Found",
    },
    {
      // Reserved-segment rejections share the "Capability path" prefix but
      // are a protocol violation, not a wrong guess at the surface — the real
      // reason must survive, not be rewritten to the grammar.
      name: "reserved-segment errors pass through",
      error: new Error('Capability path segment "constructor" is reserved.'),
      expectedContains: "is reserved",
    },
  ])("$name", ({ error, expectedContains, expectedMessage }) => {
    const normalized = normalizeGithubError(error, "acme");
    if (expectedMessage !== undefined) {
      expect(normalized.message).toBe(expectedMessage);
    }
    if (expectedContains !== undefined) {
      expect(normalized.message).toContain(expectedContains);
    }
  });
});

describe("connectionOctokit", () => {
  test(".request() rides project egress with a placeholder auth header", async () => {
    const octokit = connectionOctokit({ connection: "acme", projectId: "prj_1" });
    const response = await octokit.request("GET /user");

    expect(response.status).toBe(200);
    expect((response.data as { login: string }).login).toBe("octocat");
    const request = captured.request!;
    expect(new URL(request.url).href).toBe("https://api.github.com/user");
    expect(request.headers.get("authorization")).toBe(
      'Bearer getSecret("/secrets/integrations/github/acme", { field: "accessToken" })',
    );
    expect(captured.projectDurableObjectName).toContain("prj_1");
  });

  test("rest.* namespaced methods hit the right path over the same jailed transport", async () => {
    const octokit = connectionOctokit({ connection: "acme", projectId: "prj_1" });
    await octokit.rest.repos.get({ owner: "iterate", repo: "os" });

    expect(new URL(captured.request!.url).pathname).toBe("/repos/iterate/os");
    expect(captured.request!.headers.get("authorization")).toContain("getSecret(");
  });

  test("graphql() hits GitHub's GraphQL endpoint over the same jailed transport", async () => {
    const octokit = connectionOctokit({ connection: "acme", projectId: "prj_1" });
    const data = await octokit.graphql<{ repository: { name: string } }>(
      "query ($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { name } }",
      { owner: "iterate", repo: "iterate" },
    );

    expect(data.repository.name).toBe("iterate");
    expect(new URL(captured.request!.url).pathname).toBe("/graphql");
    expect(captured.request!.method).toBe("POST");
    expect(captured.request!.headers.get("authorization")).toContain("getSecret(");
    await expect(captured.request!.clone().json()).resolves.toMatchObject({
      variables: { owner: "iterate", repo: "iterate" },
    });
  });

  test("paginate() supports the RPC-safe route-string overload", async () => {
    const octokit = connectionOctokit({ connection: "acme", projectId: "prj_1" });
    const files = await octokit.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
      owner: "iterate",
      repo: "os",
      pull_number: 42,
    });

    expect(files).toEqual([{ filename: "apps/os/package.json" }]);
    expect(new URL(captured.request!.url).pathname).toBe("/repos/iterate/os/pulls/42/files");
    expect(captured.request!.headers.get("authorization")).toContain("getSecret(");
  });

  test("does not automatically replay a write after a 5xx", async () => {
    captured.responseStatus = 500;
    const octokit = connectionOctokit({ connection: "acme", projectId: "prj_1" });

    await expect(
      octokit.rest.issues.createComment({
        body: "one comment",
        issue_number: 42,
        owner: "iterate",
        repo: "iterate",
      }),
    ).rejects.toMatchObject({ status: 500 });
    expect(captured.requestCount).toBe(1);
  });
});
