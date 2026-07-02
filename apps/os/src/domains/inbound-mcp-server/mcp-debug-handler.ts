import { createIterateAuth, type AccessTokenClaims } from "@iterate-com/auth/server";
import {
  ITERATE_ACCESS_TOKEN_ORGANIZATIONS_CLAIM,
  ITERATE_ACCESS_TOKEN_PROJECTS_CLAIM,
  ITERATE_IS_ADMIN_CLAIM,
  ITERATE_ROLE_CLAIM,
  listProjectScopeIds,
} from "@iterate-com/shared/auth-claims";
import { expandOAuthResourceAudienceVariants } from "@iterate-com/shared/oauth-resource";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  acceptedMcpResourceAudiences,
  mcpChallengeHeader,
  mcpOAuthScopes,
  publicMcpResourceUrl,
  publicRequestUrl,
} from "~/domains/inbound-mcp-server/mcp-auth-metadata.ts";
import { createAuthWorkerServiceClient } from "~/auth/auth-worker-service.ts";
import { principalFromAccessToken } from "~/auth/principal.ts";
import { MCP_START_MOUNT_PATH } from "~/lib/mcp-base-url.ts";
import type { RequestContext } from "~/request-context.ts";

const debugLogPrefix = "[DEBUG-GROK-MCP]";
const debugMountPath = `${MCP_START_MOUNT_PATH}/debug`;

const debugVariants = {
  public: { auth: "none" },
  "oauth-optional": { auth: "optional-bearer" },
  "oauth-required": { auth: "required-bearer" },
  "oauth-required-scope-empty": { auth: "required-bearer-empty-scope" },
  "oauth-verify-token": { auth: "verify-bearer", resource: "debug-path" },
  "oauth-project-grants": { auth: "project-grants", resource: "debug-path" },
  "oauth-verify-mcp-base": { auth: "verify-bearer", resource: "mcp-base" },
  "oauth-project-grants-mcp-base": { auth: "project-grants", resource: "mcp-base" },
  "oauth-verify-debug-accept-mcp-base": {
    auth: "verify-bearer",
    resource: "debug-path",
    acceptedAudiences: "debug-and-mcp-base",
  },
  "oauth-project-grants-debug-accept-mcp-base": {
    auth: "project-grants",
    resource: "debug-path",
    acceptedAudiences: "debug-and-mcp-base",
  },
} as const;

type DebugVariantName = keyof typeof debugVariants;
type DebugRoute = {
  kind: "mcp" | "protectedResourceMetadata";
  variant: DebugVariantName;
};

const debugMcpHandler = createMcpHandler(({ authInfo }) => {
  const variant =
    typeof authInfo?.extra === "object" &&
    authInfo.extra != null &&
    "variant" in authInfo.extra &&
    typeof authInfo.extra.variant === "string" &&
    isDebugVariant(authInfo.extra.variant)
      ? authInfo.extra.variant
      : "public";

  const server = new McpServer(
    { name: `os-mcp-debug-${variant}`, version: "0.0.1" },
    { instructions: "Debug-only dummy MCP server for Grok interoperability probes." },
  );

  server.registerTool(
    "ping",
    {
      title: "Ping",
      description: "Return a small diagnostic pong payload.",
      inputSchema: z.object({
        message: z.string().optional().describe("Optional message to echo."),
      }),
    },
    async ({ message }) => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            ok: true,
            variant,
            message: message ?? "pong",
            authInfo: {
              clientId: authInfo?.clientId ?? null,
              scopes: authInfo?.scopes ?? [],
              hasToken: Boolean(authInfo?.token),
            },
          }),
        },
      ],
    }),
  );

  server.registerTool(
    "echo_json",
    {
      title: "Echo JSON",
      description: "Return the provided JSON value.",
      inputSchema: z.object({
        value: z.unknown().optional().describe("Any JSON value."),
      }),
    },
    async ({ value }) => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ ok: true, variant, value: value ?? null }),
        },
      ],
    }),
  );

  return server;
});

export function matchMcpDebugRequest(pathname: string): DebugRoute | null {
  const direct = matchDirectDebugEndpoint(pathname);
  if (direct) return { kind: "mcp", variant: direct };

  if (!pathname.includes("/.well-known/oauth-protected-resource")) return null;
  const metadata = matchDebugVariantFromPath(pathname);
  if (!metadata) return null;
  return { kind: "protectedResourceMetadata", variant: metadata };
}

