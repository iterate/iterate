import { describe, expect, test, vi, expectTypeOf } from "vitest";
import { CodemodeProcessorContract } from "@iterate-com/shared/stream-processors/codemode/contract";
import {
  createOsCaptunTunnel,
  createTestProjectFixture,
} from "../test-support/create-test-project.ts";

describe("e2e test map", () => {
  test("expect.getState", async () => {
    expect(expect.getState()).toMatchInlineSnapshot(`
      {
        "assertionCalls": 1,
        "currentTestName": "e2e test map > expect.getState",
        "environment": "node",
        "expectedAssertionsNumber": null,
        "expectedAssertionsNumberErrorGen": null,
        "isExpectingAssertions": false,
        "isExpectingAssertionsError": null,
        "snapshotState": SnapshotState {
          "_added": Map {},
          "_counters": Map {
            "e2e test map > expect.getState" => 1,
          },
          "_dirty": false,
          "_environment": VitestNodeSnapshotEnvironment {
            "options": {},
          },
          "_fileExists": false,
          "_initialData": {},
          "_inlineSnapshotStacks": [],
          "_inlineSnapshots": [],
          "_matched": Map {},
          "_rawSnapshots": [],
          "_snapshotData": {},
          "_snapshotFormat": {
            "escapeString": false,
            "printBasicPrototype": false,
          },
          "_testIdToKeys": Map {
            "1423330272_0_0" => [
              "e2e test map > expect.getState 1",
            ],
          },
          "_uncheckedKeys": Set {},
          "_unmatched": Map {},
          "_updateSnapshot": "new",
          "_updated": Map {},
          "expand": false,
          "snapshotPath": "/Users/mmkal/src/iterate/apps/os/e2e/vitest/__snapshots__/e2e-test-map.e2e.test.ts.snap",
          "testFilePath": "/Users/mmkal/src/iterate/apps/os/e2e/vitest/e2e-test-map.e2e.test.ts",
        },
        "testPath": "/Users/mmkal/src/iterate/apps/os/e2e/vitest/e2e-test-map.e2e.test.ts",
      }
    `);
  });
  test("can connect to MCP with admin token", async () => {
    // run pnpm cli claude-mcp which prints how to run claude w/ an admin token from doppler
    // doppler run --config prd -- pnpm cli claude-mcp
    /**
     * - MCP e2e
    - I can connect to MCP with admin token
        - `pnpm cli claude-mcp` script in apps/os/scripts that starts claude and points it at an MCP server using an admin token from doppler
    - I can connect to MCP via oauth flow (requires playwright + MCP inspector or something)
    - Normally what I do is run the “**RPC capability tour”** or similar through `exec_js` with a codemode block
    - The largest surface area of all would be exposed if you prompted claude to “Start a subagent using ctx.agents.create() and ask it to do something for you and wait for the response”
    - After the MCP client connects, this can all be expressed as append and waitForEvent on streams!
     */
  });

  test("type inference for codemode script results", async () => {
    await using fixture = await createTestProjectFixture();

    const result = await fixture.executeCodemodeScript(async () => {
      return { foo: "bar" };
    });
    expectTypeOf(result.success()).toMatchObjectType<{ foo: string }>();
    expect(result.success()).toMatchObject({ foo: "bar" });
  });

  test("secret-substitution: secret", async () => {
    await using fixture = await createTestProjectFixture({
      egressFetch: async (request) => {
        const url = new URL(request.url);
        return Response.json({
          hostname: url.hostname,
          pathname: url.pathname,
          authHeader: request.headers.get("authorization"),
        });
      },
    });

    await fixture.os.project.secrets.upsert({
      projectSlugOrId: fixture.project.slug,
      key: "blabla",
      material: "codemode-secret-value",
    });

    const result = await fixture.executeCodemodeScript(async () => {
      const response = await fetch("https://httpbin.org/anything", {
        headers: { Authorization: "Bearer getSecret({key:'blabla'})" },
      });
      return response.json();
    });
    expect(result.success()).toMatchObject({
      authHeader: expect.stringMatching(/Bearer Secret value withheld .* Requested .*blabla/),
    });
  });

  test.todo("secret-substitution: secret", async () => {
    // like the above, but create a public tunnel to make sure actual secret substitution happens
  });

  test("openapi codemode tool provider petstore", async () => {
    await using fixture = await createTestProjectFixture({
      processors: [CodemodeProcessorContract],
    });

    await fixture.append({
      event: {
        type: "events.iterate.com/codemode/tool-provider-registered",
        payload: {
          instructions:
            "Use ctx.petstore to call the OpenAPI service at https://petstore.swagger.io/v2. Call listOperations() first to inspect available operations.",
          invocation: {
            callable: {
              type: "workers-rpc",
              via: {
                type: "loopback-binding",
                bindingType: "service",
                exportName: "OpenApiBridge",
                props: {
                  baseUrl: "https://petstore.swagger.io/v2",
                  specUrl: "https://petstore.swagger.io/v2/swagger.json",
                },
              },
              rpcMethod: "executeCodemodeFunctionCall",
              argsMode: "object",
            },
            kind: "rpc",
          },
          path: ["petstore"],
        },
      },
    });

    const result = await fixture.executeCodemodeScript(async (ctx: any) => {
      return ctx.petstore.getInventory();
    });

    expect(result.success()).toMatchObject({
      available: expect.any(Number),
      pending: expect.any(Number),
      sold: expect.any(Number),
    });
  });

  test("third party mcp and call tools", async () => {
    using mcpTunnel = await createOsCaptunTunnel({
      fetch: createTestMcpServerFetch(),
    });
    await using fixture = await createTestProjectFixture({
      processors: [CodemodeProcessorContract],
    });

    await fixture.append({
      event: {
        type: "events.iterate.com/codemode/tool-provider-registered",
        payload: {
          instructions:
            "Use ctx.mcp.publicTunnelSearch for test web search. Call ctx.mcp.publicTunnelSearch.listTools() to inspect available tools, then call ctx.mcp.publicTunnelSearch.web_search_exa({ query, numResults }).",
          invocation: {
            kind: "rpc",
            callable: {
              type: "workers-rpc",
              via: {
                type: "env-binding",
                bindingType: "durable-object-namespace",
                bindingName: "OUTBOUND_MCP_FROM_OUR_CLIENT_CAPABILITY",
                durableObject: {
                  name: JSON.stringify({
                    headers: {},
                    serverUrl: `${mcpTunnel.url}/mcp`,
                  }),
                },
              },
              rpcMethod: "executeCodemodeFunctionCall",
              argsMode: "object",
            },
          },
          path: ["mcp", "publicTunnelSearch"],
        },
      },
    });

    const result = await fixture.executeCodemodeScript(async (ctx: any) => {
      const tools = await ctx.mcp.publicTunnelSearch.listTools();
      const search = await ctx.mcp.publicTunnelSearch.web_search_exa({
        numResults: 2,
        query: "public tunnel mcp",
      });
      return { search, tools };
    });

    expect(result.success()).toMatchObject({
      search: {
        numResults: 2,
        query: "public tunnel mcp",
        result: "search result",
      },
      tools: {
        tools: [
          expect.objectContaining({
            description: "Search the web",
            name: "web_search_exa",
          }),
        ],
      },
    });
  });

  test("can use orpc os.project.* tools", async () => {
    await using fixture = await createTestProjectFixture({});

    const result = await fixture.executeCodemodeScript(async (ctx: any) => {
      const projects = await ctx.os.__internal.health();
      return projects;
    });

    expect(result.success()).toMatchObject({
      ok: true,
      app: "os",
      version: expect.any(String),
    });
  });

  test("can use arbitrary replicate model via ctx.ai", async () => {
    await using fixture = await createTestProjectFixture({});

    const result = await fixture.executeCodemodeScript(async (ctx: any) => {
      const ai = await ctx.ai.run("replicate/llama-3.1-8b-instruct", {
        prompt: "What is one plus two",
      });
      return { ai };
    });

    expect(result.success()).toMatchObject({
      ai: expect.objectContaining({
        response: expect.stringMatching(/3|three/),
      }),
    });
  });

  test("promise pipelining", async () => {
    await using fixture = await createTestProjectFixture({});

    const result = await fixture.executeCodemodeScript(async (ctx: any) => {
      // look ma, no intermediate await!
      await ctx.repos.get({ slug: "iterate-config" }).getInfo();
    });

    expect(result.success()).toMatchObject({
      ok: true,
      slug: "iterate-config",
      defaultBranch: "main",
      hasToken: true,
    });
  });

  test("can use workspace tools", async () => {
    await using fixture = await createTestProjectFixture({});

    await fixture.executeCodemodeScript(async (ctx: any) => {
      await ctx.workspace.writeFile("greeting.txt", "hiya");
    });

    const result = await fixture.executeCodemodeScript(async (ctx: any) => {
      const text = await ctx.workspace.readFile("greeting.txt");
      return { text };
    });

    expect(result.success()).toMatchObject({
      text: "hiya",
    });
  });

  test("workspace can clone public github repo", async () => {
    await using fixture = await createTestProjectFixture({});

    await fixture.executeCodemodeScript(async (ctx: any) => {
      await ctx.workspace.git.clone({
        url: "https://github.com/iterate/captun.git",
      });
    });
  });

  test("can update iterate config repo via workspace", async () => {
    await using fixture = await createTestProjectFixture({});

    await fixture.executeCodemodeScript(async (ctx: any) => {
      await ctx.workspace.writeFile("iterate.config.ts", '{\n  "version": 1\n}\n');
      await ctx.workspace.git.commit({
        message: "Update iterate config",
      });
      await ctx.workspace.git.push();
    });

    const result = await fixture.executeCodemodeScript(async (ctx: any) => {
      const repo = await ctx.repos.get({ slug: "iterate-config" }).getInfo();
      return repo;
    });

    expect(result.success()).toMatchObject({
      slug: "iterate-config",
    });
  });

  test("tru e2e", async () => {
    await using fixture = await createTestProjectFixture({});

    // await fixture.waitToBeRoutable(); // wait for cname record event
    // true-e2e__${projectSlug}.iterate.app is routable immediately

    await fixture.executeCodemodeScript(async (ctx: any) => {
      await ctx.workspace.writeFile(
        "worker.js",
        "export default {\n  fetch: async () => new Response('hello from app one')\n}\n",
      );
      await ctx.workspace.git.add({ filepath: "worker.js" });
      await ctx.workspace.git.commit({
        message: "Add worker.js",
      });
      await ctx.workspace.git.push();
    });

    const getHtml = async () => {
      const res = await fetch(`https://true-e2e__${fixture.project.slug}.iterate.app`);
      if (!res.ok) throw new Error("not ok (yet?)");
      const html = await res.text();
      if (!html.includes("hello from app one"))
        throw new Error("not the expected html (yet?). Got: " + html);
      return html;
    };
    await vi.waitFor(getHtml); // right now we poll for pushes every ten seconds
    const html = await getHtml();
    expect(html).toContain("hello from app one");
  });

  // now do the above but with cname record
});

