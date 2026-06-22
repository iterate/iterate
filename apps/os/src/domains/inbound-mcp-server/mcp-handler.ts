import { createIterateAuth } from "@iterate-com/auth/server";
import {
  ITERATE_PROJECT_SELECTION_SCOPE,
  listProjectScopeIds,
} from "@iterate-com/shared/auth-claims";
import { oauthResourceAudienceVariants } from "@iterate-com/shared/oauth-resource";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";
import packageJson from "../../../package.json" with { type: "json" };
import { resolveAskAssistantAgentPath } from "./ask-assistant-agent-path.ts";
import { authenticateAdminApiSecret } from "~/auth/admin.ts";
import { principalFromAccessToken } from "~/auth/principal.ts";
import { listAllProjects } from "~/db/queries/.generated/index.ts";
import { projectContextRef } from "~/itx/coordinates.ts";
import type { ItxRuntime } from "~/itx/handle.ts";
import { runItxScript } from "~/itx/run.ts";
import { MCP_START_MOUNT_PATH, resolveMcpBaseUrl } from "~/lib/mcp-base-url.ts";
import type { RequestContext } from "~/request-context.ts";
import { getStreamsBackend } from "~/domains/streams/entrypoints/streams-backend.ts";
import type { StreamEvent } from "~/domains/streams/engine/shared/event.ts";

type ProjectGrant = {
  id: string;
  slug: string;
};

type McpAuth = {
  authType: "admin_api_secret" | "oauth_access_token";
  askAssistantSessionKey?: string;
  projects: ProjectGrant[];
  scopes: string[];
};

const requiredToolScope = "profile";
const AGENT_MESSAGE_SENT_EVENT_TYPE = "events.iterate.com/agents/agent-message-sent";
const ExecJsInput = z.object({
  code: z
    .string()
    .describe(
      "JavaScript async arrow function to execute, e.g. async (itx) => { return await itx.describe(); }",
    ),
  project: z.string().optional().describe("Project slug to run this code against."),
});
const AskAssistantInput = z.object({
  message: z
    .string()
    .trim()
    .min(1)
    .describe("Human-language request to ask the project assistant."),
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
        "Use ask_assistant to ask the project assistant a plain-language question.",
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

  server.registerTool(
    "ask_assistant",
    {
      title: "Ask assistant",
      description:
        "Ask a project assistant in human language. The MCP call blocks until the assistant calls itx.respondToAgent({ message }). Requires the token to grant exactly one project.",
      inputSchema: AskAssistantInput,
    },
    async (rawInput) => {
      const message = parseAskAssistantMessage(rawInput);
      const project = resolveAskAssistantProject(projects);
      requireScope(input.auth, requiredToolScope);

      const workerExports = input.context.workerExports;
      if (!workerExports) {
        throw new Error("MCP ask_assistant needs workerExports in request context.");
      }

      const agentPath = await resolveAskAssistantAgentPath({
        auth: input.auth,
        request: input.request,
      });
      const streams = getStreamsBackend({
        exports: workerExports as Pick<Cloudflare.Exports, "StreamsBackend">,
        props: {
          appendMetadata: {
            source: { tool: "ask_assistant" },
          },
          appendPolicy: { mode: "stream" },
          projectId: project.id,
          streamPath: agentPath,
        },
      });

      const requestEvent = await streams.append({
        event: {
          type: "events.iterate.com/agents/agent-message-received",
          payload: {
            message,
          },
        },
      });

      try {
        const responseEvent = await streams.waitForEvent({
          afterOffset: requestEvent.offset,
          eventTypes: [AGENT_MESSAGE_SENT_EVENT_TYPE],
          timeoutMs: 120_000,
          predicate: (event) => event.type === AGENT_MESSAGE_SENT_EVENT_TYPE,
        });
        return {
          content: [{ type: "text" as const, text: readMcpResponseMessage(responseEvent) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `The assistant did not send an MCP response in time: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  return server;
}

function parseAskAssistantMessage(rawInput: unknown) {
  if (typeof rawInput === "string") return AskAssistantInput.shape.message.parse(rawInput);
  return AskAssistantInput.parse(rawInput).message;
}

function resolveAskAssistantProject(projects: ProjectGrant[]) {
  if (projects.length === 1) return projects[0]!;
  throw new Error(
    "ask_assistant requires an MCP token that grants exactly one project. Reconnect MCP from a project-scoped OAuth selection.",
  );
}

function readMcpResponseMessage(event: StreamEvent) {
  const message = (event.payload as { message?: unknown } | undefined)?.message;
  if (typeof message !== "string" || message.trim() === "") {
    throw new Error(`Agent response event ${event.offset} did not include a message.`);
  }
  return message;
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
    askAssistantSessionKey: principal.sessionId
      ? `oauth-session:${principal.sessionId}`
      : `oauth-user:${principal.userId}`,
    projects,
    scopes,
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
