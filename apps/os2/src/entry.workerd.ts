import { env as workerEnv } from "cloudflare:workers";
import { parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import { withEvlog } from "@iterate-com/shared/apps/logging/with-evlog";
import { NitroWebSocketResponse } from "@iterate-com/shared/nitro-ws-response";
import handler from "@tanstack/react-start/server-entry";
import { createClerkClient, verifyToken } from "@clerk/backend";
import { generateProtectedResourceMetadata } from "@clerk/mcp-tools/server";
import { McpAgent } from "agents/mcp";
import crossws from "crossws/adapters/cloudflare";
import { createD1Client } from "sqlfu";
import manifest, { AppConfig } from "~/app.ts";
import type { AppContext } from "~/context.ts";
import type { IterateMcpServerProps } from "~/durable-objects/iterate-mcp-server.ts";
import { getProjectBySlug } from "~/db/queries/.generated/index.ts";
import {
  normalizeRequestHostname,
  resolveProjectSlugFromHostname,
} from "~/lib/project-host-routing.ts";

// Re-export rpc-targets so loopback-binding callables can resolve them from ctx.exports.
// https://developers.cloudflare.com/workers/runtime-apis/context/#exports
export { OpenApiBridge } from "~/rpc-targets/openapi-bridge.ts";
export { McpClientBridge } from "~/rpc-targets/mcp-client-bridge.ts";

const config = parseAppConfigFromEnv({
  configSchema: AppConfig,
  prefix: "APP_CONFIG_",
  env: workerEnv,
});

// Cloudflare's McpAgent receives per-request auth through ExecutionContext props.
// We fill those props after Clerk OAuth verification below, then delegate to the
// durable MCP handler. First-party ref:
// https://developers.cloudflare.com/agents/model-context-protocol/mcp-agent-api/
const mcpHandler = McpAgent.serve("/mcp", { binding: "ITERATE_MCP_SERVER" });

export default {
  async fetch(request: Request, env: Env, cfCtx: ExecutionContext) {
    return withEvlog(
      {
        request,
        manifest,
        config,
        executionCtx: cfCtx,
      },
      async ({ log }) => {
        const url = new URL(request.url);
        const db = createD1Client(env.DB);
        const projectHostnameBases = parseProjectHostnameBases(env.PROJECT_HOSTNAME_BASES);
        if (isMcpProtectedResourceMetadataRequest(url)) {
          return mcpProtectedResourceMetadataResponse(request, config);
        }

        const projectHostRootRedirect = await redirectAuthenticatedProjectHostRoot({
          appConfig: config,
          projectHostnameBases,
          request,
          url,
        });
        if (projectHostRootRedirect) {
          return projectHostRootRedirect;
        }

        if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
          if (request.method === "OPTIONS") {
            return new Response(null, { headers: mcpCorsHeaders });
          }

          const projectSlug = resolveProjectSlugForProjectHostname({
            appConfig: config,
            hostname: url.hostname,
            projectHostnameBases,
          });
          if (!projectSlug) {
            return new Response("MCP is only available at <project>.<project-host-base>/mcp.", {
              status: 404,
              headers: mcpCorsHeaders,
            });
          }

          const mcpAuth = await authenticateMcpRequest(request, config);
          if (mcpAuth instanceof Response) {
            return mcpAuth;
          }

          const project = await getProjectBySlug(db, {
            clerkOrgId: mcpAuth.orgId,
            slug: projectSlug,
          });
          if (!project) {
            return new Response("Project not found for MCP endpoint.", {
              status: 404,
              headers: mcpCorsHeaders,
            });
          }

          const ctxWithProps = cfCtx as ExecutionContext & { props?: IterateMcpServerProps };
          ctxWithProps.props = {
            ...mcpAuth,
            projectId: project.id,
            projectSlug: project.slug,
          };
          return mcpHandler.fetch(request, env, cfCtx);
        }

        const context: AppContext = {
          manifest,
          config,
          rawRequest: request,
          db,
          log,
          projectHostnameBases,
          loader: env.LOADER,
          codemodeSession: env.CODEMODE_SESSION,
          callableEnv: env,
        };

        const response = await handler.fetch(request, {
          context,
        });
        if (response instanceof NitroWebSocketResponse) {
          return crossws({ hooks: response.crossws }).handleUpgrade(request, env, cfCtx);
        }

        return response;
      },
    );
  },
};

