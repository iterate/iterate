import {
  createIterateAuth,
  identityFromAccessToken,
  type AccessTokenClaims,
} from "@iterate-com/auth/server";
import {
  ITERATE_ACCESS_TOKEN_ORGANIZATIONS_CLAIM,
  ITERATE_ACCESS_TOKEN_PROJECTS_CLAIM,
  ITERATE_IS_ADMIN_CLAIM,
  ITERATE_PROJECT_SELECTION_SCOPE,
  ITERATE_ROLE_CLAIM,
  listProjectScopeIds,
} from "@iterate-com/shared/auth-claims";
import { oauthResourceAudienceVariants } from "@iterate-com/shared/oauth-resource";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";
import { env } from "cloudflare:workers";
import packageJson from "../../../package.json" with { type: "json" };
import { ensureMcpSessionAgentReady } from "./mcp-session-agent-ready.ts";
import { resolveMcpSessionAgentPath } from "./mcp-session-agent-path.ts";
import { readInboundMcpToolOptions, type InboundMcpToolOptions } from "./mcp-tool-options.ts";
import {
  EXEC_TYPESCRIPT_DESCRIPTION,
  inboundMcpServerInstructions,
} from "./exec-typescript-description.ts";
import { trustedInternalAuthContext } from "~/auth.ts";
import { authenticateAdminApiSecret, readBearerToken } from "~/auth/admin.ts";
import { principalFromIdentity } from "~/auth/principal.ts";
import { MCP_START_MOUNT_PATH, resolveMcpBaseUrl } from "~/lib/mcp-base-url.ts";
import { readProjectBySlug } from "~/project-directory.ts";
import { ProjectCollectionRpcTarget } from "~/rpc-targets.ts";
import type { RequestContext } from "~/request-context.ts";

type ProjectGrant = {
  id: string;
  slug: string;
};

type McpAuth = {
  authType: "admin_api_secret" | "oauth_access_token";
  projects: ProjectGrant[];
  scopes: string[];
  /** Stable identity for this caller's MCP session agent stream. */
  sessionKey?: string;
};

const requiredToolScope = "profile";
const ASK_ASSISTANT_TIMEOUT_MS = 120_000;
const ExecTypescriptInput = z.object({
  code: z
    .string()
    .describe(
      "One itx TypeScript async arrow function to execute, e.g. async (itx) => { return await itx.__describe(); }. Whatever it returns (JSON-serializable) is the tool result; a thrown error surfaces as the tool error.",
    ),
  project: z.string().optional().describe("Project slug to run this code against."),
});
const AskAssistantInput = z.object({
  message: z.string().trim().min(1).describe("Plain-language request for the project assistant."),
  project: z.string().optional().describe("Project slug to ask the assistant of."),
});

const mcpCorsHeaders = {
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
  if (pathname === `${MCP_START_MOUNT_PATH}/.well-known/oauth-protected-resource`) {
    return Response.json(protectedResourceMetadata(input), { headers: mcpCorsHeaders });
  }
  if (pathname !== MCP_START_MOUNT_PATH && pathname !== `${MCP_START_MOUNT_PATH}/`) {
    return new Response("Not found", { status: 404, headers: mcpCorsHeaders });
  }

  const auth = await resolveMcpAuth(input);
  if (auth instanceof Response) return auth;

  const server = createServer({
    ...input,
    auth,
    toolOptions: readInboundMcpToolOptions(input.request),
  });
  const handler = createMcpHandler(server, {
    enableJsonResponse: true,
    route: MCP_START_MOUNT_PATH,
    sessionIdGenerator: undefined,
  });
  return withCorsHeaders(await handler(input.request, input.env, input.context.executionCtx));
}

