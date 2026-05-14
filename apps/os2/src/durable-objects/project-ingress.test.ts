import { SELF, env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, test } from "vitest";

describe("Project ingress routing", () => {
  test("routes iterate.localhost project hosts through the Project Durable Object", async () => {
    const createResponse = await SELF.fetch("https://os.iterate.localhost/__test/create-project");
    expect(createResponse.ok).toBe(true);
    await expect(createResponse.json()).resolves.toMatchObject({
      defaultHost: "demo.iterate.localhost",
      hosts: expect.arrayContaining([
        "demo.iterate.localhost",
        "proj_local_test.iterate.localhost",
        "app1.demo.iterate.localhost",
        "app1.proj_local_test.iterate.localhost",
        "app1__demo.iterate.localhost",
        "app1__proj_local_test.iterate.localhost",
        "app2.demo.iterate.localhost",
        "app2.proj_local_test.iterate.localhost",
        "app2__demo.iterate.localhost",
        "app2__proj_local_test.iterate.localhost",
        "mcp.demo.iterate.localhost",
        "mcp.proj_local_test.iterate.localhost",
        "mcp__demo.iterate.localhost",
        "mcp__proj_local_test.iterate.localhost",
      ]),
      id: "proj_local_test",
      slug: "demo",
    });

    const ingressRows = await env.DB.prepare(
      `SELECT host, project_id, callable_json
       FROM ingress_routes
       WHERE project_id = ?
       ORDER BY host ASC`,
    )
      .bind("proj_local_test")
      .all<{ host: string; project_id: string; callable_json: string }>();
    expect(ingressRows.results.map((row) => row.host)).toEqual([
      "app1.demo.iterate.localhost",
      "app1.proj_local_test.iterate.localhost",
      "app1__demo.iterate.localhost",
      "app1__proj_local_test.iterate.localhost",
      "app2.demo.iterate.localhost",
      "app2.proj_local_test.iterate.localhost",
      "app2__demo.iterate.localhost",
      "app2__proj_local_test.iterate.localhost",
      "demo.iterate.localhost",
      "mcp.demo.iterate.localhost",
      "mcp.proj_local_test.iterate.localhost",
      "mcp__demo.iterate.localhost",
      "mcp__proj_local_test.iterate.localhost",
      "proj_local_test.iterate.localhost",
    ]);
    expect(
      ingressRows.results.map((row) => ({
        host: row.host,
        exportName: (
          JSON.parse(row.callable_json) as {
            via: { exportName: string };
          }
        ).via.exportName,
      })),
    ).toEqual([
      { host: "app1.demo.iterate.localhost", exportName: "ProjectIngressEntrypoint" },
      { host: "app1.proj_local_test.iterate.localhost", exportName: "ProjectIngressEntrypoint" },
      { host: "app1__demo.iterate.localhost", exportName: "ProjectIngressEntrypoint" },
      { host: "app1__proj_local_test.iterate.localhost", exportName: "ProjectIngressEntrypoint" },
      { host: "app2.demo.iterate.localhost", exportName: "ProjectIngressEntrypoint" },
      { host: "app2.proj_local_test.iterate.localhost", exportName: "ProjectIngressEntrypoint" },
      { host: "app2__demo.iterate.localhost", exportName: "ProjectIngressEntrypoint" },
      { host: "app2__proj_local_test.iterate.localhost", exportName: "ProjectIngressEntrypoint" },
      { host: "demo.iterate.localhost", exportName: "ProjectIngressEntrypoint" },
      { host: "mcp.demo.iterate.localhost", exportName: "ProjectIngressEntrypoint" },
      { host: "mcp.proj_local_test.iterate.localhost", exportName: "ProjectIngressEntrypoint" },
      { host: "mcp__demo.iterate.localhost", exportName: "ProjectIngressEntrypoint" },
      { host: "mcp__proj_local_test.iterate.localhost", exportName: "ProjectIngressEntrypoint" },
      { host: "proj_local_test.iterate.localhost", exportName: "ProjectIngressEntrypoint" },
    ]);

    const streamResponse = await SELF.fetch("https://os.iterate.localhost/__test/project-stream");
    expect(streamResponse.ok).toBe(true);
    const streamBody = (await streamResponse.json()) as {
      events: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    expect(streamBody.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "events.iterate.com/project/created",
          payload: expect.objectContaining({
            defaultHost: "demo.iterate.localhost",
            projectId: "proj_local_test",
            slug: "demo",
          }),
        }),
      ]),
    );

    const lifecycleState = await waitForProjectLifecycleState();
    expect(lifecycleState.state.project).toMatchObject({
      defaultHost: "demo.iterate.localhost",
      projectId: "proj_local_test",
      slug: "demo",
    });
    expect(lifecycleState.reducedThroughOffset).toBeGreaterThanOrEqual(3);
    expect(lifecycleState.afterAppendCompletedThroughOffset).toBeGreaterThanOrEqual(3);

    const repoResponse = await SELF.fetch(
      "https://os.iterate.localhost/__test/iterate-config-repo",
    );
    expect(repoResponse.ok).toBe(true);
    const repo = (await repoResponse.json()) as {
      git: {
        cloneCommand: string;
        pushCommand: string;
      };
      token: string;
    };
    expect(repo).toMatchObject({
      defaultBranch: "main",
      git: expect.objectContaining({
        cloneCommand: expect.stringContaining("git -c http.extraHeader="),
        remote: "https://artifacts.example.test/proj_local_test--iterate-config.git",
      }),
      remote: "https://artifacts.example.test/proj_local_test--iterate-config.git",
      slug: "iterate-config",
      token: expect.stringContaining("mock-write-"),
    });
    expect(repo.token).toContain("?expires=");
    expect(repo.git.cloneCommand).not.toContain("?expires=");
    expect(repo.git.pushCommand).not.toContain("?expires=");

    const buildingResponse = await SELF.fetch("https://demo.iterate.localhost/");
    expect(buildingResponse.status).toBe(503);
    expect(buildingResponse.headers.get("x-project-ingress-runtime")).toBe(
      "dynamic-worker-building",
    );
    await expect(buildingResponse.text()).resolves.toBe("This worker is currently being built.");

    const projectIngressResponse = await waitForProjectIngressResponse({
      expectedText: "Bundled project worker for demo.iterate.localhost",
      url: "https://demo.iterate.localhost/",
    });
    expect(projectIngressResponse.headers.get("x-project-ingress-runtime")).toBe(
      "dynamic-worker-config-repo",
    );
    expect(projectIngressResponse.text).toBe("Bundled project worker for demo.iterate.localhost");

    const appOneDotResponse = await SELF.fetch("https://app1.demo.iterate.localhost/");
    expect(appOneDotResponse.ok).toBe(true);
    expect(appOneDotResponse.headers.get("x-project-app")).toBe("app1");
    await expect(appOneDotResponse.text()).resolves.toBe("hello from app one");

    const appOneUnderscoreResponse = await SELF.fetch("https://app1__demo.iterate.localhost/");
    expect(appOneUnderscoreResponse.ok).toBe(true);
    expect(appOneUnderscoreResponse.headers.get("x-project-app")).toBe("app1");
    await expect(appOneUnderscoreResponse.text()).resolves.toBe("hello from app one");

    const appTwoDotResponse = await SELF.fetch("https://app2.demo.iterate.localhost/");
    expect(appTwoDotResponse.ok).toBe(true);
    expect(appTwoDotResponse.headers.get("x-project-app")).toBe("app2");
    await expect(appTwoDotResponse.text()).resolves.toBe("hello from app two");

    const appTwoUnderscoreResponse = await SELF.fetch("https://app2__demo.iterate.localhost/");
    expect(appTwoUnderscoreResponse.ok).toBe(true);
    expect(appTwoUnderscoreResponse.headers.get("x-project-app")).toBe("app2");
    await expect(appTwoUnderscoreResponse.text()).resolves.toBe("hello from app two");

    const mcpResponse = await SELF.fetch("https://mcp.demo.iterate.localhost/", {
      headers: { accept: "text/html" },
    });
    expect(mcpResponse.ok).toBe(true);
    const mcpHtml = await mcpResponse.text();
    expect(mcpHtml).toContain("Connect an MCP client to this project endpoint");
    expect(mcpHtml).toContain("https://mcp.demo.iterate.localhost/");

    const fallbackMcpResponse = await SELF.fetch("https://mcp__demo.iterate.localhost/", {
      headers: { accept: "text/html" },
    });
    expect(fallbackMcpResponse.ok).toBe(true);
    const fallbackMcpHtml = await fallbackMcpResponse.text();
    expect(fallbackMcpHtml).toContain("Connect an MCP client to this project endpoint");
    expect(fallbackMcpHtml).toContain("https://mcp__demo.iterate.localhost/");

    const transport = new StreamableHTTPClientTransport(
      new URL("https://mcp.demo.iterate.localhost/"),
      {
        fetch: (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set("authorization", "Bearer project-ingress-admin-secret");
          return SELF.fetch(new Request(input, { ...init, headers }));
        },
      },
    );
    const client = new Client({ name: "project-ingress-admin-secret-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      await expect(client.listTools()).resolves.toMatchObject({
        tools: expect.arrayContaining([expect.objectContaining({ name: "exec_js" })]),
      });
    } finally {
      await client.close();
    }

    const streamsResponse = await SELF.fetch("https://streams.demo.iterate.localhost/", {
      headers: { accept: "text/html" },
    });
    expect(streamsResponse.status).toBe(404);
    expect(await streamsResponse.text()).toBe("No ingress route matched.");
  });
});

async function waitForProjectLifecycleState() {
  const deadline = Date.now() + 5_000;
  let latest: unknown;

  while (Date.now() < deadline) {
    const response = await SELF.fetch(
      "https://os.iterate.localhost/__test/project-lifecycle-state",
    );
    latest = await response.json();
    const state = latest as {
      afterAppendCompletedThroughOffset: number;
      reducedThroughOffset: number;
      state: {
        project: { projectId: string } | null;
      };
    };
    if (state.state.project?.projectId === "proj_local_test") {
      return state;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for project lifecycle state: ${JSON.stringify(latest)}`);
}

async function waitForProjectIngressResponse(input: { expectedText: string; url: string }) {
  const deadline = Date.now() + 5_000;
  let latest: unknown;

  while (Date.now() < deadline) {
    const response = await SELF.fetch(input.url);
    const text = await response.text();
    latest = {
      status: response.status,
      text,
      runtime: response.headers.get("x-project-ingress-runtime"),
    };
    if (response.ok && text === input.expectedText) {
      return {
        headers: response.headers,
        text,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for project ingress response: ${JSON.stringify(latest)}`);
}
