const E2E_FIXTURE_PREFIX = "/__itx_e2e";

export async function e2eFixtureResponse(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const [prefix, kind, encodedAuthorization, ...path] = url.pathname.split("/").filter(Boolean);
  if (prefix !== E2E_FIXTURE_PREFIX.slice(1)) return null;

  if (kind === "egress-echo") {
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return Response.json({ headers });
  }

  const expectedAuthorization =
    encodedAuthorization === undefined || encodedAuthorization === "_"
      ? undefined
      : decodeURIComponent(encodedAuthorization);
  if (expectedAuthorization !== undefined) {
    const actual = request.headers.get("authorization") ?? "";
    if (actual !== expectedAuthorization) {
      return Response.json({ error: "unexpected_authorization", actual }, { status: 401 });
    }
  }

  if (kind === "openapi") {
    return openApiFixtureResponse({ path, request });
  }

  if (kind === "mcp") {
    return await mcpFixtureResponse(request);
  }

  return null;
}

function openApiFixtureResponse({ path, request }: { path: string[]; request: Request }) {
  const url = new URL(request.url);
  const route = `/${path.join("/")}`;
  const baseUrl = url.toString().replace(/\/(?:openapi\.json|pets)(?:\?.*)?$/, "");

  if (route === "/openapi.json") {
    return Response.json({
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
    });
  }

  if (route === "/pets") {
    const status = url.searchParams.get("status");
    return Response.json([{ id: 1, name: `${status}-pet`, status }]);
  }

  return Response.json({ error: "not_found" }, { status: 404 });
}

async function mcpFixtureResponse(request: Request): Promise<Response> {
  if (request.method === "GET") {
    return new Response(null, { status: 405 });
  }

  const payload = (await request.json().catch(() => ({}))) as {
    id?: string | number;
    method?: string;
    params?: { arguments?: Record<string, unknown> };
  };

  if (payload.method === "initialize") {
    return Response.json({
      id: payload.id,
      jsonrpc: "2.0",
      result: {
        capabilities: { tools: {} },
        protocolVersion: "2025-11-25",
        serverInfo: { name: "mock-mcp", version: "1.0.0" },
      },
    });
  }

  if (payload.method === "notifications/initialized") {
    return new Response(null, { status: 202 });
  }

  if (payload.method === "tools/list") {
    return Response.json({
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
    });
  }

  if (payload.method === "tools/call") {
    const result = { answer: `docs:${payload.params?.arguments?.query}` };
    return Response.json({
      id: payload.id,
      jsonrpc: "2.0",
      result: {
        content: [{ text: JSON.stringify(result), type: "text" }],
        structuredContent: result,
      },
    });
  }

  return Response.json({
    error: { code: -32601, message: "Method not found" },
    id: payload.id,
    jsonrpc: "2.0",
  });
}