function createServer(input: {
  auth: McpAuth;
  context: RequestContext;
  env: Env;
  request: Request;
  toolOptions: InboundMcpToolOptions;
}) {
  const server = new McpServer(
    { name: "os", version: packageJson.version },
    {
      instructions: inboundMcpServerInstructions(input.toolOptions),
    },
  );

  const projects = input.auth.projects;
  const requireProjectInput = input.auth.authType === "admin_api_secret" || projects.length > 1;
  const resolveProject = async (requestedProject: string | undefined) => {
    const project = await resolveToolProject(projects, requestedProject, {
      authType: input.auth.authType,
      requireProjectInput,
    });
    requireScope(input.auth, requiredToolScope);
    return project;
  };
  // Resolved once per inbound request (createServer is per-request), so the
  // no-session fallback maps every tool call in one request to ONE
  // /agents/mcp/request-* stream instead of minting a stream per call.
  let sessionAgentPath: Promise<string> | undefined;
  const resolveSessionAgentPath = () => (sessionAgentPath ??= resolveMcpSessionAgentPath(input));
  // In-process itx: resolveProject verified the caller's access (OAuth project
  // grants / admin secret), so the tool then runs with first-party authority
  // in this same worker — no loopback HTTP batch to our own /api.
  const projectItxFor = (projectId: string) =>
    new ProjectCollectionRpcTarget({
      auth: trustedInternalAuthContext(),
      config: input.context.config,
      ctx: input.context.executionCtx,
    }).get(projectId);

  server.registerTool(
    "exec_typescript",
    {
      title: "Run TypeScript",
      description: EXEC_TYPESCRIPT_DESCRIPTION,
      inputSchema: ExecTypescriptInput,
    },
    async (rawInput) => {
      const parsedInput = ExecTypescriptInput.parse(rawInput);
      const project = await resolveProject(parsedInput.project);

      // runScript executes the async arrow function in a fresh dynamic-worker
      // isolate scoped to this MCP session's agent stream, so the session
      // transcript at /agents/mcp/** records every execution.
      try {
        const agentPath = await resolveSessionAgentPath();
        const projectItx = await projectItxFor(project.id);
        await ensureMcpSessionAgentReady({ agentPath, projectItx });
        const execution = await projectItx.agents
          .get(agentPath)
          .capabilityHost.runScript(parsedInput.code);
        return {
          content: [
            {
              type: "text" as const,
              text: `Result: ${JSON.stringify(execution.result, null, 2)}`,
            },
          ],
          isError: false,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );

  if (input.toolOptions.withAgent) {
    server.registerTool(
      "ask_assistant",
      {
        title: "Ask assistant",
        description:
          "Ask this project's assistant agent in plain language. Blocks until the assistant replies (up to two minutes) and returns its reply. Conversation history lives on this MCP session's agent stream; asks are a plain chat conversation, so send them one at a time — concurrent asks on one session interleave like two people typing into the same chat.",
        inputSchema: AskAssistantInput,
      },
      async (rawInput) => {
        const parsedInput = AskAssistantInput.parse(rawInput);
        const project = await resolveProject(parsedInput.project);
        const agentPath = await resolveSessionAgentPath();

        // agents.ask appends the message and waits for the agent's next chat
        // reply server-side. Reply matching is by order on the session stream,
        // not per-request correlation — the session belongs to this one MCP
        // client, so interleaved replies are the client's own doing (same trust
        // model as one person running exec_typescript mid-conversation).
        let reply;
        try {
          const projectItx = await projectItxFor(project.id);
          await ensureMcpSessionAgentReady({ agentPath, projectItx });
          reply = await projectItx.agents.get(agentPath).ask({
            message: parsedInput.message,
            origin: "mcp",
            timeoutMs: ASK_ASSISTANT_TIMEOUT_MS,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [
              {
                type: "text" as const,
                text: `The assistant did not reply in time: ${message}. The session transcript is the ${agentPath} stream.`,
              },
            ],
            isError: true,
          };
        }

        const message = reply.payload?.message;
        if (typeof message !== "string" || message.trim() === "") {
          return {
            content: [
              {
                type: "text" as const,
                text: `Assistant reply event ${reply.offset} did not include a message. The session transcript is the ${agentPath} stream.`,
              },
            ],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: message }],
          isError: false,
        };
      },
    );
  }

  return server;
}

async function resolveMcpAuth(input: {
  context: RequestContext;
  env: Env;
  request: Request;
}): Promise<McpAuth | Response> {
  if (authenticateAdminApiSecret(input.context, input.request)) {
    // Admin tokens may target any project by slug; the auth worker directory
    // resolves it at call time (there is no local project table anymore).
    return {
      authType: "admin_api_secret",
      projects: [],
      scopes: [],
    };
  }

  const mcpAudiences = oauthResourceAudienceVariants(canonicalMcpResourceUrl(input));
  const auth = createMcpIterateAuth(input, mcpAudiences);
  if (!auth) {
    return new Response("iterate auth is not configured.", {
      status: 503,
      headers: mcpCorsHeaders,
    });
  }

  const resolution = await resolveOAuthAccessToken({ ...input, auth, audiences: mcpAudiences });
  if (resolution.status === "unavailable") {
    return new Response("Authentication service unavailable.", {
      status: 503,
      headers: { ...mcpCorsHeaders, "Retry-After": "5" },
    });
  }
  if (resolution.status === "invalid") {
    return unauthorizedMcpResponse(input, "Missing or invalid bearer token");
  }
  const accessToken = resolution.accessToken;
  const audiences = Array.isArray(accessToken.aud) ? accessToken.aud : [accessToken.aud];
  if (!audiences.some((audience) => mcpAudiences.includes(audience))) {
    return unauthorizedMcpResponse(input, "Bearer token is not scoped to this MCP resource");
  }

  const scopes = readAccessTokenScopes(accessToken);
  const principal = principalFromIdentity(identityFromAccessToken(accessToken));
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
    return new Response("MCP token does not grant access to any projects.", {
      status: 403,
      headers: mcpCorsHeaders,
    });
  }

  return {
    authType: "oauth_access_token",
    projects,
    scopes,
    sessionKey: principal.sessionId
      ? `oauth-session:${principal.sessionId}`
      : `oauth-user:${principal.userId}`,
  };
}

// iterate Auth issues a JWT access token only when the client requests an RFC
// 8707 `resource` (audience); clients that omit it — Grok's connector, generic
// MCP clients — get an OPAQUE token instead. The JWT verifier can't read those,
// so fall back to auth's private RPC introspection method, which validates the
// opaque token against its (hashed) store and reconstructs the same claims.
async function resolveOAuthAccessToken(input: {
  auth: ReturnType<typeof createIterateAuth>;
  context: RequestContext;
  env: Env;
  request: Request;
  audiences: readonly string[];
}): Promise<
  | { status: "authenticated"; accessToken: AccessTokenClaims }
  | { status: "invalid" }
  | { status: "unavailable" }
> {
  const accessToken = await input.auth.authenticateBearer({ headers: input.request.headers });
  if (accessToken) return { status: "authenticated", accessToken };

  const bearerToken = readBearerToken(input.request.headers.get("authorization"));
  if (!bearerToken) return { status: "invalid" };

  try {
    const result = await input.env.AUTH.introspectAccessToken({
      token: bearerToken,
      audiences: [...input.audiences],
    });
    if (!result.active) {
      input.context.log.info("os.mcp.opaque_token_inactive", {
        mcpAuth: {
          opaqueIntrospection: diagnosticIdentifier(result.reason) ?? "inactive",
        },
      });
      return { status: "invalid" };
    }

    return {
      status: "authenticated",
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
    input.context.log.info("os.mcp.opaque_introspection_error", {
      mcpAuth: {
        opaqueIntrospectionErrorType: error instanceof Error ? "Error" : "NonErrorThrowable",
      },
    });
    return { status: "unavailable" };
  }
}

function diagnosticIdentifier(value: unknown) {
  if (typeof value !== "string") return undefined;
  return /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/u.test(value) ? value : undefined;
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

async function resolveToolProject(
  projects: ProjectGrant[],
  requestedProject: string | undefined,
  options: { authType: McpAuth["authType"]; requireProjectInput: boolean },
): Promise<ProjectGrant> {
  if (!options.requireProjectInput && !requestedProject) {
    const project = projects[0];
    if (project) return project;
  }

  const normalizedRequestedProject = requestedProject?.trim();
  if (!normalizedRequestedProject) throw new Error("Pass a project slug.");

  if (options.authType === "admin_api_secret") {
    // KV directory cache in front of the auth worker (also resolves
    // admin-lane projects, which are primed at create but never registered
    // with the auth directory).
    const record = await readProjectBySlug(env.PROJECT_DIRECTORY, normalizedRequestedProject);
    if (!record) throw new Error(`Project not found: ${normalizedRequestedProject}`);
    return { id: record.id, slug: record.slug };
  }

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
    resource: canonicalMcpResourceUrl(input),
    authorization_servers: [
      input.context.config.iterateAuth?.issuer ?? "https://auth.iterate.com/api/auth",
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

function canonicalMcpResourceUrl(input: { context: RequestContext; request: Request }) {
  const rawUrl = resolveMcpBaseUrl({
    appBaseUrl: input.context.config.baseUrl,
    mcpBaseUrl: input.context.config.mcp?.baseUrl,
    requestUrl: input.request.url,
  });
  if (!rawUrl) throw new Error("APP_CONFIG_MCP__BASE_URL is required for MCP requests.");
  return rawUrl;
}

function unauthorizedMcpResponse(
  input: { context: RequestContext; request: Request },
  message: string,
) {
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
