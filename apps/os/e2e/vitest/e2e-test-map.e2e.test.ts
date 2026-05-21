import { describe, expect, test, vi } from "vitest";
import { CodemodeProcessorContract } from "@iterate-com/shared/stream-processors/codemode/contract";
import { env } from "@opentui/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import dedent from "dedent";
import { createTestProjectFixture } from "../test-support/create-test-project";

describe("e2e test map", () => {
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

  test("secret-substitution: secret", async () => {
    const fixture = await createTestProjectFixture();

    await fixture.os.project.secrets.upsert({
      projectSlugOrId: fixture.project.slug,
      key: "openai",
      material: "codemode-secret-value",
    });

    const result = await fixture.executeCodemodeScript(async (ctx) => {
      const response = await fetch("httpbin.org/anything", {
        headers: { Authorization: "Bearer getSecret('blabla')" },
      });
      return response.headers;
    });
    expect(result.success()).toMatchObject({
      authorization: "Bearer notReallyTheSecretValue('codemode-secret-value')", // or "Secret value withheld because this Project Egress Intercept Tunnel is active. Requested"
    });
  });

  test("openapi codemode tool provider", async () => {
    const fixture = await createTestProjectFixture({
      slugPrefix: "openapi-codemode-tool-provider-test",
      processors: [CodemodeProcessorContract],
    });

    // const path = fixture.createStreamPath(); // gives us a new path that follows the pattern of artifacts in temp folder
    // `${vitestRunId}/${testFileRelativePath}/${describeSlug}/${testSlug}`

    await fixture.client.project.streams.append({
      projectSlugOrId: fixture.project.slug,
      streamPath: fixture.streamPath,
      event: fixture.event({
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
        idempotencyKey: "codemode:tool-provider-registered:petstore",
        offset: 11,
        createdAt: "2026-05-21T13:00:52.058Z",
      }),
    });

    // fixture.append({
    //   streamPath: "...",
    //   event: {
    //     type: // narrowed type
    //   }
    // })

    // const { appendedEvent, events, matchedEvent } = await fixture.appendAndWaitForEvent({
    //   streamPath: "...",
    //   event: {
    //     type: // narrowed type
    //   },
    //   predicate: (event, {appendedEvent}) => event.type === 'foo' && event.payload.requestId === appendedEvent.payload.requestId // narrowed type
    // })
  });

  test("third party mcp and call tools", async () => {
    const mcpServer = createMcpServer({
      tools: [
        {
          name: "web_search_exa",
          description: "Search the web",
          inputSchema: z.object({
            query: z.string(),
            numResults: z.number(),
          }),
          execute: async ({ query, numResults }) => {
            return { result: "search result" };
          },
        },
      ],
    });
    using fixture = await createTestProjectFixture({
      egressFetch: async (request) => {
        const url = new URL(request.url);
        if (url.hostname === "mcp.example.com") {
          return await mcpServer.fetch(request);
        }

        return await mcpServer.fetch(request);
      },
    });

    await fixture.append({
      type: "events.iterate.com/codemode/tool-provider-registered",
      payload: {
        instructions:
          "Use ctx.mcp.exa for Exa web search. Call ctx.mcp.exa.listTools() to inspect available tools, then call tools such as ctx.mcp.exa.web_search_exa({ query, numResults }) or ctx.mcp.exa.web_fetch_exa({ urls }).",
        invocation: {
          kind: "rpc",
          callable: {
            type: "workers-rpc",
            via: {
              type: "env-binding",
              bindingType: "durable-object-namespace",
              bindingName: "OUTBOUND_MCP_FROM_OUR_CLIENT_CAPABILITY",
              durableObject: {
                name: '{"serverUrl":"https://mcp.exa.ai/mcp","headers":{}}',
              },
            },
            rpcMethod: "executeCodemodeFunctionCall",
            argsMode: "object",
          },
        },
        path: ["mcp", "exa"],
      },
      idempotencyKey: "codemode:tool-provider-registered:mcp/exa",
      offset: 9,
      createdAt: "2026-05-21T13:00:51.993Z",
    });

    await fixture.executeCodemodeScript(async (ctx) => {
      const tools = await ctx.mcp.exa.listTools();
      return tools;
    });
  });

  test("can use orpc os.project.* tools", async () => {
    await using fixture = await createTestProjectFixture({});

    await fixture.executeCodemodeScript(async (ctx: any) => {
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

    test("tru e2e", async () => {
      await using fixture = await createTestProjectFixture({});

      // await fixture.waitToBeRoutable(); // wait for cname record event
      // true-e2e__${projectSlug}.iterate.app is routable immediately

      await fixture.executeCodemodeScript(async (ctx: any) => {
        const repo = await ctx.repos.get({ slug: "iterate-config" }).getInfo();
        const dir = `/iterate-config-${Date.now()}`;
        const fileName = `workspace-demo-${Date.now()}.md`;
        const password = repo.token.includes("?expires=")
          ? repo.token.split("?expires=")[0]
          : repo.token;
        const auth = { username: "x", password };

        // maybe not needed these days
        // await ctx.workspace.git.clone({
        //   url: repo.remote,
        //   dir,
        //   branch: repo.defaultBranch,
        //   depth: 1,
        //   ...auth,
        // });

        await ctx.workspace.writeFile(
          "worker.js",
          dedent`
            export default {
              fetch: async request => new Response('hello from app one')
            }
          `,
        );
        await ctx.workspace.git.add({ filepath: "worker.js" });
        await ctx.workspace.git.commit({
          message: "Add worker.js",
        });
        await ctx.workspace.git.push();
        // await ctx.workspace.writeFile(
        //   `${dir}/${fileName}`,
        //   `# Workspace codemode proof\n\nCreated: ${new Date().toISOString()}\n`,
        // );
        // await ctx.workspace.git.add({ dir, filepath: fileName });
        // const commit = await ctx.workspace.git.commit({
        //   dir,
        //   message: "Verify workspace codemode push",
        //   author: { name: "Codemode", email: "codemode@iterate.com" },
        // });
        // const pushed = await ctx.workspace.git.push({
        //   dir,
        //   remote: "origin",
        //   ref: repo.defaultBranch,
        //   ...auth,
        // });

        // return {
        //   commit,
        //   fileName,
        //   pushed,
        //   status: await ctx.workspace.git.status({ dir }),
        // };
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
  });
});