export async function handleMcpDebugRequest(input: {
  context: RequestContext;
  request: Request;
  route: DebugRoute;
}): Promise<Response> {
  const variant = debugVariants[input.route.variant];

  if (input.request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: debugCorsHeaders });
  }

  if (input.route.kind === "protectedResourceMetadata") {
    logMcpDebug(input, {
      event: "metadata",
      variant: input.route.variant,
      authMode: variant.auth,
    });
    return Response.json(debugProtectedResourceMetadata(input), { headers: debugCorsHeaders });
  }

  const authHeader = input.request.headers.get("authorization");
  const bearerToken = readBearerToken(authHeader);
  if (variant.auth !== "none" && variant.auth !== "optional-bearer" && !bearerToken) {
    logMcpDebug(input, {
      event: "auth_challenge",
      variant: input.route.variant,
      authMode: variant.auth,
      authHeaderPresent: Boolean(authHeader),
      bearerTokenPresent: false,
      body: await readBodySummary(input.request.clone()),
    });
    return debugUnauthorizedResponse(input, "Missing bearer token for debug MCP variant.");
  }

  const verifiedAuth =
    variant.auth === "verify-bearer" || variant.auth === "project-grants"
      ? await verifyDebugBearerToken(input, bearerToken)
      : null;
  if (verifiedAuth instanceof Response) return verifiedAuth;

  if (variant.auth === "project-grants" && verifiedAuth) {
    const grantCheck = resolveDebugProjectGrants(input, verifiedAuth.accessToken);
    if (grantCheck instanceof Response) {
      logMcpDebug(input, {
        event: "project_grants_missing",
        variant: input.route.variant,
        authMode: variant.auth,
        jwt: safeAccessTokenMetadata(verifiedAuth.accessToken),
        scopes: verifiedAuth.scopes,
        projectCount: 0,
      });
      return grantCheck;
    }
    logMcpDebug(input, {
      event: "project_grants_verified",
      variant: input.route.variant,
      authMode: variant.auth,
      jwt: safeAccessTokenMetadata(verifiedAuth.accessToken),
      scopes: verifiedAuth.scopes,
      projectCount: grantCheck.projectCount,
    });
  }

  logMcpDebug(input, {
    event: "mcp_request",
    variant: input.route.variant,
    authMode: variant.auth,
    authHeaderPresent: Boolean(authHeader),
    bearerTokenPresent: Boolean(bearerToken),
    tokenShape: bearerToken ? safeBearerTokenShape(bearerToken) : null,
    jwt: verifiedAuth
      ? safeAccessTokenMetadata(verifiedAuth.accessToken)
      : bearerToken
        ? safelyReadJwtMetadata(bearerToken)
        : null,
    body: await readBodySummary(input.request.clone()),
  });

  return withDebugCorsHeaders(
    await debugMcpHandler.fetch(input.request, {
      authInfo: {
        token: bearerToken ?? "debug-public",
        clientId:
          verifiedAuth?.clientId ?? (bearerToken ? "debug-bearer-client" : "debug-public-client"),
        scopes: verifiedAuth?.scopes ?? (bearerToken ? ["debug"] : []),
        extra: { variant: input.route.variant },
      },
    }),
  );
}

function matchDirectDebugEndpoint(pathname: string) {
  const prefix = `${debugMountPath}/`;
  if (!pathname.startsWith(prefix)) return null;
  const variant = pathname.slice(prefix.length).replace(/\/+$/, "");
  return isDebugVariant(variant) ? variant : null;
}

function matchDebugVariantFromPath(pathname: string) {
  const match = /\/debug\/([^/]+)/.exec(pathname);
  const variant = match?.[1];
  return variant && isDebugVariant(variant) ? variant : null;
}

function isDebugVariant(value: string): value is DebugVariantName {
  return value in debugVariants;
}