/** Parses the comma-delimited Worker binding generated from AppConfig projectHostnameBases. */
function parseProjectHostnameBases(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Sends signed-in users from `<project>.<project-host-base>/` to the canonical
 * org/project route while preserving the project-host entry point for signed-out
 * users. This is why an unauthenticated visit to a project hostname can go
 * through Clerk's `redirect_url` flow and still land on the project after login.
 *
 * Clerk documents that sign-in pages should preserve `redirect_url` and use
 * fallback redirects only when no redirect was provided:
 * https://clerk.com/docs/guides/development/customize-redirect-urls
 */
async function redirectAuthenticatedProjectHostRoot(input: {
  appConfig: AppConfig;
  projectHostnameBases: readonly string[];
  request: Request;
  url: URL;
}) {
  if (input.request.method !== "GET" || input.url.pathname !== "/") return null;

  const projectSlug = resolveProjectSlugForProjectHostname({
    appConfig: input.appConfig,
    hostname: input.url.hostname,
    projectHostnameBases: input.projectHostnameBases,
  });
  if (!projectSlug) return null;

  const auth = await tryAuthenticateSessionRequest(input.request, input.appConfig);
  if (!auth?.orgSlug) return null;

  return Response.redirect(
    new URL(
      `/orgs/${encodeURIComponent(auth.orgSlug)}/projects/${encodeURIComponent(projectSlug)}/run-code`,
      input.url,
    ),
    302,
  );
}

/**
 * Best-effort session check used only for the project-host root redirect. The
 * actual app routes still enforce auth through TanStack Start route loaders, so
 * failures here intentionally fall through to the normal Clerk sign-in path.
 */
async function tryAuthenticateSessionRequest(request: Request, appConfig: AppConfig) {
  try {
    const clerk = createClerkClient({
      secretKey: appConfig.clerk.secretKey.exposeSecret(),
      publishableKey: appConfig.clerk.publishableKey,
      jwtKey: appConfig.clerk.jwtKey.exposeSecret(),
    });
    const requestState = await clerk.authenticateRequest(request);
    const sessionAuth = requestState.toAuth() as {
      isAuthenticated: boolean;
      orgSlug?: string | null;
    };
    if (!sessionAuth.isAuthenticated) return null;
    return { orgSlug: sessionAuth.orgSlug ?? null };
  } catch {
    return null;
  }
}

/**
 * Resolves project-host requests while reserving the configured dashboard host.
 *
 * OS2 preview uses `os.iterate-preview-N.app` for the dashboard and
 * `<project>.iterate-preview-N.app` for project/MCP hosts. Because both sit
 * under the same wildcard route, the worker must exclude AppConfig `baseUrl`
 * before interpreting the leftmost label as a project slug. Cloudflare Worker
 * routes allow a specific route and wildcard route to point at the same Worker;
 * this resolver is the runtime split between those two roles.
 * https://developers.cloudflare.com/workers/configuration/routing/routes/
 */
function resolveProjectSlugForProjectHostname(input: {
  appConfig: AppConfig;
  hostname: string;
  projectHostnameBases: readonly string[];
}) {
  const dashboardHostname = input.appConfig.baseUrl
    ? normalizeRequestHostname(new URL(input.appConfig.baseUrl).hostname)
    : null;
  const requestHostname = normalizeRequestHostname(input.hostname);
  if (dashboardHostname && requestHostname === dashboardHostname) return undefined;

  return resolveProjectSlugFromHostname(requestHostname, input.projectHostnameBases);
}

const mcpCorsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};

function isMcpProtectedResourceMetadataRequest(url: URL) {
  return (
    url.pathname === "/.well-known/oauth-protected-resource" ||
    url.pathname === "/.well-known/oauth-protected-resource/mcp"
  );
}

function mcpProtectedResourceMetadataResponse(request: Request, appConfig: AppConfig) {
  const url = new URL(request.url);
  // MCP OAuth clients discover the Clerk authorization server through RFC 9728
  // protected-resource metadata. Clerk's helper emits the standard shape and
  // points clients at the Clerk Frontend API auth server:
  // https://github.com/clerk/mcp-tools
  // https://clerk.com/docs/nextjs/mcp/build-mcp-server
  const metadata = generateProtectedResourceMetadata({
    authServerUrl: deriveClerkFrontendApiUrl(appConfig.clerk.publishableKey),
    resourceUrl: new URL("/mcp", url.origin).toString(),
    properties: {
      scopes_supported: appConfig.clerk.mcpOauthScopes,
      service_documentation: "https://clerk.com/docs",
    },
  });

  return Response.json(metadata, { headers: mcpCorsHeaders });
}

async function authenticateMcpRequest(request: Request, appConfig: AppConfig) {
  const token = readBearerToken(request);
  if (!token) {
    return unauthorizedMcpResponse(request, "Missing bearer token");
  }

  try {
    const clerk = createClerkClient({
      secretKey: appConfig.clerk.secretKey.exposeSecret(),
      publishableKey: appConfig.clerk.publishableKey,
      jwtKey: appConfig.clerk.jwtKey.exposeSecret(),
    });
    const requestState = await clerk.authenticateRequest(request, {
      acceptsToken: "oauth_token",
    });
    const oauthAuth = requestState.toAuth();

    if (!oauthAuth.isAuthenticated) {
      return unauthorizedMcpResponse(request, "Invalid bearer token");
    }

    // `authenticateRequest({ acceptsToken: "oauth_token" })` is the Clerk-owned
    // validation path for MCP bearer tokens. We read JWT claims only after that
    // succeeds because OS2 still needs Clerk's org claim shape (`o.id`, `o.rol`,
    // `o.per`) for local authorization and lifecycle event attribution.
    const claims = await tryReadJwtClaims(token, appConfig);
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
    } satisfies IterateMcpServerProps;
  } catch {
    return unauthorizedMcpResponse(request, "Invalid bearer token");
  }
}

async function tryReadJwtClaims(token: string, appConfig: AppConfig) {
  try {
    return (await verifyToken(token, {
      jwtKey: appConfig.clerk.jwtKey.exposeSecret(),
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
  const metadataUrl = new URL("/.well-known/oauth-protected-resource/mcp", request.url);
  return new Response(message, {
    status: 401,
    headers: {
      ...mcpCorsHeaders,
      "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl.toString()}"`,
    },
  });
}

function deriveClerkFrontendApiUrl(publishableKey: string) {
  const encoded = publishableKey.replace(/^pk_(?:test|live)_/, "");
  return `https://${atob(encoded).replace(/\$/, "")}`;
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
