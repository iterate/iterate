import { createIterateAuth } from "@iterate-com/auth/server";
import {
  ITERATE_PROJECT_SELECTION_SCOPE,
  listProjectScopeIds,
} from "@iterate-com/shared/auth-claims";
import { oauthResourceAudienceVariants } from "@iterate-com/shared/oauth-resource";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";
// oxlint-disable-next-line iterate/no-capnweb-http-batch -- exec_js is a one-shot request-scoped call: a single pipelined batch (authenticate -> runScript) with no socket lifecycle to manage.
import { newHttpBatchRpcSession } from "capnweb";
import { env } from "cloudflare:workers";
import packageJson from "../../../package.json" with { type: "json" };
import { resolveMcpSessionAgentPath } from "./mcp-session-agent-path.ts";
import { authenticateAdminApiSecret } from "~/auth/admin.ts";
import { principalFromAccessToken } from "~/auth/principal.ts";
import { MCP_START_MOUNT_PATH, resolveMcpBaseUrl } from "~/lib/mcp-base-url.ts";
import { readProjectBySlug } from "~/project-directory.ts";
import type { UnauthenticatedItx } from "~/types.ts";
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
const WEB_MESSAGE_SENT_EVENT_TYPE = "events.iterate.com/agents/web-message-sent";
const ASK_ASSISTANT_TIMEOUT_MS = 120_000;
const ExecJsInput = z.object({
  code: z
    .string()
    .describe(
      "JavaScript async arrow function to execute, e.g. async (itx) => { return await itx.describe(); }",
    ),
  project: z.string().optional().describe("Project slug to run this code against."),
});
const AskAssistantInput = z.object({
  message: z.string().trim().min(1).describe("Plain-language request for the project assistant."),
  project: z.string().optional().describe("Project slug to ask the assistant of."),
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
  if (pathname === `${MCP_START_MOUNT_PATH}/.well-known/oauth-protected-resource`) {
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

function createServer(input: {
  auth: McpAuth;
  context: RequestContext;
  env: Env;
  request: Request;
}) {
  const server = new McpServer(
    { name: "os", version: packageJson.version },
    {
      instructions: [
        "This is an Iterate OS project MCP server.",
        "Use exec_js to run a JavaScript async arrow function against a project.",
        "Use ask_assistant to ask the project's assistant agent in plain language.",
      ].join("\n"),
    },
  );

  const projects = input.auth.projects;
  const requireProjectInput = input.auth.authType === "admin_api_secret" || projects.length > 1;
  const resolveProject = async (requestedProject: string | undefined) => {
    const project = await resolveToolProject(input.context, projects, requestedProject, {
      authType: input.auth.authType,
      requireProjectInput,
    });
    requireScope(input.auth, requiredToolScope);
    return project;
  };

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
      const project = await resolveProject(parsedInput.project);

      // Access was verified above (OAuth project grants / admin secret), so the
      // script runs through the itx admin lane over one pipelined
      // HTTP batch. runScript executes the async arrow function in a fresh
      // dynamic-worker isolate scoped to this MCP session's agent stream, so
      // the session transcript at /agents/mcp/** records every execution.
      try {
        const agentPath = await resolveMcpSessionAgentPath(input);
        const session = engineBatchSession(input.context);
        const root = session.authenticate({
          type: "admin-secret",
          secret: requireAdminSecret(input.context),
        });
        const sessionAgent = root.projects.get(project.id).agents.get(agentPath);
        const execution = await sessionAgent.runScript(parsedInput.code);
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

  server.registerTool(
    "ask_assistant",
    {
      title: "Ask assistant",
      description:
        "Ask this project's assistant agent in plain language. Blocks until the assistant replies (up to two minutes) and returns its reply. Conversation history lives on this MCP session's agent stream.",
      inputSchema: AskAssistantInput,
    },
    async (rawInput) => {
      const parsedInput = AskAssistantInput.parse(rawInput);
      const project = await resolveProject(parsedInput.project);
      const agentPath = await resolveMcpSessionAgentPath(input);
      const secret = requireAdminSecret(input.context);

      // Two one-shot batches instead of one: waitForEvent's afterOffset needs
      // the committed offset of the append, which an HTTP batch can't feed back
      // into a later call in the same batch.
      const [sent] = await engineBatchSession(input.context)
        .authenticate({ type: "admin-secret", secret })
        .projects.get(project.id)
        .streams.get(agentPath)
        .append({
          type: "events.iterate.com/agents/user-message-received",
          payload: { content: parsedInput.message, origin: "mcp" },
          metadata: { mcpTool: "ask_assistant" },
        });

      try {
        const reply = await engineBatchSession(input.context)
          .authenticate({ type: "admin-secret", secret })
          .projects.get(project.id)
          .streams.get(agentPath)
          .waitForEvent({
            afterOffset: sent!.offset,
            eventTypes: [WEB_MESSAGE_SENT_EVENT_TYPE],
            timeoutMs: ASK_ASSISTANT_TIMEOUT_MS,
          });
        const message = (reply.payload as { message?: unknown } | undefined)?.message;
        if (typeof message !== "string" || message.trim() === "") {
          throw new Error(`Assistant reply event ${reply.offset} did not include a message.`);
        }
        return {
          content: [{ type: "text" as const, text: message }],
          isError: false,
        };
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
    return new Response("Iterate auth is not configured.", {
      status: 503,
      headers: mcpCorsHeaders,
    });
  }

  const accessToken = await auth.authenticateBearer({ headers: input.request.headers });
  if (!accessToken) return unauthorizedMcpResponse(input, "Missing or invalid bearer token");
  const audiences = Array.isArray(accessToken.aud) ? accessToken.aud : [accessToken.aud];
  if (!audiences.some((audience) => mcpAudiences.includes(audience))) {
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
  context: RequestContext,
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
    const record = await readProjectBySlug(
      context.config,
      env.PROJECT_DIRECTORY,
      normalizedRequestedProject,
    );
    if (!record) throw new Error(`Project not found: ${normalizedRequestedProject}`);
    return { id: record.id, slug: record.slug };
  }

  const project = projects.find((candidate) => candidate.slug === normalizedRequestedProject);
  if (!project) {
    throw new Error(`MCP token does not grant access to project: ${normalizedRequestedProject}`);
  }
  return project;
}

function requireAdminSecret(context: RequestContext): string {
  const secret = context.config.adminApiSecret?.exposeSecret();
  if (!secret) throw new Error("Admin API secret is not configured.");
  return secret;
}

function engineBatchSession(context: RequestContext) {
  const baseUrl = (context.config.baseUrl ?? "").replace(/\/+$/, "");
  if (!baseUrl) throw new Error("baseUrl is not configured");
  // oxlint-disable-next-line iterate/no-capnweb-http-batch -- one-shot pipelined batch per exec_js call; no socket lifecycle to manage.
  return newHttpBatchRpcSession<UnauthenticatedItx>(
    new Request(`${baseUrl}/api/itx`, { method: "POST" }),
  );
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

function mcpExecutionContext(context: RequestContext): ExecutionContext {
  return {
    exports: {} as Cloudflare.Exports,
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
