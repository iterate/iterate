import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { x } from "tinyexec";
import { describe, expect, test, vi, expectTypeOf } from "vitest";
import { z } from "zod";
import { CodemodeProcessorContract } from "@iterate-com/shared/stream-processors/codemode/contract";
import { createExampleRpcProviderRegistration } from "../../src/domains/codemode/example-provider-registrations.ts";
import {
  createPublicTunnel,
  createTestProjectFixture,
} from "../test-support/create-test-project.ts";

describe("e2e test map", () => {
  test.todo("can connect to MCP with admin token", async () => {
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

    const result = await fixture.codemode.execute(async () => {
      return { foo: "bar" };
    });
    expectTypeOf(result.success()).toMatchObjectType<{ foo: string }>();
    expect(result.success()).toMatchObject({ foo: "bar" });
  });

  test("secret-substitution: egress intercept", async () => {
    await using fixture = await createTestProjectFixture({
      egressFetch: async (request) => {
        return Response.json({
          authHeader: request.headers.get("authorization"),
        });
      },
    });

    await fixture.os.project.secrets.upsert({
      projectSlugOrId: fixture.project.slug,
      key: "blabla",
      material: "codemode-secret-value",
    });

    const result = await fixture.codemode.execute(async () => {
      const response = await fetch("https://httpbin.org/anything", {
        headers: { Authorization: "Bearer getSecret('blabla')" },
      });
      return response.json();
    });
    expect(result.success()).toMatchObject({
      authHeader: expect.stringMatching(/Bearer Secret value withheld .* Requested .*blabla/),
    });
  });

  test("secret-substitution: public tunnel", async () => {
    await using fixture = await createTestProjectFixture();
    using publicTunnel = await createPublicTunnel({
      fetch: (request) => {
        return Response.json({
          authHeader: request.headers.get("authorization"),
        });
      },
    });

    await fixture.os.project.secrets.upsert({
      projectSlugOrId: fixture.project.slug,
      key: "blabla",
      material: "codemode-secret-value",
    });

    const result = await fixture.codemode
      .var("PUBLIC_TUNNEL_URL", publicTunnel.url)
      .execute(async (ctx) => {
        const response = await fetch(`${ctx.codemode.vars.PUBLIC_TUNNEL_URL}/anything`, {
          headers: { Authorization: "Bearer getSecret('blabla')" },
        });
        return response.json();
      });
    expect(result.success()).toEqual({
      authHeader: "Bearer codemode-secret-value",
    });
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

    const result = await fixture.codemode
      .context<{ petstore: { getInventory: () => Promise<unknown> } }>()
      .execute(async (ctx) => {
        return ctx.petstore.getInventory();
      });

    expect(result.success()).toMatchObject({
      available: expect.any(Number),
      sold: expect.any(Number),
    });
  });

  test("third party mcp and call tools", async () => {
    const mcpServer = new McpServer({
      name: "e2e-public-tunnel-mcp",
      version: "1.0.0",
    });
    mcpServer.registerTool(
      "my_funky_search",
      { description: "Search the web", inputSchema: { query: z.string() } },
      ({ query }) => {
        const data = { result: `search result for ${query}` };
        return {
          content: [{ text: JSON.stringify(data), type: "text" }],
          structuredContent: data,
        };
      },
    );
    const mcpTransport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: () => crypto.randomUUID(),
    });
    await mcpServer.connect(mcpTransport);
    await using _mcpConnection = {
      async [Symbol.asyncDispose]() {
        await mcpServer.close();
      },
    };
    using mcpTunnel = await createPublicTunnel({
      fetch: (request) => mcpTransport.handleRequest(request),
    });
    await using fixture = await createTestProjectFixture({
      processors: [CodemodeProcessorContract],
    });

    await fixture.append({
      event: {
        type: "events.iterate.com/codemode/tool-provider-registered",
        payload: {
          instructions:
            "Use ctx.mcp.publicTunnelSearch for test web search. Call ctx.mcp.publicTunnelSearch.listTools() to inspect available tools, then call ctx.mcp.publicTunnelSearch.my_funky_search({ query }).",
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

    const result = await fixture.codemode
      .context<{
        mcp: {
          publicTunnelSearch: {
            listTools: () => Promise<{ tools: unknown[] }>;
            my_funky_search: (input: { query: string }) => Promise<unknown>;
          };
        };
      }>()
      .execute(async (ctx) => {
        const { tools } = await ctx.mcp.publicTunnelSearch.listTools();
        const search = await ctx.mcp.publicTunnelSearch.my_funky_search({ query: "abc123" });
        return { tools, search };
      });

    expect(result.success()).toMatchObject({
      tools: [{ description: "Search the web", name: "my_funky_search" }],
      search: { result: "search result for abc123" },
    });
  });

  test("can use orpc os.project.* tools", async () => {
    await using fixture = await createTestProjectFixture({
      processors: [CodemodeProcessorContract],
    });

    await fixture.append({
      event: {
        type: "events.iterate.com/codemode/tool-provider-registered",
        payload: createExampleRpcProviderRegistration({
          exportName: "OrpcCapability",
          instructions: "Use ctx.os.project for project-scoped OS APIs.",
          path: ["os", "project"],
          projectId: fixture.project.id,
        }),
      },
    });

    const result = await fixture.codemode.execute(async (ctx) => {
      return await ctx.os.project.get({});
    });

    expect(result.success()).toMatchObject({
      id: fixture.project.id,
      slug: fixture.project.slug,
    });
  });

  test("can use Workers AI via ctx.ai", async () => {
    await using fixture = await createTestProjectFixture({
      processors: [CodemodeProcessorContract],
    });

    await fixture.append({
      event: {
        type: "events.iterate.com/codemode/tool-provider-registered",
        payload: createExampleRpcProviderRegistration({
          exportName: "AiCapability",
          instructions: "Use ctx.ai.run(model, input) to call the Workers AI binding.",
          path: ["ai"],
          projectId: fixture.project.id,
        }),
      },
    });

    const result = await fixture.codemode.execute(async (ctx) => {
      const ai = await ctx.ai.run("@cf/meta/llama-3.1-8b-instruct", {
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
    await using fixture = await createTestProjectFixture({
      processors: [CodemodeProcessorContract],
    });

    await fixture.append({
      event: {
        type: "events.iterate.com/codemode/tool-provider-registered",
        payload: createExampleRpcProviderRegistration({
          exportName: "ReposCapability",
          instructions:
            "Use ctx.repos.create({ slug }) to create a Repo, ctx.repos.get({ slug }).getInfo() to inspect one, and ctx.repos.list({}) to list Repos.",
          path: ["repos"],
          projectId: fixture.project.id,
        }),
      },
    });

    const result = await fixture.codemode.execute(async (ctx) => {
      const slug = `pipeline-${Date.now()}`;
      // look ma, no intermediate await!
      return await ctx.repos.create({ slug }).getInfo();
    });

    expect(result.success()).toMatchObject({
      defaultBranch: "main",
      slug: expect.stringMatching(/^pipeline-/),
    });
  });

  test("can use workspace tools", async () => {
    await using fixture = await createTestProjectFixture({});

    await fixture.codemode.execute(async (ctx) => {
      await ctx.workspace.writeFile("greeting.txt", "hiya");
    });

    const result = await fixture.codemode.execute(async (ctx) => {
      const text = await ctx.workspace.readFile("greeting.txt");
      return { text };
    });

    expect(result.success()).toMatchObject({
      text: "hiya",
    });
  });

  test("workspace can clone public github repo", async () => {
    await using fixture = await createTestProjectFixture({});

    const result = await fixture.codemode.execute(async (ctx) => {
      await ctx.workspace.git.clone({
        dir: "/captun",
        depth: 1,
        url: "https://github.com/iterate/captun.git",
      });
      return await ctx.workspace.readFile("/captun/package.json");
    });

    expect(result.success()).toContain(`"name": "captun"`);
  });

  test("codemode-create repo can be cloned as normal", async () => {
    await using fixture = await createTestProjectFixture({
      processors: [CodemodeProcessorContract],
    });
    const proof = `normal git proof for ${fixture.project.slug}`;

    await fixture.append({
      event: {
        type: "events.iterate.com/codemode/tool-provider-registered",
        payload: createExampleRpcProviderRegistration({
          exportName: "ReposCapability",
          instructions:
            "Use ctx.repos.create({ slug }) to create a Repo, ctx.repos.get({ slug }).getInfo() to inspect one, and ctx.repos.list({}) to list Repos.",
          path: ["repos"],
          projectId: fixture.project.id,
        }),
      },
    });

    const created = await fixture.codemode.execute(async (ctx) => {
      const repo = await ctx.repos.create({ slug: "codemode-create-repo" }).getInfo();

      await ctx.workspace.git.clone({
        url: repo.remote,
        dir: "/codemode-create-repo",
        branch: repo.defaultBranch,
        depth: 1,
        ...repo.credentials,
      });

      return {
        initialReadme: await ctx.workspace.readFile("/codemode-create-repo/README.md"),
        repo,
        status: await ctx.workspace.git.status({ dir: "/codemode-create-repo" }),
      };
    });

    expect(created.success()).toMatchObject({
      initialReadme: expect.stringContaining(`Project ID: ${fixture.project.id}`),
      repo: {
        defaultBranch: "main",
        slug: "codemode-create-repo",
      },
      status: [],
    });

    await using temp = await createTempDirectory("os-codemode-repo-");
    const localRepoDir = join(temp.path, "codemode-create-repo");
    const repo = created.success().repo;
    const authHeader = repo.git.authorizationHeader;

    await gitLocalCli({
      args: ["-c", `http.extraHeader=${authHeader}`, "clone", repo.remote, localRepoDir],
      cwd: temp.path,
    });
    await writeFile(join(localRepoDir, "normal-git-proof.txt"), proof);
    await gitLocalCli({
      args: ["-C", localRepoDir, "add", "normal-git-proof.txt"],
      cwd: temp.path,
    });
    await gitLocalCli({
      args: [
        "-C",
        localRepoDir,
        "-c",
        "user.name=Codemode E2E",
        "-c",
        "user.email=codemode-e2e@iterate.com",
        "commit",
        "-m",
        "Add normal git proof",
      ],
      cwd: temp.path,
    });
    await gitLocalCli({
      args: [
        "-C",
        localRepoDir,
        "-c",
        `http.extraHeader=${authHeader}`,
        "push",
        "origin",
        repo.defaultBranch,
      ],
      cwd: temp.path,
    });

    expect(await readFile(join(localRepoDir, "normal-git-proof.txt"), "utf8")).toBe(proof);
    expect(
      await gitLocalCli({ args: ["-C", localRepoDir, "status", "--short"], cwd: temp.path }),
    ).toBe("");

    const pulled = await fixture.codemode.execute(async (ctx) => {
      const repo = await ctx.repos.get({ slug: "codemode-create-repo" }).getInfo();
      const pull = await ctx.workspace.git.pull({
        dir: "/codemode-create-repo",
        remote: "origin",
        ref: repo.defaultBranch,
        author: { name: "Codemode", email: "codemode@iterate.com" },
        ...repo.credentials,
      });

      return {
        proof: await ctx.workspace.readFile("/codemode-create-repo/normal-git-proof.txt"),
        pull,
        status: await ctx.workspace.git.status({ dir: "/codemode-create-repo" }),
      };
    });

    expect(pulled.success()).toMatchObject({
      proof,
      pull: { pulled: true },
      status: [],
    });
  });

  test("can update iterate config repo via workspace", async () => {
    await using fixture = await createTestProjectFixture({
      processors: [CodemodeProcessorContract],
    });

    await fixture.append({
      event: {
        type: "events.iterate.com/codemode/tool-provider-registered",
        payload: createExampleRpcProviderRegistration({
          exportName: "ReposCapability",
          instructions:
            "Use ctx.repos.ensureIterateConfigInfo({ projectSlug }) to create or inspect the iterate-config Repo, ctx.repos.create({ slug }) to create a Repo, ctx.repos.get({ slug }).getInfo() to inspect one, and ctx.repos.list({}) to list Repos.",
          path: ["repos"],
          projectId: fixture.project.id,
        }),
      },
    });

    const result = await fixture.codemode.execute(async (ctx) => {
      const proof = `hello from iterate config ${Date.now()}`;
      const repo = await ctx.repos.ensureIterateConfigInfo({ projectSlug: null });
      const dir = `/iterate-config-${Date.now()}`;

      await ctx.workspace.git.clone({
        url: repo.remote,
        dir,
        branch: repo.defaultBranch,
        depth: 1,
        ...repo.credentials,
      });

      await ctx.workspace.writeFile(
        `${dir}/worker.js`,
        `export default { async fetch() { return new Response(${JSON.stringify(proof)}, { headers: { "content-type": "text/html" } }) } }\n`,
      );
      await ctx.workspace.git.add({ dir, filepath: "worker.js" });
      const commit = await ctx.workspace.git.commit({
        dir,
        message: "Update iterate config",
        author: { name: "Codemode", email: "codemode@iterate.com" },
      });
      const pushed = await ctx.workspace.git.push({
        dir,
        remote: "origin",
        ref: repo.defaultBranch,
        ...repo.credentials,
      });

      return {
        commit,
        proof,
        pushed,
        repo: {
          defaultBranch: repo.defaultBranch,
          slug: repo.slug,
        },
        status: await ctx.workspace.git.status({ dir }),
      };
    });

    expect(result.success()).toMatchObject({
      commit: { oid: expect.any(String) },
      repo: {
        defaultBranch: "main",
        slug: "iterate-config",
      },
      status: [],
    });

    const proof = result.success().proof;
    const getHtml = async () => {
      const response = await fetch(fixture.project.ingressUrl);
      if (!response.ok) throw new Error(`not ok (yet?): ${response.status}`);
      const html = await response.text();
      if (!html.includes(proof)) {
        throw new Error(`not the expected html (yet?). Got: ${html}`);
      }
      return html;
    };
    await vi.waitFor(getHtml, { timeout: 15_000 });
  });
});

async function createTempDirectory(prefix: string) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return {
    path,
    async [Symbol.asyncDispose]() {
      await rm(path, { force: true, recursive: true });
    },
  };
}

async function gitLocalCli(input: { args: string[]; cwd: string }) {
  const result = await x("git", input.args, {
    throwOnError: true,
    nodeOptions: {
      cwd: input.cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
      stdio: "pipe",
    },
  });
  return result.stdout.trim();
}
