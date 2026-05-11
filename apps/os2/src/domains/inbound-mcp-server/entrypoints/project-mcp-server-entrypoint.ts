import { env as workerEnv, WorkerEntrypoint } from "cloudflare:workers";
import { createClerkClient, verifyToken, type ClerkClient } from "@clerk/backend";
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

    const access = await resolveMcpProjectAccess({
      auth: mcpAuth,
      project: this.env.PROJECT.getByName(getProjectDurableObjectName(this.ctx.props.projectId)),
    });
    if (access instanceof Response) {
      return access;
    }

    const ctxWithProps = this.ctx as ExecutionContext & { props?: ProjectMcpServerConnectionProps };
    ctxWithProps.props = {
      ...access.auth,
      projectId: access.project.id,
      projectSlug: access.project.slug,
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
    const clerk = createClerkClientForApp();
    const requestState = await clerk.authenticateRequest(request, {
      acceptsToken: ["oauth_token", "session_token"],
    });
    const clerkAuth = requestState.toAuth();

    if (!clerkAuth?.isAuthenticated) {
      return unauthorizedMcpResponse(request, "Invalid bearer token");
    }

    const claims = await tryReadJwtClaims(token);
    const userId = readStringProperty(clerkAuth, "userId");
    const tokenType = readClerkTokenType(clerkAuth);

    if (!userId) {
      return unauthorizedMcpResponse(request, "MCP token must identify a Clerk user");
    }

    return {
      userId,
      orgId: readStringProperty(clerkAuth, "orgId") ?? readOrganizationIdClaim(claims),
      orgRole: readStringProperty(clerkAuth, "orgRole") ?? readOrganizationRoleClaim(claims),
      orgSlug: readStringProperty(clerkAuth, "orgSlug") ?? readOrganizationSlugClaim(claims),
      orgPermissions:
        readStringArrayProperty(clerkAuth, "orgPermissions") ??
        readOrganizationPermissionsClaim(claims),
      scopes: readStringArrayProperty(clerkAuth, "scopes") ?? readScopeClaims(claims),
      clientId: readStringProperty(clerkAuth, "clientId") ?? readStringClaim(claims, "client_id"),
      clerkTokenType: tokenType,
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
    clerkTokenType: "admin_api_secret",
  };
}

function readClerkTokenType(clerkAuth: unknown): ProjectMcpServerConnectionProps["clerkTokenType"] {
  const tokenType = readStringProperty(clerkAuth, "tokenType");
  if (tokenType === "oauth_token" || tokenType === "session_token") {
    return tokenType;
  }
  return undefined;
}

async function resolveMcpProjectAccess(input: {
  auth: ProjectMcpServerConnectionProps;
  project: DurableObjectStub<ProjectDurableObject>;
}): Promise<{ auth: ProjectMcpServerConnectionProps; project: ProjectSummary } | Response> {
  if (input.auth.clientId === "admin-api-secret") {
    return { auth: input.auth, project: await input.project.getSummary() };
  }

  if (input.auth.orgId) {
    const project = await tryCheckMcpProjectAccess({
      auth: input.auth,
      orgId: input.auth.orgId,
      project: input.project,
    });
    if (project) {
      return { auth: input.auth, project };
    }
  }

  const membershipAccess = await findMcpProjectMembershipAccess({
    auth: input.auth,
    clerk: createClerkClientForApp(),
    project: input.project,
  });
  if (membershipAccess) {
    return membershipAccess;
  }

  return new Response("MCP user is not a member of an organization with access to this project", {
    status: 403,
    headers: mcpCorsHeaders,
  });
}

async function findMcpProjectMembershipAccess(input: {
  auth: ProjectMcpServerConnectionProps;
  clerk: ClerkClient;
  project: DurableObjectStub<ProjectDurableObject>;
}) {
  const memberships = await input.clerk.users.getOrganizationMembershipList({
    limit: 100,
    userId: input.auth.userId,
  });

  for (const membership of memberships.data) {
    const project = await tryCheckMcpProjectAccess({
      auth: input.auth,
      orgId: membership.organization.id,
      project: input.project,
    });
    if (!project) {
      continue;
    }

    return {
      auth: {
        ...input.auth,
        orgId: membership.organization.id,
        orgPermissions: membership.permissions,
        orgRole: membership.role,
        orgSlug: membership.organization.slug ?? null,
      },
      project,
    };
  }

  return null;
}

async function tryCheckMcpProjectAccess(input: {
  auth: ProjectMcpServerConnectionProps;
  orgId: string;
  project: DurableObjectStub<ProjectDurableObject>;
}) {
  try {
    return await input.project.checkAccess({
      principal: {
        orgId: input.orgId,
        userId: input.auth.userId,
      },
    });
  } catch {
    return null;
  }
}

function createClerkClientForApp(): ClerkClient {
  return createClerkClient({
    secretKey: config.clerk.secretKey.exposeSecret(),
    publishableKey: config.clerk.publishableKey,
    jwtKey: config.clerk.jwtKey.exposeSecret(),
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

function readStringProperty(value: unknown, key: string) {
  if (!isRecord(value)) {
    return null;
  }

  return readStringClaim(value, key);
}

function readStringArrayProperty(value: unknown, key: string) {
  if (!isRecord(value)) {
    return null;
  }

  const propertyValue = value[key];
  return Array.isArray(propertyValue)
    ? propertyValue.filter((entry) => typeof entry === "string")
    : null;
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
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