function debugProtectedResourceMetadata(input: {
  context: RequestContext;
  request: Request;
  route: DebugRoute;
}) {
  return {
    resource: publicMcpDebugOAuthResourceUrl(input),
    authorization_servers: [
      input.context.config.iterateAuth?.issuer ?? "https://auth.iterate.com/api/auth",
    ],
    scopes_supported:
      debugVariants[input.route.variant].auth === "required-bearer-empty-scope"
        ? []
        : mcpOAuthScopes,
    bearer_methods_supported: ["header"],
    resource_name: `os-mcp-debug-${input.route.variant}`,
  };
}

function debugUnauthorizedResponse(
  input: { context: RequestContext; request: Request; route: DebugRoute },
  message: string,
) {
  return new Response(message, {
    status: 401,
    headers: {
      ...debugCorsHeaders,
      "WWW-Authenticate": mcpChallengeHeader({
        error: "invalid_token",
        errorDescription: message,
        metadataUrl: publicMcpDebugOAuthMetadataUrl(input),
      }),
    },
  });
}

function debugForbiddenResponse(
  input: { context: RequestContext; request: Request; route: DebugRoute },
  message: string,
) {
  return new Response(message, {
    status: 403,
    headers: {
      ...debugCorsHeaders,
      "WWW-Authenticate": mcpChallengeHeader({
        error: "insufficient_scope",
        errorDescription: message,
        metadataUrl: publicMcpDebugOAuthMetadataUrl(input),
      }),
    },
  });
}

async function verifyDebugBearerToken(
  input: { context: RequestContext; request: Request; route: DebugRoute },
  bearerToken: string | null,
): Promise<
  | {
      accessToken: AccessTokenClaims;
      clientId: string;
      scopes: string[];
    }
  | Response
  | null
> {
  if (!bearerToken) return null;

  const acceptedAudiences = debugAcceptedAudiences(input);
  const tokenShape = safeBearerTokenShape(bearerToken);
  logMcpDebug(input, {
    event: "token_verify_attempt",
    variant: input.route.variant,
    authMode: debugVariants[input.route.variant].auth,
    acceptedAudiences,
    tokenShape,
  });
  const auth = createDebugIterateAuth(input, acceptedAudiences);
  if (!auth) {
    logMcpDebug(input, {
      event: "iterate_auth_not_configured",
      variant: input.route.variant,
      acceptedAudiences,
    });
    return new Response("Iterate auth is not configured for debug MCP variant.", {
      status: 503,
      headers: debugCorsHeaders,
    });
  }

  const accessToken = await auth.authenticateBearer({ headers: input.request.headers });
  if (!accessToken) {
    const opaqueAuth = await introspectDebugOpaqueBearerToken({
      ...input,
      bearerToken,
      acceptedAudiences,
    });
    if (opaqueAuth) return opaqueAuth;

    logMcpDebug(input, {
      event: "token_verify_failed",
      variant: input.route.variant,
      authHeaderPresent: Boolean(input.request.headers.get("authorization")),
      bearerTokenPresent: true,
      acceptedAudiences,
      tokenShape,
    });
    return debugUnauthorizedResponse(
      input,
      "Bearer token failed Iterate Auth verification for debug MCP variant.",
    );
  }

  logMcpDebug(input, {
    event: "token_verified",
    variant: input.route.variant,
    acceptedAudiences,
    jwt: safeAccessTokenMetadata(accessToken),
    scopes: readAccessTokenScopes(accessToken),
  });
  return {
    accessToken,
    clientId: "debug-verified-client",
    scopes: readAccessTokenScopes(accessToken),
  };
}

