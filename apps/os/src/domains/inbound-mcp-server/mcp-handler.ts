import { createIterateAuth } from "@iterate-com/auth/server";
import {
  ITERATE_PROJECT_SELECTION_SCOPE,
  hasWildcardProjectScope,
  listProjectScopeIds,
} from "@iterate-com/shared/auth-claims";
import { McpAgent } from "agents/mcp";
import { createD1Client } from "sqlfu";
import type { AppConfig } from "~/app.ts";
import { principalFromAccessToken, type Principal } from "~/auth/principal.ts";
import { listAllProjects } from "~/db/queries/.generated/index.ts";
import { isBrowserMcpInstructionsRequest } from "~/domains/inbound-mcp-server/mcp-instructions-request.ts";
import {
  matchMcpRequestUrl,
  normalizeMcpBaseUrl,
  stripTrailingSlash,
} from "~/domains/inbound-mcp-server/mcp-url-routing.ts";
import { resolveMcpBaseUrl } from "~/lib/mcp-base-url.ts";
import type {
  ProjectMcpServerConnectionProject,
  ProjectMcpServerConnectionProps,
} from "~/domains/inbound-mcp-server/durable-objects/project-mcp-server-connection.ts";

type McpHandlerInput = {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  config: AppConfig;
};

const internalMcpHandlerPath = "/__iterate/internal-mcp";
const mcpHandler = McpAgent.serve(internalMcpHandlerPath, {
  binding: "PROJECT_MCP_SERVER_CONNECTION",
});

export const mcpCorsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};

export async function handleMcpFetch(input: McpHandlerInput): Promise<Response | null> {
  const routeMatch = matchConfiguredMcpBaseUrl(input);
  if (!routeMatch) return null;

  if (input.request.method === "OPTIONS") {
    return new Response(null, { headers: mcpCorsHeaders });
  }

  if (isMcpProtectedResourceMetadataPath(routeMatch.relativePathname)) {
    return Response.json(buildProtectedResourceMetadata(input), { headers: mcpCorsHeaders });
  }

  if (routeMatch.relativePathname !== "/") {
    return new Response("Not found", { status: 404, headers: mcpCorsHeaders });
  }

  if (isBrowserMcpInstructionsRequest(input.request)) {
    return mcpInstructionsPageResponse(input);
  }

  const adminProps = await authenticateAdminMcpRequest(input);
  if (adminProps instanceof Response) {
    return adminProps;
  }
  if (adminProps) {
    const ctxWithProps = input.ctx as ExecutionContext & {
      props?: ProjectMcpServerConnectionProps;
    };
    ctxWithProps.props = adminProps;
    return withCorsHeaders(
      await mcpHandler.fetch(mcpHandlerRequest(input.request), input.env, input.ctx),
    );
  }

  const auth = createMcpIterateAuth(input);
  if (!auth) {
    return new Response("Iterate auth is not configured.", {
      status: 503,
      headers: mcpCorsHeaders,
    });
  }

  const accessToken = await auth.authenticateBearer({ headers: input.request.headers });
  if (!accessToken) {
    return unauthorizedMcpResponse(input, "Missing or invalid bearer token");
  }

  const scopes = readAccessTokenScopes(accessToken);
  const principal = principalFromAccessToken(accessToken);
  const grantedProjectIds = new Set(listProjectScopeIds(scopes));
  const hasWildcardProjects = hasWildcardProjectScope(scopes);
  const projects = principal.projects.flatMap((project) => {
    if (!hasWildcardProjects && !grantedProjectIds.has(project.id)) return [];

    const organization = principal.organizations.find((org) => org.id === project.organizationId);
    return [
      {
        id: project.id,
        slug: project.slug,
        organizationId: project.organizationId,
        organizationPermissions: [],
        organizationRole: organization?.role ?? null,
        organizationSlug: organization?.slug ?? null,
      } satisfies ProjectMcpServerConnectionProject,
    ];
  });

  if (projects.length === 0) {
    return new Response("MCP token does not grant access to any projects.", {
      status: 403,
      headers: mcpCorsHeaders,
    });
  }

  const ctxWithProps = input.ctx as ExecutionContext & { props?: ProjectMcpServerConnectionProps };
  ctxWithProps.props = propsFromPrincipal({
    clientId: accessToken.azp ?? null,
    principal,
    projects,
    scopes,
  });

  return withCorsHeaders(
    await mcpHandler.fetch(mcpHandlerRequest(input.request), input.env, input.ctx),
  );
}

async function authenticateAdminMcpRequest(input: McpHandlerInput) {
  const token = readBearerToken(input.request.headers.get("authorization"));
  const expectedToken = input.config.adminApiSecret?.exposeSecret();
  if (!token || !expectedToken || token !== expectedToken) return null;

  const db = createD1Client(input.env.DB);
  const projects = await listAllProjects(db, { limit: 10_000, offset: 0 });
  if (projects.length === 0) {
    return new Response("No projects are available to this admin MCP token.", {
      status: 403,
      headers: mcpCorsHeaders,
    });
  }

  return {
    authType: "admin_api_secret",
    clientId: "admin-api-secret",
    orgId: "admin-api",
    orgPermissions: ["admin:api"],
    orgRole: "admin",
    orgSlug: null,
    projectId: null,
    projectSlug: null,
    projects: projects.map((project) => ({
      id: project.id,
      slug: project.slug,
      organizationId: "admin-api",
      organizationPermissions: ["admin:api"],
      organizationRole: "admin",
      organizationSlug: null,
    })),
    scopes: ["profile"],
    userId: "admin-api-secret",
  } satisfies ProjectMcpServerConnectionProps;
}