describe("ai tests", async () => {
  // https://www.notion.so/nustom/E2E-test-map-366622a338eb8053984fc756cae2abd2 /agents/e2e-blabla

  test("can use ai", async () => {
    await using fixture = await createTestProjectFixture({});

    // append export function defaultAgentSetupEvents but that's bad and janky
    const result = await fixture.executeCodemodeScript(async (ctx: any) => {
      const ai = await ctx.ai.run("replicate/llama-3.1-8b-instruct", {
        prompt: "What is one plus two",
      });
      return { ai };
    });

    expect(result.success()).toMatchObject({
      ai: expect.anything(),
    });
  });
});

function createTestMcpServerFetch() {
  return async (request: Request) => {
    if (request.method === "GET") return new Response(null, { status: 405 });
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const body = (await request.json()) as {
      id?: number | string;
      method?: string;
      params?: {
        arguments?: Record<string, unknown>;
        name?: string;
      };
    };

    if (body.method === "initialize") {
      return Response.json({
        id: body.id,
        jsonrpc: "2.0",
        result: {
          capabilities: { tools: {} },
          protocolVersion: "2025-11-25",
          serverInfo: { name: "e2e-public-tunnel-mcp", version: "1.0.0" },
        },
      });
    }

    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }

    if (body.method === "tools/list") {
      return Response.json({
        id: body.id,
        jsonrpc: "2.0",
        result: {
          tools: [
            {
              description: "Search the web",
              inputSchema: {
                properties: {
                  numResults: { type: "number" },
                  query: { type: "string" },
                },
                required: ["query", "numResults"],
                type: "object",
              },
              name: "web_search_exa",
            },
          ],
        },
      });
    }

    if (body.method === "tools/call" && body.params?.name === "web_search_exa") {
      const structuredContent = {
        numResults: body.params.arguments?.numResults,
        query: body.params.arguments?.query,
        result: "search result",
      };
      return Response.json({
        id: body.id,
        jsonrpc: "2.0",
        result: {
          content: [{ text: JSON.stringify(structuredContent), type: "text" }],
          structuredContent,
        },
      });
    }

    return Response.json({
      error: { code: -32601, message: "Method not found" },
      id: body.id,
      jsonrpc: "2.0",
    });
  };
}
