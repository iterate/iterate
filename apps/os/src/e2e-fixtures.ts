const E2E_FIXTURE_PREFIX = "/__itx_e2e";

// DELIBERATE: these fixtures are mounted unauthenticated in every deployment
// (workers/api.ts), production included, so the e2e suites can run against any
// live stage. They hold no state and reveal no environment: every response is
// either canned data or an echo of the caller's own request. Anything beyond
// that (secrets, env, bindings) must NOT be added here — see the
// /api/__internal/debug incident for why.
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

  if (kind === "slack") {
    return await slackFixtureResponse({ request, segments: [encodedAuthorization, ...path] });
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

/**
 * Slack Web API stand-in: the URL's last segment is the Web API method (the
 * Slack SDK appends it to its configured `slackApiUrl`). Mirrors the local
 * mock in e2e/vitest/itx-capability-fixtures.ts — canned success bodies, no
 * auth, no state.
 */
async function slackFixtureResponse({
  request,
  segments,
}: {
  request: Request;
  segments: (string | undefined)[];
}): Promise<Response> {
  const method = segments.filter(Boolean).join("/");
  const body = await request.text();
  const contentType = request.headers.get("content-type") ?? "";
  const payload: Record<string, unknown> = contentType.includes("application/json")
    ? (JSON.parse(body || "{}") as Record<string, unknown>)
    : Object.fromEntries(new URLSearchParams(body));

  if (method === "chat.postMessage") {
    return Response.json({
      ok: true,
      channel: payload.channel,
      ts: "1718000000.000100",
      message: { text: payload.text, type: "message" },
      via: "mock-slack-api",
    });
  }
  if (method === "users.list") {
    return Response.json({
      ok: true,
      members: [
        { id: "U1", name: "ada" },
        { id: "U2", name: "grace" },
      ],
      via: "mock-slack-api",
    });
  }
  return Response.json({ ok: true, via: "mock-slack-api" });
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