function isMcpProtectedResourceMetadataPath(pathname: string) {
  return pathname === "/.well-known/oauth-protected-resource";
}

function matchConfiguredMcpBaseUrl(input: McpHandlerInput) {
  return matchMcpRequestUrl({
    appBaseUrl: input.config.baseUrl,
    mcpBaseUrl: input.config.mcp?.baseUrl,
    requestUrl: input.request.url,
  });
}

function mcpHandlerRequest(request: Request) {
  const url = new URL(request.url);
  url.pathname = internalMcpHandlerPath;
  return new Request(url, request);
}

function createMcpIterateAuth(input: McpHandlerInput) {
  const config = input.config.iterateAuth;
  if (!config) return null;

  const baseUrl = getRequestBaseUrl(input);
  return createIterateAuth({
    issuer: config.issuer,
    clientId: config.clientId,
    clientSecret: config.clientSecret.exposeSecret(),
    redirectURI: `${baseUrl}/api/iterate-auth/callback`,
    resource: canonicalMcpResourceUrl(input),
  });
}

function propsFromPrincipal(input: {
  clientId: string | null;
  principal: Extract<Principal, { type: "user" }>;
  projects: ProjectMcpServerConnectionProject[];
  scopes: string[];
}): ProjectMcpServerConnectionProps {
  const firstProject = input.projects[0];
  return {
    authType: "oauth_access_token",
    clientId: input.clientId,
    orgId: firstProject.organizationId,
    orgPermissions: firstProject.organizationPermissions,
    orgRole: firstProject.organizationRole,
    orgSlug: firstProject.organizationSlug,
    projectId: input.projects.length === 1 ? firstProject.id : null,
    projectSlug: input.projects.length === 1 ? firstProject.slug : null,
    projects: input.projects,
    scopes: input.scopes,
    userId: input.principal.userId,
  };
}

function buildProtectedResourceMetadata(input: McpHandlerInput) {
  return {
    resource: canonicalMcpResourceUrl(input),
    authorization_servers: [
      input.config.iterateAuth?.issuer ?? "https://auth.iterate.com/api/auth",
    ],
    scopes_supported: [
      "openid",
      "profile",
      "email",
      "offline_access",
      ITERATE_PROJECT_SELECTION_SCOPE,
    ],
    bearer_methods_supported: ["header"],
  };
}

function readAccessTokenScopes(accessToken: { scope?: string; scopes?: string[] }) {
  if (accessToken.scopes) return accessToken.scopes;
  return accessToken.scope?.split(" ").filter(Boolean) ?? [];
}

function readBearerToken(headerValue: string | null) {
  const match = /^bearer\s+(.+)$/i.exec(headerValue ?? "");
  return match?.[1]?.trim() || null;
}

function canonicalMcpResourceUrl(input: McpHandlerInput) {
  const rawUrl = resolveMcpBaseUrl({
    appBaseUrl: input.config.baseUrl,
    mcpBaseUrl: input.config.mcp?.baseUrl,
    requestUrl: input.request.url,
  });
  if (!rawUrl) throw new Error("APP_CONFIG_MCP__BASE_URL is required for MCP requests.");
  const baseUrl = normalizeMcpBaseUrl(rawUrl);
  return stripTrailingSlash(baseUrl.toString());
}

function getRequestBaseUrl(input: McpHandlerInput) {
  return (input.config.baseUrl ?? new URL(input.request.url).origin).replace(/\/+$/, "");
}

function unauthorizedMcpResponse(input: McpHandlerInput, message: string) {
  const metadataUrl = new URL(
    ".well-known/oauth-protected-resource",
    `${canonicalMcpResourceUrl(input)}/`,
  ).toString();
  return new Response(message, {
    status: 401,
    headers: {
      ...mcpCorsHeaders,
      "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}"`,
    },
  });
}

function mcpInstructionsPageResponse(input: McpHandlerInput) {
  const mcpUrl = canonicalMcpResourceUrl(input);
  const metadataUrl = new URL(
    ".well-known/oauth-protected-resource",
    `${canonicalMcpResourceUrl(input)}/`,
  ).toString();
  const claudeCommand = `claude mcp add --transport http iterate ${mcpUrl}`;

  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Iterate MCP</title>
  <style>
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #fafafa; color: #171717; }
    main { max-width: 720px; padding: 32px 20px; margin: 0 auto; }
    h1 { font-size: 22px; margin: 0 0 8px; }
    p { color: #525252; line-height: 1.5; }
    section { margin-top: 16px; border: 1px solid #e5e5e5; border-radius: 8px; background: white; padding: 16px; }
    code { display: block; overflow-wrap: anywhere; white-space: pre-wrap; border-radius: 6px; background: #f5f5f5; padding: 12px; font: 13px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
    a { color: #155dfc; }
  </style>
</head>
<body>
  <main>
    <h1>Iterate MCP</h1>
    <p>Connect an MCP client to Iterate OS. The auth flow lets you choose which projects this client can access.</p>
    <section>
      <p>Endpoint</p>
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
</html>`,
    { headers: { ...mcpCorsHeaders, "Content-Type": "text/html; charset=utf-8" } },
  );
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

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
