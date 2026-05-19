import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  hasWildcardProjectScope,
  ITERATE_PROJECT_SELECTION_SCOPE,
  listProjectScopeIds,
} from "@iterate-com/shared/auth-claims";
import { parseBearerToken } from "@iterate-com/shared/bearer";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod/v4";

type Env = {
  AUTH_ISSUER?: string;
  AUTH_JWKS_URL?: string;
};

const defaultAuthIssuer = "https://auth.iterate.com/api/auth";
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const mcpCorsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: mcpCorsHeaders });
    }

    if (isProtectedResourceMetadataPath(url.pathname)) {
      return Response.json(buildProtectedResourceMetadata({ env, request }), {
        headers: mcpCorsHeaders,
      });
    }

    if (url.pathname !== "/mcp") {
      return new Response("Not found", { status: 404, headers: mcpCorsHeaders });
    }

    if (isBrowserInstructionsRequest(request)) {
      return new Response(renderInstructionsPage({ request }), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    const token = parseBearerToken(request.headers.get("authorization"));
    if (!token) {
      return unauthorizedMcpResponse({ env, request, message: "Missing bearer token" });
    }

    let claims: Record<string, unknown>;
    try {
      claims = await verifyBearerToken({
        token,
        audience: getCanonicalMcpResourceUrl(request),
        issuer: getAuthIssuer(env),
        jwksUrl: getJwksUrl(env),
      });
    } catch {
      return unauthorizedMcpResponse({ env, request, message: "Invalid bearer token" });
    }

    const scopes = readScopeClaims(claims);
    const server = createDummyMcpServer({
      projectIds: listProjectScopeIds(scopes),
      wildcard: hasWildcardProjectScope(scopes),
      scopes,
      userId: typeof claims.sub === "string" ? claims.sub : null,
    });
    const transport = new WebStandardStreamableHTTPServerTransport();
    await server.connect(transport);
    const response = await transport.handleRequest(request);

    return withCorsHeaders(response);
  },
} satisfies ExportedHandler<Env>;

async function verifyBearerToken(input: {
  token: string;
  audience: string;
  issuer: string;
  jwksUrl: string;
}) {
  const { payload } = await jwtVerify(input.token, getJwks(input.jwksUrl), {
    audience: input.audience,
    issuer: input.issuer,
  });

  return payload as Record<string, unknown>;
}

function isProtectedResourceMetadataPath(pathname: string) {
  return (
    pathname === "/.well-known/oauth-protected-resource" ||
    pathname === "/.well-known/oauth-protected-resource/mcp"
  );
}

function buildProtectedResourceMetadata(input: { env: Env; request: Request }) {
  return {
    resource: getCanonicalMcpResourceUrl(input.request),
    authorization_servers: [getAuthIssuer(input.env)],
    scopes_supported: [ITERATE_PROJECT_SELECTION_SCOPE],
    bearer_methods_supported: ["header"],
  };
}

function getAuthIssuer(env: Env) {
  return env.AUTH_ISSUER?.trim() || defaultAuthIssuer;
}

function getJwksUrl(env: Env) {
  const configured = env.AUTH_JWKS_URL?.trim();
  if (configured) {
    return configured;
  }

  return new URL("./jwks", ensureTrailingSlash(getAuthIssuer(env))).toString();
}

function getJwks(jwksUrl: string): JWTVerifyGetKey {
  let jwks = jwksCache.get(jwksUrl);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(jwksUrl));
    jwksCache.set(jwksUrl, jwks);
  }

  return jwks;
}

function getCanonicalMcpResourceUrl(request: Request) {
  return new URL("/mcp", request.url).toString();
}

function createDummyMcpServer(input: {
  projectIds: string[];
  wildcard: boolean;
  scopes: string[];
  userId: string | null;
}) {
  const server = new McpServer({
    name: "iterate-dummy-mcp",
    version: "0.0.1",
  });

  server.registerTool(
    "get_allowed_projects",
    {
      title: "Get allowed projects",
      description: "Return the project IDs authorized by the OAuth bearer token.",
      inputSchema: z.object({}),
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              userId: input.userId,
              wildcard: input.wildcard,
              allowedProjectIds: input.projectIds,
              scopes: input.scopes,
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  return server;
}

function readScopeClaims(claims: Record<string, unknown>) {
  const rawScopes = claims.scopes ?? claims.scope ?? claims.scp;

  if (typeof rawScopes === "string") {
    return rawScopes.split(" ").filter(Boolean);
  }

  if (Array.isArray(rawScopes)) {
    return rawScopes.filter((value): value is string => typeof value === "string");
  }

  return [];
}

function unauthorizedMcpResponse(input: { env: Env; request: Request; message: string }) {
  const resourceMetadataUrl = new URL(
    "/.well-known/oauth-protected-resource/mcp",
    input.request.url,
  ).toString();

  return new Response(input.message, {
    status: 401,
    headers: {
      ...mcpCorsHeaders,
      "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`,
    },
  });
}

function isBrowserInstructionsRequest(request: Request) {
  return request.method === "GET" && request.headers.get("accept")?.includes("text/html");
}

function renderInstructionsPage(input: { request: Request }) {
  const mcpUrl = getCanonicalMcpResourceUrl(input.request);
  const metadataUrl = new URL(
    "/.well-known/oauth-protected-resource/mcp",
    input.request.url,
  ).toString();
  const claudeCommand = `claude mcp add --transport http iterate-dummy ${mcpUrl}`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Iterate Dummy MCP</title>
  <style>
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #fafafa; color: #171717; }
    main { max-width: 720px; padding: 32px 20px; margin: 0 auto; }
    h1 { font-size: 22px; margin: 0 0 8px; }
    p { color: #525252; line-height: 1.5; }
    section { margin-top: 16px; border: 1px solid #e5e5e5; border-radius: 8px; background: white; padding: 16px; }
    code { display: block; overflow-wrap: anywhere; white-space: pre-wrap; border-radius: 6px; background: #f5f5f5; padding: 12px; font: 13px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
  </style>
</head>
<body>
  <main>
    <h1>Iterate Dummy MCP</h1>
    <p>This is a separate MCP app for testing Iterate Auth OAuth project scopes.</p>
    <section>
      <p>MCP endpoint</p>
      <code>${escapeHtml(mcpUrl)}</code>
    </section>
    <section>
      <p>Protected resource metadata</p>
      <code>${escapeHtml(metadataUrl)}</code>
    </section>
    <section>
      <p>Claude Code</p>
      <code>${escapeHtml(claudeCommand)}</code>
    </section>
  </main>
</body>
</html>`;
}

function ensureTrailingSlash(value: string) {
  return value.endsWith("/") ? value : `${value}/`;
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function withCorsHeaders(response: Response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(mcpCorsHeaders)) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
