import http from "node:http";

type FixtureServer = {
  close(): Promise<void>;
  url: string;
};

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

export async function startMockOpenApi(): Promise<FixtureServer & { authHeaders: string[] }> {
  const authHeaders: string[] = [];
  const server = await listen((req, res, baseUrl) => {
    authHeaders.push(String(req.headers.authorization ?? ""));
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

export async function startMockMcp(): Promise<
  FixtureServer & { authHeaders: string[]; methods: string[] }
> {
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
