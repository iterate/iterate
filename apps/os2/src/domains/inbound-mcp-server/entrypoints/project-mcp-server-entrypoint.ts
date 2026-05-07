import { env as workerEnv, WorkerEntrypoint } from "cloudflare:workers";
import { createClerkClient, verifyToken } from "@clerk/backend";
import { generateProtectedResourceMetadata } from "@clerk/mcp-tools/server";
import { parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import { McpAgent } from "agents/mcp";
import { AppConfig } from "~/app.ts";
import type {
  ProjectDurableObject,
  ProjectSummary,
} from "~/domains/projects/durable-objects/project-durable-object.ts";
import { getProjectDurableObjectName } from "~/domains/projects/durable-objects/project-durable-object.ts";
import type { ProjectMcpServerConnectionProps } from "~/domains/inbound-mcp-server/durable-objects/project-mcp-server-connection.ts";
import { ingressUrlFromRequest } from "~/ingress/host-routing.ts";
import { deriveClerkFrontendApiUrl } from "~/lib/clerk-frontend-api.ts";

type ProjectMcpServerEntrypointEnv = {
  PROJECT: DurableObjectNamespace<ProjectDurableObject>;
  PROJECT_MCP_SERVER_CONNECTION: DurableObjectNamespace;
};

type ProjectMcpServerEntrypointProps = {
  projectId: string;
};

const config = parseAppConfigFromEnv({
  configSchema: AppConfig,
  prefix: "APP_CONFIG_",
  env: workerEnv as unknown as Record<string, unknown>,
});
const mcpHandler = McpAgent.serve("/", { binding: "PROJECT_MCP_SERVER_CONNECTION" });

export class ProjectMcpServerEntrypoint extends WorkerEntrypoint<
  ProjectMcpServerEntrypointEnv,
  ProjectMcpServerEntrypointProps
> {
  async fetch(request: Request) {
    const url = ingressUrlFromRequest(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: mcpCorsHeaders });
    }

    if (isMcpProtectedResourceMetadataRequest(url)) {
      return mcpProtectedResourceMetadataResponse({ request });
    }

    if (url.pathname !== "/") {
      return new Response("Project MCP server is hosted at the route root.", {
        status: 404,
        headers: mcpCorsHeaders,
      });
    }

    if (isBrowserMcpInstructionsRequest(request)) {
      return mcpInstructionsPageResponse({ projectId: this.ctx.props.projectId, url });
    }

    const mcpAuth = await authenticateMcpRequest(request);
    if (mcpAuth instanceof Response) {
      return mcpAuth;
    }

    const project = await resolveMcpProject({
      auth: mcpAuth,
      project: this.env.PROJECT.getByName(getProjectDurableObjectName(this.ctx.props.projectId)),
    });

    const ctxWithProps = this.ctx as ExecutionContext & { props?: ProjectMcpServerConnectionProps };
    ctxWithProps.props = {
      ...mcpAuth,
      projectId: project.id,
      projectSlug: project.slug,
    };

    return await mcpHandler.fetch(request, this.env, this.ctx);
  }
}

const mcpCorsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};

function isMcpProtectedResourceMetadataRequest(url: URL) {
  return url.pathname === "/.well-known/oauth-protected-resource";
}

function mcpProtectedResourceMetadataResponse(input: { request: Request }) {
  const url = ingressUrlFromRequest(input.request);
  const metadata = generateProtectedResourceMetadata({
    authServerUrl: deriveClerkFrontendApiUrl(config.clerk.publishableKey),
    resourceUrl: new URL("/", url.origin).toString(),
    properties: {
      scopes_supported: config.clerk.mcpOauthScopes,
      service_documentation: "https://clerk.com/docs",
    },
  });

  return Response.json(metadata, { headers: mcpCorsHeaders });
}

async function authenticateMcpRequest(request: Request) {
  const token = readBearerToken(request);
  if (!token) {
    return unauthorizedMcpResponse(request, "Missing bearer token");
  }

  const sharedSecretAuth = authenticateSharedSecret(token);
  if (sharedSecretAuth) {
    return sharedSecretAuth;
  }

  try {
    const clerk = createClerkClient({
      secretKey: config.clerk.secretKey.exposeSecret(),
      publishableKey: config.clerk.publishableKey,
      jwtKey: config.clerk.jwtKey.exposeSecret(),
    });
    const requestState = await clerk.authenticateRequest(request, {
      acceptsToken: "oauth_token",
    });
    const oauthAuth = requestState.toAuth();

    if (!oauthAuth.isAuthenticated) {
      return unauthorizedMcpResponse(request, "Invalid bearer token");
    }

    const claims = await tryReadJwtClaims(token);
    const userId = oauthAuth.userId;
    const orgId = readOrganizationIdClaim(claims);

    if (!userId) {
      return unauthorizedMcpResponse(request, "MCP token is missing Clerk user subject");
    }

    if (!orgId) {
      return new Response("MCP token is missing active Clerk Organization", {
        status: 403,
        headers: mcpCorsHeaders,
      });
    }

    return {
      userId,
      orgId,
      orgRole: readOrganizationRoleClaim(claims),
      orgSlug: readOrganizationSlugClaim(claims),
      orgPermissions: readOrganizationPermissionsClaim(claims),
      scopes: oauthAuth.scopes.length > 0 ? oauthAuth.scopes : readScopeClaims(claims),
      clientId: oauthAuth.clientId ?? readStringClaim(claims, "client_id"),
      projectId: null,
      projectSlug: null,
    } satisfies ProjectMcpServerConnectionProps;
  } catch {
    return unauthorizedMcpResponse(request, "Invalid bearer token");
  }
}

