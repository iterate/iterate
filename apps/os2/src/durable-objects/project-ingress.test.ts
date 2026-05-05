import { SELF, env } from "cloudflare:test";
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
        "mcp.demo.iterate.localhost",
        "mcp.proj_local_test.iterate.localhost",
        "mcp__demo.iterate.localhost",
        "mcp__proj_local_test.iterate.localhost",
        "streams.demo.iterate.localhost",
        "streams.proj_local_test.iterate.localhost",
        "streams__demo.iterate.localhost",
        "streams__proj_local_test.iterate.localhost",
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
      "demo.iterate.localhost",
      "mcp.demo.iterate.localhost",
      "mcp.proj_local_test.iterate.localhost",
      "mcp__demo.iterate.localhost",
      "mcp__proj_local_test.iterate.localhost",
      "proj_local_test.iterate.localhost",
      "streams.demo.iterate.localhost",
      "streams.proj_local_test.iterate.localhost",
      "streams__demo.iterate.localhost",
      "streams__proj_local_test.iterate.localhost",
    ]);
    expect(
      ingressRows.results
        .filter((row) => row.host.startsWith("streams."))
        .map((row) => JSON.parse(row.callable_json)),
    ).toEqual([
      {
        type: "fetch",
        via: {
          type: "loopback-binding",
          bindingType: "service",
          exportName: "ProjectIngressEntrypoint",
          props: { projectId: "proj_local_test" },
        },
      },
      {
        type: "fetch",
        via: {
          type: "loopback-binding",
          bindingType: "service",
          exportName: "ProjectIngressEntrypoint",
          props: { projectId: "proj_local_test" },
        },
      },
    ]);
    expect(
      ingressRows.results
        .filter((row) => row.host.startsWith("streams__"))
        .map((row) => JSON.parse(row.callable_json)),
    ).toEqual([
      {
        type: "fetch",
        via: {
          type: "loopback-binding",
          bindingType: "service",
          exportName: "ProjectIngressEntrypoint",
          props: { projectId: "proj_local_test" },
        },
      },
      {
        type: "fetch",
        via: {
          type: "loopback-binding",
          bindingType: "service",
          exportName: "ProjectIngressEntrypoint",
          props: { projectId: "proj_local_test" },
        },
      },
    ]);

    const projectResponse = await SELF.fetch("https://demo.iterate.localhost/", {
      headers: { accept: "text/html" },
    });
    expect(projectResponse.ok).toBe(true);
    const projectHtml = await projectResponse.text();
    expect(projectHtml).toContain("This request reached the Project Durable Object");
    expect(projectHtml).toContain("demo.iterate.localhost");

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
  });
});
