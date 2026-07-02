import { createIterateAuth, type AccessTokenClaims } from "@iterate-com/auth/server";
import {
  ITERATE_ACCESS_TOKEN_ORGANIZATIONS_CLAIM,
  ITERATE_ACCESS_TOKEN_PROJECTS_CLAIM,
  ITERATE_IS_ADMIN_CLAIM,
  ITERATE_ROLE_CLAIM,
  listProjectScopeIds,
} from "@iterate-com/shared/auth-claims";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";
import packageJson from "../../../package.json" with { type: "json" };
import { authenticateAdminApiSecret, readBearerToken } from "~/auth/admin.ts";
import { createAuthWorkerServiceClient } from "~/auth/auth-worker-service.ts";
import { principalFromAccessToken } from "~/auth/principal.ts";
import { listAllProjects } from "~/db/queries/.generated/index.ts";
import {
  acceptedMcpResourceAudiences,
  isMcpProtectedResourceMetadataPath,
  mcpChallengeHeader,
  mcpOAuthScopes,
  publicMcpResourceUrl,
  publicRequestUrl,
} from "~/domains/inbound-mcp-server/mcp-auth-metadata.ts";
import {
  handleMcpDebugRequest,
  matchMcpDebugRequest,
} from "~/domains/inbound-mcp-server/mcp-debug-handler.ts";
import { projectContextRef } from "~/itx/coordinates.ts";
import type { ItxRuntime } from "~/itx/handle.ts";
import { runItxScript } from "~/itx/run.ts";
import { MCP_START_MOUNT_PATH } from "~/lib/mcp-base-url.ts";
import type { RequestContext } from "~/request-context.ts";

type ProjectGrant = {
  id: string;
  slug: string;
};

type McpAuth = {
  authType: "admin_api_secret" | "oauth_access_token";
  projects: ProjectGrant[];
  scopes: string[];
};

const requiredToolScope = "profile";

const ExecJsInput = z.object({
  code: z
    .string()
    .describe(
      "JavaScript async arrow function to execute, e.g. async (itx) => { return await itx.describe(); }",
    ),
  project: z.string().optional().describe("Project slug to run this code against."),
});

export const mcpCorsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID, Accept",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};

export async function handleInboundMcpRequest(input: {
  context: RequestContext;
  env: Env;
  request: Request;
}): Promise<Response> {
  const pathname = new URL(input.request.url).pathname;
  if (input.request.method === "OPTIONS") {
    return new Response(null, { headers: mcpCorsHeaders });
  }
  const debugRoute = matchMcpDebugRequest(pathname);
  if (debugRoute) {
    return await handleMcpDebugRequest({ ...input, route: debugRoute });
  }
  if (isMcpProtectedResourceMetadataPath(pathname)) {
    return Response.json(protectedResourceMetadata(input), { headers: mcpCorsHeaders });
  }
  if (pathname !== MCP_START_MOUNT_PATH && pathname !== `${MCP_START_MOUNT_PATH}/`) {
    return new Response("Not found", { status: 404, headers: mcpCorsHeaders });
  }

  const auth = await resolveMcpAuth(input);
  if (auth instanceof Response) return auth;

  const server = createServer({ ...input, auth });
  const handler = createMcpHandler(server, {
    enableJsonResponse: true,
    route: MCP_START_MOUNT_PATH,
    sessionIdGenerator: undefined,
  });
  return withCorsHeaders(
    await handler(input.request, input.env, mcpExecutionContext(input.context)),
  );
}

function createServer(input: { auth: McpAuth; context: RequestContext; env: Env }) {
  const server = new McpServer(
    { name: "os", version: packageJson.version },
    {
      instructions: [
        "This is an Iterate OS project MCP server.",
        "Use exec_js to run a JavaScript async arrow function against a project.",
      ].join("\n"),
    },
  );

  const projects = input.auth.projects;
  const requireProjectInput = input.auth.authType === "admin_api_secret" || projects.length > 1;

  server.registerTool(
    "exec_js",
    {
      title: "Run code",
      description:
        "Execute JavaScript against an Iterate project. The code must be a single async arrow function: async (itx) => { ... }.",
      inputSchema: ExecJsInput,
    },
    async (rawInput) => {
      const parsedInput = ExecJsInput.parse(rawInput);
      const project = resolveToolProject(projects, parsedInput.project, { requireProjectInput });
      requireScope(input.auth, requiredToolScope);

      const workerExports = input.context.workerExports;
      if (!workerExports) throw new Error("MCP exec_js needs workerExports in request context.");

      const outcome = await runItxScript({
        env: input.env,
        exports: workerExports as unknown as ItxRuntime["exports"],
        functionSource: parsedInput.code,
        projectId: project.id,
        props: { context: projectContextRef(project.id) },
      });

      const parts: string[] = [];
      if (outcome.logs.length > 0) parts.push(`Console:\n${outcome.logs.join("\n")}`);
      parts.push(
        outcome.ok
          ? `Result: ${JSON.stringify(outcome.result, null, 2)}`
          : `Error: ${outcome.error}`,
      );

      return {
        content: [{ type: "text" as const, text: parts.join("\n\n") }],
        isError: !outcome.ok,
      };
    },
  );

  return server;
}

