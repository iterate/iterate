import { env as workerEnv } from "cloudflare:workers";

// Re-export rpc-targets so loopback-binding callables can resolve them from ctx.exports.
// https://developers.cloudflare.com/workers/runtime-apis/context/#exports
export { OpenApiBridge } from "~/rpc-targets/openapi-bridge.ts";
export { McpClientBridge } from "~/rpc-targets/mcp-client-bridge.ts";
import { parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import { withEvlog } from "@iterate-com/shared/apps/logging/with-evlog";
import { NitroWebSocketResponse } from "@iterate-com/shared/nitro-ws-response";
import handler from "@tanstack/react-start/server-entry";
import { verifyToken } from "@clerk/backend";
import { generateProtectedResourceMetadata } from "@clerk/mcp-tools/server";
import { McpAgent } from "agents/mcp";
import crossws from "crossws/adapters/cloudflare";
import { createD1Client } from "sqlfu";
import manifest, { AppConfig } from "~/app.ts";
import type { AppContext } from "~/context.ts";
import type { IterateMcpServerProps } from "~/durable-objects/iterate-mcp-server.ts";

const config = parseAppConfigFromEnv({
  configSchema: AppConfig,
  prefix: "APP_CONFIG_",
  env: workerEnv,
});

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
        if (isMcpProtectedResourceMetadataRequest(url)) {
          return mcpProtectedResourceMetadataResponse(request, config);
        }

        if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
          if (request.method === "OPTIONS") {
            return new Response(null, { headers: mcpCorsHeaders });
          }

          const mcpAuth = await authenticateMcpRequest(request, config);
          if (mcpAuth instanceof Response) {
            return mcpAuth;
          }

          const ctxWithProps = cfCtx as ExecutionContext & { props?: IterateMcpServerProps };
          ctxWithProps.props = mcpAuth;
          return mcpHandler.fetch(request, env, cfCtx);
        }

        const db = createD1Client(env.DB);
        const context: AppContext = {
          manifest,
          config,
          rawRequest: request,
          db,
          log,
          projectHostnameBases: parseProjectHostnameBases(env.PROJECT_HOSTNAME_BASES),
          loader: env.LOADER,
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

function parseProjectHostnameBases(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const mcpCorsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function isMcpProtectedResourceMetadataRequest(url: URL) {
  return (
    url.pathname === "/.well-known/oauth-protected-resource" ||
    url.pathname === "/.well-known/oauth-protected-resource/mcp"
  );
}

function mcpProtectedResourceMetadataResponse(request: Request, appConfig: AppConfig) {
  const url = new URL(request.url);
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
    const claims = (await verifyToken(token, {
      jwtKey: appConfig.clerk.jwtKey.exposeSecret(),
    })) as Record<string, unknown>;
    const userId = readStringClaim(claims, "sub");
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
      scopes: readScopeClaims(claims),
      clientId: readStringClaim(claims, "client_id"),
    } satisfies IterateMcpServerProps;
  } catch {
    return unauthorizedMcpResponse(request, "Invalid bearer token");
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