function authenticateSharedSecret(token: string): ProjectMcpServerConnectionProps | null {
  const adminApiSecret = config.adminApiSecret?.exposeSecret();
  if (!adminApiSecret || token !== adminApiSecret) {
    return null;
  }

  // This path is intentionally narrower than Clerk OAuth: it is for preview
  // proofs and automation clients that already know the project MCP hostname.
  // The Project Durable Object still resolves the project summary by route
  // props, but it skips per-user Clerk membership checks.
  return {
    clientId: "admin-api-secret",
    orgId: "admin-api",
    orgPermissions: ["admin:api"],
    orgRole: "admin",
    orgSlug: null,
    projectId: null,
    projectSlug: null,
    scopes: ["profile"],
    userId: "admin-api-secret",
  };
}

async function resolveMcpProject(input: {
  auth: ProjectMcpServerConnectionProps;
  project: DurableObjectStub<ProjectDurableObject>;
}): Promise<ProjectSummary> {
  if (input.auth.clientId === "admin-api-secret") {
    return await input.project.getSummary();
  }

  if (!input.auth.orgId) {
    throw new Error("MCP OAuth auth is missing an organization id.");
  }

  return await input.project.checkAccess({
    principal: {
      orgId: input.auth.orgId,
      userId: input.auth.userId,
    },
  });
}

async function tryReadJwtClaims(token: string) {
  try {
    return (await verifyToken(token, {
      jwtKey: config.clerk.jwtKey.exposeSecret(),
    })) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readBearerToken(request: Request) {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function unauthorizedMcpResponse(request: Request, message: string) {
  const metadataUrl = new URL(
    "/.well-known/oauth-protected-resource",
    ingressUrlFromRequest(request),
  );
  return new Response(message, {
    status: 401,
    headers: {
      ...mcpCorsHeaders,
      "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl.toString()}"`,
    },
  });
}

function isBrowserMcpInstructionsRequest(request: Request) {
  return request.method === "GET" && request.headers.get("accept")?.includes("text/html");
}

function mcpInstructionsPageResponse(input: { projectId: string; url: URL }) {
  const mcpUrl = new URL("/", input.url.origin).toString();
  const claudeCommand = `claude mcp add --transport http ${input.projectId} ${mcpUrl}`;

  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(input.projectId)} MCP</title>
  <style>
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #fafafa; color: #171717; }
    main { max-width: 640px; padding: 32px 20px; margin: 0 auto; }
    h1 { font-size: 18px; margin: 0 0 8px; }
    p { color: #525252; line-height: 1.5; }
    section { margin-top: 16px; border: 1px solid #e5e5e5; border-radius: 8px; background: white; padding: 16px; }
    code { display: block; overflow-wrap: anywhere; white-space: pre-wrap; border-radius: 6px; background: #f5f5f5; padding: 12px; font: 13px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
    a { color: #155dfc; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(input.projectId)} MCP</h1>
    <p>Connect an MCP client to this project endpoint. The endpoint uses Clerk OAuth, so your client should open a browser sign-in flow when it connects.</p>
    <section>
      <p>Endpoint</p>
      <code>${escapeHtml(mcpUrl)}</code>
    </section>
    <section>
      <p>Claude Code</p>
      <code>${escapeHtml(claudeCommand)}</code>
      <p>Then run <code style="display: inline; padding: 2px 4px;">/mcp</code> in Claude Code and authenticate this server.</p>
      <p><a href="https://docs.anthropic.com/en/docs/claude-code/mcp">Claude Code MCP docs</a></p>
    </section>
  </main>
</body>
</html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function readStringClaim(claims: Record<string, unknown>, key: string) {
  const value = claims[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readOrganizationIdClaim(claims: Record<string, unknown>) {
  const organization = readRecordClaim(claims, "o");
  return readStringClaim(organization, "id") ?? readStringClaim(claims, "org_id");
}

function readOrganizationRoleClaim(claims: Record<string, unknown>) {
  const organization = readRecordClaim(claims, "o");
  return readStringClaim(organization, "rol") ?? readStringClaim(claims, "org_role");
}

function readOrganizationSlugClaim(claims: Record<string, unknown>) {
  const organization = readRecordClaim(claims, "o");
  return readStringClaim(organization, "slg") ?? readStringClaim(claims, "org_slug");
}

function readOrganizationPermissionsClaim(claims: Record<string, unknown>) {
  const organization = readRecordClaim(claims, "o");
  const permissions = organization.per;
  if (typeof permissions === "string") {
    return permissions.split(/[,\s]+/).filter(Boolean);
  }

  return Array.isArray(permissions) ? permissions.filter((value) => typeof value === "string") : [];
}

function readScopeClaims(claims: Record<string, unknown>) {
  const rawScopes = claims.scopes ?? claims.scope ?? claims.scp;
  if (typeof rawScopes === "string") {
    return rawScopes.split(" ").filter(Boolean);
  }

  if (Array.isArray(rawScopes)) {
    return rawScopes.filter((value) => typeof value === "string");
  }

  return [];
}

function readRecordClaim(claims: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = claims[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