async function resolveMcpAuth(input: {
  context: RequestContext;
  env: Env;
  request: Request;
}): Promise<McpAuth | Response> {
  if (authenticateAdminApiSecret(input.context, input.request)) {
    const projects = await listAllProjects(input.context.db, { limit: 10_000, offset: 0 });
    if (projects.length === 0) {
      return new Response("No projects are available to this admin MCP token.", {
        status: 403,
        headers: mcpCorsHeaders,
      });
    }
    return {
      authType: "admin_api_secret",
      projects: projects.map((project) => ({
        id: project.id,
        slug: project.slug,
      })),
      scopes: [],
    };
  }

  const mcpAudiences = acceptedMcpResourceAudiences(input);
  const auth = createMcpIterateAuth(input, mcpAudiences);
  if (!auth) {
    logGrokMcpAuthFailure(input, {
      branch: "iterate_auth_not_configured",
      authHeaderPresent: Boolean(input.request.headers.get("authorization")),
    });
    return new Response("Iterate auth is not configured.", {
      status: 503,
      headers: mcpCorsHeaders,
    });
  }

  const bearerToken = readBearerToken(input.request.headers.get("authorization"));
  const resolvedToken = await resolveOAuthAccessToken({
    ...input,
    auth,
    bearerToken,
    audiences: mcpAudiences,
  });
  if (!resolvedToken) {
    logGrokMcpAuthFailure(input, {
      branch: bearerToken ? "token_decode_or_verify_failed" : "no_bearer_token",
      authHeaderPresent: Boolean(input.request.headers.get("authorization")),
      bearerTokenPresent: Boolean(bearerToken),
      jwt: bearerToken ? safelyReadJwtMetadata(bearerToken) : null,
    });
    return unauthorizedMcpResponse(input, "Missing or invalid bearer token");
  }
  const { accessToken, verificationMode } = resolvedToken;
  const audiences = Array.isArray(accessToken.aud) ? accessToken.aud : [accessToken.aud];
  if (!audiences.some((audience) => mcpAudiences.includes(audience))) {
    logGrokMcpAuthFailure(input, {
      branch: "audience_mismatch",
      verificationMode,
      authHeaderPresent: true,
      bearerTokenPresent: true,
      acceptedAudiences: mcpAudiences,
      jwt: safeAccessTokenMetadata(accessToken),
    });
    return unauthorizedMcpResponse(input, "Bearer token is not scoped to this MCP resource");
  }

  const scopes = readAccessTokenScopes(accessToken);
  const principal = principalFromAccessToken(accessToken);
  const grantedProjectIds = new Set(listProjectScopeIds(scopes));
  const projects = principal.projects.flatMap((project) => {
    if (!principal.isAdmin && !grantedProjectIds.has(project.id)) return [];

    return [
      {
        id: project.id,
        slug: project.slug,
      } satisfies ProjectGrant,
    ];
  });

  if (projects.length === 0) {
    logGrokMcpAuthFailure(input, {
      branch: "no_project_grants",
      verificationMode,
      authHeaderPresent: true,
      bearerTokenPresent: true,
      jwt: safeAccessTokenMetadata(accessToken),
      scopes,
      projectCount: principal.projects.length,
    });
    return forbiddenMcpResponse(input, "MCP token does not grant access to any projects.");
  }

  logGrokMcpAuthSuccess(input, {
    verificationMode,
    scopes,
    projectCount: projects.length,
    jwt: safeAccessTokenMetadata(accessToken),
  });

  return {
    authType: "oauth_access_token",
    projects,
    scopes,
  };
}