async function introspectDebugOpaqueBearerToken(input: {
  context: RequestContext;
  request: Request;
  route: DebugRoute;
  bearerToken: string;
  acceptedAudiences: readonly string[];
}): Promise<{
  accessToken: AccessTokenClaims;
  clientId: string;
  scopes: string[];
} | null> {
  try {
    const result = await createAuthWorkerServiceClient(
      input.context,
    ).internal.oauth.introspectAccessToken({
      token: input.bearerToken,
      audiences: [...input.acceptedAudiences],
    });
    if (!result.active) {
      logMcpDebug(input, {
        event: "opaque_internal_introspection_inactive",
        variant: input.route.variant,
        reason: result.reason,
      });
      return null;
    }

    const accessToken: AccessTokenClaims = {
      sub: result.sub,
      sid: result.sid,
      iss: result.iss,
      aud: result.aud,
      iat: result.iat,
      exp: result.exp,
      scope: result.scope,
      scopes: result.scopes,
      [ITERATE_ACCESS_TOKEN_ORGANIZATIONS_CLAIM]: result.organizations,
      [ITERATE_ACCESS_TOKEN_PROJECTS_CLAIM]: result.projects,
      [ITERATE_IS_ADMIN_CLAIM]: result.isAdmin,
      [ITERATE_ROLE_CLAIM]: result.role,
    };
    logMcpDebug(input, {
      event: "opaque_internal_introspection_active",
      variant: input.route.variant,
      clientId: result.clientId,
      jwt: safeAccessTokenMetadata(accessToken),
      scopes: result.scopes,
    });
    return {
      accessToken,
      clientId: result.clientId,
      scopes: result.scopes,
    };
  } catch (error) {
    logMcpDebug(input, {
      event: "opaque_internal_introspection_error",
      variant: input.route.variant,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function createDebugIterateAuth(
  input: { context: RequestContext; request: Request },
  resources: readonly string[],
) {
  const config = input.context.config.iterateAuth;
  if (!config) return null;

  const requestOrigin = new URL(input.request.url).origin;
  const baseUrl = (input.context.config.baseUrl ?? requestOrigin).replace(/\/+$/, "");
  return createIterateAuth({
    issuer: config.issuer,
    clientId: config.clientId,
    clientSecret: config.clientSecret.exposeSecret(),
    jwks: config.jwks,
    redirectURI: `${baseUrl}/api/iterate-auth/callback`,
    resource: [...resources],
  });
}

function resolveDebugProjectGrants(
  input: { context: RequestContext; request: Request; route: DebugRoute },
  accessToken: AccessTokenClaims,
) {
  const scopes = readAccessTokenScopes(accessToken);
  const grantedProjectIds = new Set(listProjectScopeIds(scopes));
  const principal = principalFromAccessToken(accessToken);
  const projectCount = principal.projects.filter(
    (project) => principal.isAdmin || grantedProjectIds.has(project.id),
  ).length;

  if (projectCount === 0) {
    return debugForbiddenResponse(input, "Debug MCP token does not grant access to any projects.");
  }

  return { projectCount };
}

async function readBodySummary(request: { body: ReadableStream | null; text(): Promise<string> }) {
  if (!request.body) return null;
  try {
    const text = await request.text();
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => summarizeJsonRpc(item));
    }
    return summarizeJsonRpc(parsed);
  } catch {
    return { unreadable: true };
  }
}

function summarizeJsonRpc(raw: unknown) {
  if (!raw || typeof raw !== "object") return { type: typeof raw };
  const request = raw as {
    id?: string | number | null;
    method?: string;
    params?: unknown;
  };
  return {
    id: request.id ?? null,
    method: request.method ?? null,
    hasParams: request.params != null,
  };
}

function publicMcpDebugOAuthResourceUrl(input: {
  context: RequestContext;
  request: Request;
  route: DebugRoute;
}) {
  const variant = debugVariants[input.route.variant];
  if ("resource" in variant && variant.resource === "mcp-base") {
    return publicMcpResourceUrl(input);
  }

  return publicMcpDebugResourceUrl(input);
}

function debugAcceptedAudiences(input: {
  context: RequestContext;
  request: Request;
  route: DebugRoute;
}) {
  const variant = debugVariants[input.route.variant];
  if ("acceptedAudiences" in variant && variant.acceptedAudiences === "debug-and-mcp-base") {
    return expandOAuthResourceAudienceVariants([
      publicMcpDebugResourceUrl(input),
      ...acceptedMcpResourceAudiences(input),
    ]);
  }

  if ("resource" in variant && variant.resource === "mcp-base") {
    return acceptedMcpResourceAudiences(input);
  }

  return expandOAuthResourceAudienceVariants([publicMcpDebugResourceUrl(input)]);
}

function publicMcpDebugResourceUrl(input: {
  context: RequestContext;
  request: Request;
  route: DebugRoute;
}) {
  const publicUrl = publicRequestUrl(input.request);
  const mcpBaseUrl = input.context.config.mcp?.baseUrl;
  if (
    mcpBaseUrl &&
    publicUrl.hostname.toLowerCase() === new URL(mcpBaseUrl).hostname.toLowerCase()
  ) {
    return `${mcpBaseUrl.replace(/\/+$/, "")}/debug/${input.route.variant}`;
  }

  const appBaseUrl = input.context.config.baseUrl ?? publicUrl.origin;
  return `${appBaseUrl.replace(/\/+$/, "")}${debugMountPath}/${input.route.variant}`;
}

function publicMcpDebugOAuthMetadataUrl(input: {
  context: RequestContext;
  request: Request;
  route: DebugRoute;
}) {
  const resourceUrl = new URL(publicMcpDebugOAuthResourceUrl(input));
  return `${resourceUrl.origin}/.well-known/oauth-protected-resource${resourceUrl.pathname}`;
}

function readBearerToken(header: string | null) {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return match?.[1]?.trim() || null;
}

type JwtMetadata = {
  iss?: string;
  aud?: string | string[];
  scope?: string;
  scopes?: string[];
  exp?: number;
  projectCount?: number;
  isAdmin?: boolean;
};

type JwtHeaderMetadata = {
  alg?: string;
  kid?: string;
  typ?: string;
};

function readAccessTokenScopes(accessToken: { scope?: string; scopes?: string[] }) {
  if (accessToken.scopes) return accessToken.scopes;
  return accessToken.scope?.split(" ").filter(Boolean) ?? [];
}

function safeAccessTokenMetadata(accessToken: JwtMetadata): JwtMetadata {
  const tokenWithProjectClaims = accessToken as JwtMetadata & { projects?: unknown[] };
  return {
    iss: typeof accessToken.iss === "string" ? accessToken.iss : undefined,
    aud: safeJwtAudience(accessToken.aud),
    scope: typeof accessToken.scope === "string" ? accessToken.scope : undefined,
    scopes: Array.isArray(accessToken.scopes)
      ? accessToken.scopes.filter((scope) => typeof scope === "string")
      : undefined,
    exp: typeof accessToken.exp === "number" ? accessToken.exp : undefined,
    projectCount: Array.isArray(tokenWithProjectClaims.projects)
      ? tokenWithProjectClaims.projects.length
      : undefined,
    isAdmin: typeof accessToken.isAdmin === "boolean" ? accessToken.isAdmin : undefined,
  };
}

function safelyReadJwtMetadata(token: string): JwtMetadata | null {
  const payload = token.split(".")[1];
  if (!payload) return null;

  try {
    const json = atob(toBase64(payload));
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return null;
    return safeAccessTokenMetadata(parsed as JwtMetadata);
  } catch {
    return null;
  }
}

function safeBearerTokenShape(token: string) {
  const parts = token.split(".");
  return {
    length: token.length,
    partCount: parts.length,
    looksJwt: parts.length === 3,
    header: safelyReadJwtHeader(token),
    jwt: safelyReadJwtMetadata(token),
  };
}

function safelyReadJwtHeader(token: string): JwtHeaderMetadata | null {
  const header = token.split(".")[0];
  if (!header) return null;

  try {
    const json = atob(toBase64(header));
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return null;
    const claims = parsed as JwtHeaderMetadata;
    return {
      alg: typeof claims.alg === "string" ? claims.alg : undefined,
      kid: typeof claims.kid === "string" ? claims.kid : undefined,
      typ: typeof claims.typ === "string" ? claims.typ : undefined,
    };
  } catch {
    return null;
  }
}

function safeJwtAudience(aud: unknown) {
  if (typeof aud === "string") return aud;
  if (Array.isArray(aud)) return aud.filter((value) => typeof value === "string");
  return undefined;
}

function toBase64(base64Url: string) {
  const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  return base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
}

function logMcpDebug(input: { request: Request }, fields: Record<string, unknown>) {
  console.info(
    debugLogPrefix,
    JSON.stringify({
      method: input.request.method,
      url: publicRequestUrl(input.request).toString(),
      userAgent: input.request.headers.get("user-agent") ?? "",
      ...fields,
    }),
  );
}

function withDebugCorsHeaders(response: Response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(debugCorsHeaders)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const debugCorsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID, Accept",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};
