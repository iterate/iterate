import http from "node:http";
import { mockSlackResponseBody } from "../../src/e2e-fixtures.ts";

const E2E_FIXTURE_PREFIX = "/__itx_e2e";

type FixtureServer = {
  close(): Promise<void>;
  url: string;
};

type CapabilityFixtureInput = {
  expectedAuthorization?: string;
};

function deployedFixtureBaseUrl(): string | null {
  const raw = process.env.APP_CONFIG_BASE_URL?.trim();
  if (!raw) return null;

  const url = new URL(raw);
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1") {
    return null;
  }

  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function deployedFixtureUrl(
  baseUrl: string,
  kind: "egress-echo" | "mcp" | "openapi",
  expectedAuthorization?: string,
): string {
  const url = new URL(baseUrl);
  const prefix = `${E2E_FIXTURE_PREFIX}/${kind}`;
  const encodedAuthorization =
    expectedAuthorization === undefined ? "_" : encodeURIComponent(expectedAuthorization);
  url.pathname = kind === "egress-echo" ? prefix : `${prefix}/${encodedAuthorization}`;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function listen(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, baseUrl: string) => void,
  path = "",
): Promise<FixtureServer> {
  let baseUrl = "";
  const server = http.createServer((req, res) => handler(req, res, baseUrl));

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve({
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) => (error ? closeReject(error) : closeResolve()));
          }),
        url: `${baseUrl}${path}`,
      });
    });
  });
}

/**
 * Slack Web API stand-in for the WORKER-side WebClient (the seeded project
 * worker's `slack` surface): local runs spin a loopback server; deployed runs
 * use the deployment's own /__itx_e2e/slack fixture, since a worker on a
 * preview cannot reach the test runner's 127.0.0.1. `calls` is only populated
 * in local mode — deployed assertions must go by response bodies.
 */
export async function startMockSlackApi(): Promise<FixtureServer & { calls: string[] }> {
  const deployedBaseUrl = deployedFixtureBaseUrl();
  if (deployedBaseUrl !== null) {
    const url = new URL(deployedBaseUrl);
    url.pathname = `${E2E_FIXTURE_PREFIX}/slack/`;
    return { calls: [], close: async () => {}, url: url.toString() };
  }

  const calls: string[] = [];
  const server = await listen((req, res) => {
    const method = (req.url ?? "").replace(/^\//, "").split("?")[0] ?? "";
    calls.push(method);
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const contentType = String(req.headers["content-type"] ?? "");
      const payload: Record<string, unknown> = contentType.includes("application/json")
        ? (JSON.parse(body || "{}") as Record<string, unknown>)
        : Object.fromEntries(new URLSearchParams(body));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(mockSlackResponseBody(method, payload)));
    });
  }, "/");
  return { ...server, calls };
}

export async function startEgressEcho(): Promise<FixtureServer> {
  const deployedBaseUrl = deployedFixtureBaseUrl();
  if (deployedBaseUrl !== null) {
    return {
      close: async () => {},
      url: deployedFixtureUrl(deployedBaseUrl, "egress-echo"),
    };
  }

  const server = await listen((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ headers: req.headers }));
  }, "/egress-echo");
  return server;
}

export async function startMockOpenApi(
  input: CapabilityFixtureInput = {},
): Promise<FixtureServer & { authHeaders: string[] }> {
  const deployedBaseUrl = deployedFixtureBaseUrl();
  if (deployedBaseUrl !== null) {
    return {
      authHeaders: [],
      close: async () => {},
      url: deployedFixtureUrl(deployedBaseUrl, "openapi", input.expectedAuthorization),
    };
  }

  const authHeaders: string[] = [];
  const server = await listen((req, res, baseUrl) => {
    authHeaders.push(String(req.headers.authorization ?? ""));
    if (
      input.expectedAuthorization !== undefined &&
      req.headers.authorization !== input.expectedAuthorization
    ) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unexpected_authorization" }));
      return;
    }

    const requestUrl = new URL(req.url ?? "/", baseUrl);
    res.setHeader("content-type", "application/json");

    if (requestUrl.pathname === "/openapi.json") {
      res.end(
        JSON.stringify({
          openapi: "3.0.3",
          info: { title: "Tiny Pets", version: "1.0.0" },
          servers: [{ url: baseUrl }],
          paths: {
            "/pets": {
              get: {
                operationId: "findPetsByStatus",
                parameters: [
                  {
                    in: "query",
                    name: "status",
                    required: true,
                    schema: { enum: ["available", "pending"], type: "string" },
                  },
                ],
                responses: { "200": { content: { "application/json": { schema: {} } } } },
                summary: "Find pets by status",
              },
            },
          },
        }),
      );
      return;
    }

    if (requestUrl.pathname === "/pets") {
      const status = requestUrl.searchParams.get("status");
      res.end(JSON.stringify([{ id: 1, name: `${status}-pet`, status }]));
      return;
    }

    res.writeHead(404).end(JSON.stringify({ error: "not_found" }));
  });
  return { ...server, authHeaders };
}

export async function startMockMcp(
  input: CapabilityFixtureInput = {},
): Promise<FixtureServer & { authHeaders: string[]; methods: string[] }> {
  const deployedBaseUrl = deployedFixtureBaseUrl();
  if (deployedBaseUrl !== null) {
    return {
      authHeaders: [],
      close: async () => {},
      methods: [],
      url: deployedFixtureUrl(deployedBaseUrl, "mcp", input.expectedAuthorization),
    };
  }

  const authHeaders: string[] = [];
  const methods: string[] = [];
  const server = await listen((req, res) => {
    if (req.method === "GET") {
      res.writeHead(405).end();
      return;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const payload = JSON.parse(body || "{}") as {
        id?: string | number;
        method?: string;
        params?: { arguments?: Record<string, unknown> };
      };
      authHeaders.push(String(req.headers.authorization ?? ""));
      if (
        input.expectedAuthorization !== undefined &&
        req.headers.authorization !== input.expectedAuthorization
      ) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unexpected_authorization", id: payload.id }));
        return;
      }

      methods.push(String(payload.method ?? ""));
      res.setHeader("content-type", "application/json");

      if (payload.method === "initialize") {
        res.end(
          JSON.stringify({
            id: payload.id,
            jsonrpc: "2.0",
            result: {
              capabilities: { tools: {} },
              protocolVersion: "2025-11-25",
              serverInfo: { name: "mock-mcp", version: "1.0.0" },
            },
          }),
        );
        return;
      }

      if (payload.method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }

      if (payload.method === "tools/list") {
        res.end(
          JSON.stringify({
            id: payload.id,
            jsonrpc: "2.0",
            result: {
              tools: [
                {
                  description: "Search docs",
                  inputSchema: {
                    properties: { query: { type: "string" } },
                    required: ["query"],
                    type: "object",
                  },
                  name: "search_docs",
                },
              ],
            },
          }),
        );
        return;
      }

      if (payload.method === "tools/call") {
        const result = { answer: `docs:${payload.params?.arguments?.query}` };
        res.end(
          JSON.stringify({
            id: payload.id,
            jsonrpc: "2.0",
            result: {
              content: [{ text: JSON.stringify(result), type: "text" }],
              structuredContent: result,
            },
          }),
        );
        return;
      }

      res.end(
        JSON.stringify({
          error: { code: -32601, message: "Method not found" },
          id: payload.id,
          jsonrpc: "2.0",
        }),
      );
    });
  }, "/mcp");
  return { ...server, authHeaders, methods };
}