async function resolveOAuthAccessToken(input: {
  auth: ReturnType<typeof createIterateAuth>;
  bearerToken: string | null;
  context: RequestContext;
  request: Request;
  audiences: readonly string[];
}): Promise<{
  accessToken: AccessTokenClaims;
  verificationMode: "jwt" | "opaque-internal";
} | null> {
  const accessToken = await input.auth.authenticateBearer({ headers: input.request.headers });
  if (accessToken) return { accessToken, verificationMode: "jwt" };
  if (!input.bearerToken) return null;

  try {
    const result = await createAuthWorkerServiceClient(
      input.context,
    ).internal.oauth.introspectAccessToken({
      token: input.bearerToken,
      audiences: [...input.audiences],
    });
    if (!result.active) {
      logGrokMcpAuthFailure(input, {
        branch: "opaque_internal_introspection_inactive",
        introspectionReason: result.reason,
      });
      return null;
    }

    return {
      verificationMode: "opaque-internal",
      accessToken: {
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
      },
    };
  } catch (error) {
    logGrokMcpAuthFailure(input, {
      branch: "opaque_internal_introspection_error",
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function createMcpIterateAuth(
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

function readAccessTokenScopes(accessToken: { scope?: string; scopes?: string[] }) {
  if (accessToken.scopes) return accessToken.scopes;
  return accessToken.scope?.split(" ").filter(Boolean) ?? [];
}

function resolveToolProject(
  projects: ProjectGrant[],
  requestedProject: string | undefined,
  options: { requireProjectInput: boolean },
) {
  if (!options.requireProjectInput && !requestedProject) return projects[0];

  const normalizedRequestedProject = requestedProject?.trim();
  if (!normalizedRequestedProject) throw new Error("Pass a project slug.");

  const project = projects.find((candidate) => candidate.slug === normalizedRequestedProject);
  if (!project) {
    throw new Error(`MCP token does not grant access to project: ${normalizedRequestedProject}`);
  }
  return project;
}

function requireScope(auth: McpAuth, scope: string) {
  if (auth.authType === "admin_api_secret") return;
  if (!auth.scopes.includes(scope)) {
    throw new Error(`MCP token is missing required scope: ${scope}`);
  }
}

function protectedResourceMetadata(input: { context: RequestContext; request: Request }) {
  return {
    resource: publicMcpResourceUrl(input),
    authorization_servers: [
      input.context.config.iterateAuth?.issuer ?? "https://auth.iterate.com/api/auth",
    ],
    scopes_supported: mcpOAuthScopes,
    bearer_methods_supported: ["header"],
  };
}

function unauthorizedMcpResponse(
  input: { context: RequestContext; request: Request },
  message: string,
) {
  const metadataUrl = new URL(
    ".well-known/oauth-protected-resource",
    `${publicMcpResourceUrl(input)}/`,
  ).toString();
  return new Response(message, {
    status: 401,
    headers: {
      ...mcpCorsHeaders,
      "WWW-Authenticate": mcpChallengeHeader({
        error: "invalid_token",
        errorDescription: message,
        metadataUrl,
      }),
    },
  });
}

function forbiddenMcpResponse(
  input: { context: RequestContext; request: Request },
  message: string,
) {
  const metadataUrl = new URL(
    ".well-known/oauth-protected-resource",
    `${publicMcpResourceUrl(input)}/`,
  ).toString();
  return new Response(message, {
    status: 403,
    headers: {
      ...mcpCorsHeaders,
      "WWW-Authenticate": mcpChallengeHeader({
        error: "insufficient_scope",
        errorDescription: message,
        metadataUrl,
      }),
    },
  });
}

function logGrokMcpAuthFailure(
  input: { context: RequestContext; request: Request },
  fields: Record<string, unknown>,
) {
  const userAgent = input.request.headers.get("user-agent") ?? "";
  if (!/\bgrok\b/i.test(userAgent)) return;

  input.context.log.info("os.mcp.grok_auth_failure");
  input.context.log.set({
    mcpAuth: {
      method: input.request.method,
      url: publicRequestUrl(input.request).toString(),
      userAgent,
      ...fields,
    },
  });
  console.info(
    "[DEBUG-GROK-MCP]",
    JSON.stringify({
      event: "real_os_auth_failure",
      method: input.request.method,
      url: publicRequestUrl(input.request).toString(),
      userAgent,
      ...fields,
    }),
  );
}

function logGrokMcpAuthSuccess(
  input: { context: RequestContext; request: Request },
  fields: Record<string, unknown>,
) {
  const userAgent = input.request.headers.get("user-agent") ?? "";
  if (!/\bgrok\b/i.test(userAgent)) return;

  input.context.log.info("os.mcp.grok_auth_success");
  input.context.log.set({
    mcpAuth: {
      method: input.request.method,
      url: publicRequestUrl(input.request).toString(),
      userAgent,
      ...fields,
    },
  });
  console.info(
    "[DEBUG-GROK-MCP]",
    JSON.stringify({
      event: "real_os_auth_success",
      method: input.request.method,
      url: publicRequestUrl(input.request).toString(),
      userAgent,
      ...fields,
    }),
  );
}

type JwtMetadata = {
  iss?: string;
  aud?: string | string[];
  scope?: string;
  scopes?: string[];
  exp?: number;
};

function safeAccessTokenMetadata(accessToken: JwtMetadata): JwtMetadata {
  return {
    iss: typeof accessToken.iss === "string" ? accessToken.iss : undefined,
    aud: safeJwtAudience(accessToken.aud),
    scope: typeof accessToken.scope === "string" ? accessToken.scope : undefined,
    scopes: Array.isArray(accessToken.scopes)
      ? accessToken.scopes.filter((scope) => typeof scope === "string")
      : undefined,
    exp: typeof accessToken.exp === "number" ? accessToken.exp : undefined,
  };
}

function safelyReadJwtMetadata(token: string): JwtMetadata | null {
  const payload = token.split(".")[1];
  if (!payload) return null;

  try {
    const json = atob(toBase64(payload));
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return null;
    const claims = parsed as JwtMetadata;
    return safeAccessTokenMetadata(claims);
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

function mcpExecutionContext(context: RequestContext): ExecutionContext {
  return {
    exports: context.workerExports ?? ({} as Cloudflare.Exports),
    passThroughOnException() {},
    props: {},
    waitUntil: (promise: Promise<unknown>) => context.waitUntil?.(promise),
  } as ExecutionContext;
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
