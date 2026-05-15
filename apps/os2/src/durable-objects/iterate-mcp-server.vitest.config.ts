import { createRequire } from "node:module";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultExclude, defineConfig } from "vitest/config";

const appRoot = process.env.OS2_ITERATE_MCP_SERVER_TEST_APP_ROOT ?? process.cwd();
const repoRoot = resolve(appRoot, "../..");
const testRoot = fileURLToPath(new URL(".", import.meta.url));
const cloudflareVitestPath = resolve(
  repoRoot,
  "packages/shared/node_modules/@cloudflare/vitest-pool-workers/dist/pool/index.mjs",
);
const cloudflareVitest = await import(pathToFileURL(cloudflareVitestPath).href);
const requireFromCloudflareVitest = createRequire(cloudflareVitestPath);
const miniflare = await import(
  pathToFileURL(requireFromCloudflareVitest.resolve("miniflare")).href
);

const mockProviderServer = await startProviderMatrixMockServer();
process.on("beforeExit", () => {
  void mockProviderServer.close();
});

async function startProviderMatrixMockServer() {
  const entries: HarEntry[] = [];
  const server = createServer(async (request, response) => {
    const startedAt = new Date().toISOString();
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const requestBody = Buffer.concat(chunks).toString("utf8");

    const requestUrl = new URL(request.url ?? "/", baseUrl);
    const result = await handleProviderMatrixMockRequest({
      body: requestBody,
      method: request.method ?? "GET",
      url: requestUrl,
    });
    writeJsonResponse(response, result.status, result.body);
    entries.push({
      request: {
        method: request.method ?? "GET",
        postData: requestBody ? { text: requestBody } : undefined,
        url: requestUrl.toString(),
      },
      response: {
        status: result.status,
      },
      startedDateTime: startedAt,
      time: 0,
    });
  });

  await new Promise<void>((resolveListening) => {
    server.listen(0, "127.0.0.1", () => resolveListening());
  });
  const address = server.address();
  if (address == null || typeof address === "string") {
    throw new Error("Provider matrix mock server did not bind a TCP port.");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
    getHar: () => ({
      log: {
        creator: { name: "iterate-os2-provider-matrix-test", version: "1.0.0" },
        entries,
        version: "1.2",
      },
    }),
    url: baseUrl,
  };
}

type HarEntry = {
  request: {
    method: string;
    postData?: { text: string };
    url: string;
  };
  response: {
    status: number;
  };
  startedDateTime: string;
  time: number;
};

async function handleProviderMatrixMockRequest(input: { body: string; method: string; url: URL }) {
  if (input.method === "GET" && input.url.pathname === "/openapi.json") {
    return jsonResult(200, {
      info: { title: "Provider Matrix API", version: "1.0.0" },
      openapi: "3.1.0",
      paths: {
        "/pets/{petId}": {
          get: {
            operationId: "getPet",
            parameters: [
              { in: "path", name: "petId", required: true, schema: { type: "string" } },
              { in: "query", name: "include", schema: { type: "string" } },
            ],
            summary: "Get a pet",
          },
        },
      },
    });
  }

  const petMatch = input.url.pathname.match(/^\/pets\/([^/]+)$/);
  if (input.method === "GET" && petMatch) {
    const petId = decodeURIComponent(petMatch[1] ?? "");
    return jsonResult(200, {
      include: input.url.searchParams.get("include"),
      name: `Pet ${petId.toUpperCase()}`,
      petId,
      provider: "openapi",
    });
  }

  if (input.method === "GET" && input.url.pathname === "/mcp") {
    return jsonResult(405, null);
  }

  if (input.method === "POST" && input.url.pathname === "/mcp") {
    const body = JSON.parse(input.body) as {
      id?: number;
      method?: string;
      params?: { arguments?: Record<string, unknown> };
    };

    if (body.method === "initialize") {
      return jsonResult(200, {
        id: body.id,
        jsonrpc: "2.0",
        result: {
          capabilities: { tools: {} },
          protocolVersion: "2025-11-25",
          serverInfo: { name: "mock-public-mcp", version: "1.0.0" },
        },
      });
    }

    if (body.method === "notifications/initialized") {
      return jsonResult(202, null);
    }

    if (body.method === "tools/list") {
      return jsonResult(200, {
        id: body.id,
        jsonrpc: "2.0",
        result: {
          tools: [
            {
              description: "Echo text",
              inputSchema: { properties: { text: { type: "string" } }, type: "object" },
              name: "echo.text",
            },
          ],
        },
      });
    }

    if (body.method === "tools/call") {
      return jsonResult(200, {
        id: body.id,
        jsonrpc: "2.0",
        result: {
          content: [
            {
              text: JSON.stringify({
                echoed: body.params?.arguments?.text,
                provider: "public-mcp",
              }),
              type: "text",
            },
          ],
        },
      });
    }

    return jsonResult(200, {
      error: { code: -32601, message: "Method not found" },
      id: body.id,
      jsonrpc: "2.0",
    });
  }

  if (input.method === "GET" && input.url.pathname === "/__har") {
    return jsonResult(200, mockProviderServer.getHar());
  }

  return jsonResult(404, { error: "not found" });
}

function jsonResult(status: number, body: unknown) {
  return { body, status };
}

function writeJsonResponse(
  response: ServerResponse<IncomingMessage>,
  status: number,
  body: unknown,
) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body == null ? "" : JSON.stringify(body));
}

export default defineConfig({
  root: resolve(repoRoot, "packages/shared"),
  resolve: {
    alias: {
      "~": resolve(appRoot, "src"),
    },
  },
  plugins: [
    cloudflareVitest.cloudflareTest({
      main: resolve(testRoot, "iterate-mcp-server-test-entry.ts"),
      miniflare: {
        bindings: {
          MOCK_PROVIDER_BASE_URL: mockProviderServer.url,
        },
        serviceBindings: {
          ARTIFACTS: {
            entrypoint: "MockArtifactsBinding",
            name: miniflare.kCurrentWorker,
          },
          BUILTIN_MATRIX_PROVIDER: {
            entrypoint: "TestBuiltinMatrixProvider",
            name: miniflare.kCurrentWorker,
          },
          LEAF_PROVIDER: {
            entrypoint: "TestLeafProvider",
            name: miniflare.kCurrentWorker,
          },
          OPENAPI_BRIDGE: {
            entrypoint: "OpenApiBridge",
            name: miniflare.kCurrentWorker,
          },
          SELF: {
            name: miniflare.kCurrentWorker,
          },
        },
      },
      wrangler: {
        configPath: resolve(testRoot, "iterate-mcp-server.wrangler.vitest.jsonc"),
      },
    }),
  ],
  test: {
    exclude: defaultExclude,
    experimental: {
      importDurations: {
        limit: 0,
      },
    } as never,
    hookTimeout: 60_000,
    include: [resolve(testRoot, "iterate-mcp-server.test.ts")],
    testTimeout: 90_000,
  },
});
