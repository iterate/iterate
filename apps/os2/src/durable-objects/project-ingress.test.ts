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
      { host: "demo.iterate.localhost", exportName: "ProjectIngressEntrypoint" },
      { host: "mcp.demo.iterate.localhost", exportName: "ProjectIngressEntrypoint" },
      { host: "mcp.proj_local_test.iterate.localhost", exportName: "ProjectIngressEntrypoint" },
      { host: "mcp__demo.iterate.localhost", exportName: "ProjectIngressEntrypoint" },
      { host: "mcp__proj_local_test.iterate.localhost", exportName: "ProjectIngressEntrypoint" },
      { host: "proj_local_test.iterate.localhost", exportName: "ProjectIngressEntrypoint" },
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
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "run_code" }),
          expect.objectContaining({ name: "reveal_secret" }),
        ]),
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
