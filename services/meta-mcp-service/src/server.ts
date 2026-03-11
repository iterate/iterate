import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { zValidator } from "@hono/zod-validator";
import { StreamableHTTPTransport } from "@hono/mcp";
import type { HttpBindings } from "@hono/node-server";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { logger } from "hono/logger";
import { getOAuthCallbackUrl, getSavedOAuthAuthorizationByLocalAuthState } from "./auth/oauth.ts";
import { MetaMcpFileStore } from "./config/file-store.ts";
import { ServiceEnv } from "./config/schema.ts";
import { serializeError } from "./errors.ts";
import type { MetaMcpExecutionEnvironment } from "./execution/types.ts";
import { WorkerThreadMetaMcpExecutionEnvironment } from "./execution/worker-thread-execution-environment.ts";
import { logError, logInfo } from "./logger.ts";
import { createMetaMcpTools, type MetaMcpTools, StartOAuthInput } from "./metamcp/tools.ts";
import { UpstreamManager } from "./upstream-manager.ts";

const serviceName = "meta-mcp-service";

const ExecuteArgs = z.object({
  code: z
    .string()
    .describe(
      [
        "JavaScript only. Starter guide:",
        "1) use tools.discover({ query }) to find likely tools for the task and read the returned inputTypeScript/outputTypeScript,",
        "2) inspect the best match with tools.describe.tool({ path, includeSchemas: true }) when you need the exact schema,",
        "3) call it with await tools.<namespace>.<tool>(args),",
        "4) return the result you want from this run.",
        "Use tools.catalog.namespaces(...) and tools.catalog.tools(...) when browsing is more useful than search.",
        "If the needed tool is missing, add a server with tools.metamcp.addServer({ id: <required-slug>, url: <url>, auth: 'auto' }).",
        "Figure out a short stable slug from the URL hostname (e.g. 'github' from 'https://github.com/mcp'), keep auth as auto it should work in most cases.",
        "After addServer succeeds, the discovered tools are available in the same execution under tools.<namespace>.<tool>(args).",
        "Execution is stateless. Use the tools to complete the task and return the result.",
        "Returned values are already rendered with inspect depth 4. Return objects or arrays directly; do not JSON.stringify them unless the task explicitly needs a JSON string.",
      ].join(" "),
    ),
});

const OAuthCallbackQuery = z.object({
  serverId: z.string().min(1).optional(),
  code: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
});

const serverInstructions = [
  "This server exposes one tool: execute({ code }).",
  "See its description for usage instructions.",
].join("\n");

function formatToolOutput(result: { result: unknown; logs?: string[]; error?: unknown }) {
  const body = {
    result: result.result,
    logs: result.logs ?? [],
    ...(result.error ? { error: result.error } : {}),
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
    structuredContent: body,
    ...(result.error ? { isError: true } : {}),
  };
}

function isPlaceholderPublicBaseUrl(value: string) {
  const hostname = new URL(value).hostname;
  return hostname.includes("placeholder") || hostname.endsWith(".invalid");
}

function buildOAuthResultRedirect(params: {
  status: "success" | "error";
  serverId?: string;
  message: string;
}) {
  const projectBaseUrl = process.env.ITERATE_PROJECT_BASE_URL?.trim() ?? "http://127.0.0.1:3000";
  const url = new URL("/oauth/meta-mcp/success", projectBaseUrl);
  url.searchParams.set("status", params.status);
  url.searchParams.set("message", params.message);
  if (params.serverId) {
    url.searchParams.set("serverId", params.serverId);
  }
  return url.toString();
}

async function finishOAuthAuthorization(params: {
  upstream: UpstreamManager;
  serverId: string;
  authorizationCode: string;
}) {
  await params.upstream.finishOAuth({
    serverId: params.serverId,
    authorizationCode: params.authorizationCode,
  });

  return {
    ok: true as const,
    serverId: params.serverId,
  };
}

async function getStatusSnapshot(params: {
  fileStore: MetaMcpFileStore;
  upstream: UpstreamManager;
  publicBaseUrl: string;
}) {
  const publicBaseUrlIsPlaceholder = isPlaceholderPublicBaseUrl(params.publicBaseUrl);

  try {
    const [authStore, availableServers] = await Promise.all([
      params.fileStore.loadAuthStore(),
      params.upstream.listAvailableServers(),
    ]);

    return {
      ok: true as const,
      publicBaseUrl: params.publicBaseUrl,
      publicBaseUrlIsPlaceholder,
      configPath: params.fileStore.configPath,
      authPath: params.fileStore.authPath,
      servers: availableServers.map((entry) => {
        const server = entry.server;
        const oauthRecord = authStore.oauth[server.id] ?? {};

        return {
          id: server.id,
          namespace: server.namespace ?? null,
          url: server.url,
          transport: server.transport,
          enabled: server.enabled,
          toolCount: entry.tools.length,
          error: entry.error,
          auth:
            server.auth.type === "bearer"
              ? {
                  type: "bearer" as const,
                  env: server.auth.env,
                  configured: Boolean(process.env[server.auth.env]),
                }
              : server.auth.type === "oauth"
                ? {
                    type: "oauth" as const,
                    connected: Boolean(oauthRecord.accessToken),
                    expiresAt: oauthRecord.expiresAt ?? null,
                    callbackUrl: getOAuthCallbackUrl({
                      server,
                      publicBaseUrl: params.publicBaseUrl,
                    }),
                    authorization: oauthRecord.authorization ?? null,
                  }
                : server.auth.type === "auto"
                  ? {
                      type: "auto" as const,
                      oauthConnected: Boolean(oauthRecord.accessToken),
                      expiresAt: oauthRecord.expiresAt ?? null,
                      callbackUrl: getOAuthCallbackUrl({
                        server,
                        publicBaseUrl: params.publicBaseUrl,
                      }),
                      authorization: oauthRecord.authorization ?? null,
                    }
                  : {
                      type: "none" as const,
                    },
        };
      }),
    };
  } catch (error) {
    return {
      ok: false as const,
      publicBaseUrl: params.publicBaseUrl,
      publicBaseUrlIsPlaceholder,
      configPath: params.fileStore.configPath,
      authPath: params.fileStore.authPath,
      error: serializeError(error),
    };
  }
}

function createMetaMcpServer(params: {
  upstream: UpstreamManager;
  environment: MetaMcpExecutionEnvironment<MetaMcpTools>;
}) {
  let cachedToolsPromise: Promise<MetaMcpTools> | undefined;
  let cachedRevision = -1;

  async function getMetaMcpTools() {
    const nextRevision = params.upstream.getRevision();
    if (!cachedToolsPromise || cachedRevision !== nextRevision) {
      logInfo("refreshing metamcp tools cache", {
        previousRevision: cachedRevision,
        nextRevision,
      });
      cachedRevision = nextRevision;
      cachedToolsPromise = createMetaMcpTools(params.upstream);
    } else {
      logInfo("using cached metamcp tools", {
        revision: cachedRevision,
      });
    }

    return await cachedToolsPromise;
  }

  const server = new McpServer(
    {
      name: serviceName,
      title: "Meta MCP Service",
      description: "Runtime-discovery MCP aggregator with one execute tool.",
      version: "0.0.1",
    },
    {
      instructions: serverInstructions,
    },
  );

  server.registerTool(
    "execute",
    {
      description:
        "Execute JavaScript against runtime discovery helpers and discovered MCP servers. Prefer tools.discover(...) before any tool call unless the exact path is already known.",
      inputSchema: ExecuteArgs,
    },
    async ({ code }) => {
      logInfo("received execute tool call", {
        codeLength: code.length,
        environment: params.environment.kind,
      });
      try {
        const tools = await getMetaMcpTools();
        const result = await params.environment.execute({
          code,
          tools,
        });
        return formatToolOutput(result);
      } catch (error) {
        return formatToolOutput({
          result: null,
          logs: [],
          error: serializeError(error),
        });
      }
    },
  );

  return server;
}

export async function startMetaMcpService(options?: {
  host?: string;
  port?: number;
  environment?: MetaMcpExecutionEnvironment<MetaMcpTools>;
}) {
  const env = ServiceEnv.parse(process.env);
  const host = options?.host ?? env.META_MCP_SERVICE_HOST;
  const port = options?.port ?? env.META_MCP_SERVICE_PORT;
  const publicBaseUrl = env.META_MCP_SERVICE_PUBLIC_URL ?? `http://127.0.0.1:${port}`;

  const fileStore = new MetaMcpFileStore(
    env.META_MCP_SERVICE_CONFIG_PATH,
    env.META_MCP_SERVICE_AUTH_PATH,
  );
  const upstream = new UpstreamManager(fileStore, publicBaseUrl);
  const environment =
    options?.environment ?? new WorkerThreadMetaMcpExecutionEnvironment<MetaMcpTools>();
  const sessions = new Map<
    string,
    {
      server: McpServer;
      transport: StreamableHTTPTransport;
    }
  >();

  async function disposeSession(sessionId: string) {
    const session = sessions.get(sessionId);
    if (!session) {
      return;
    }
    logInfo("disposing MCP session", { sessionId });
    sessions.delete(sessionId);
    await session.server.close().catch(() => undefined);
  }

  async function createSession() {
    logInfo("creating MCP session");
    const server = createMetaMcpServer({ upstream, environment });
    const transport = new StreamableHTTPTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: async (sessionId) => {
        logInfo("initialized MCP session", { sessionId });
        sessions.set(sessionId, { server, transport });
      },
      onsessionclosed: async (sessionId) => {
        await disposeSession(sessionId);
      },
    });
    await server.connect(transport);
    return { server, transport };
  }

  const app = new Hono<{ Bindings: HttpBindings }>();
  app.use(logger());

  app.use("*", async (c, next) => {
    logInfo("received HTTP request", {
      method: c.req.method,
      pathname: c.req.path,
      sessionId: c.req.header("mcp-session-id"),
    });
    await next();
  });

  app.get("/healthz", (c) => c.text("ok"));

  app.get("/api/status", async (c) => {
    const status = await getStatusSnapshot({
      fileStore,
      upstream,
      publicBaseUrl,
    });
    return c.json(status);
  });

  app.post("/api/oauth/start", zValidator("json", StartOAuthInput), async (c) => {
    try {
      const body = c.req.valid("json");
      const result = await upstream.startOAuth(body.serverId);
      return c.json(result);
    } catch (error) {
      return c.json(serializeError(error), 400);
    }
  });

  app.get("/mcp-auth/:authState", async (c) => {
    const authState = c.req.param("authState");
    const savedAuthorization = await getSavedOAuthAuthorizationByLocalAuthState({
      fileStore,
      localAuthState: authState,
    });

    console.log("savedAuthorization", savedAuthorization);

    if (!savedAuthorization) {
      return c.redirect(
        buildOAuthResultRedirect({
          status: "error",
          message:
            "This Meta MCP authorization link is invalid or expired. Start the authorization flow again.",
        }),
        302,
      );
    }

    const to =
      savedAuthorization.authorization.providerAuthUrl ?? savedAuthorization.authorization.authUrl;
    console.log({ redirectingTo: to });
    return c.redirect(to, 302);
  });

  app.get("/oauth/callback", zValidator("query", OAuthCallbackQuery), async (c) => {
    const { serverId, code: authorizationCode, error: oauthError } = c.req.valid("query");

    if (!serverId || oauthError || !authorizationCode) {
      return c.redirect(
        buildOAuthResultRedirect({
          status: "error",
          serverId,
          message: oauthError
            ? `The provider returned "${oauthError}". Start the authorization flow again from Meta MCP.`
            : "The callback was missing the required OAuth parameters. Start the authorization flow again from Meta MCP.",
        }),
        302,
      );
    }

    try {
      await finishOAuthAuthorization({
        upstream,
        serverId,
        authorizationCode,
      });
      return c.redirect(
        buildOAuthResultRedirect({
          status: "success",
          serverId,
          message: `${serverId} is now authorized for Meta MCP. You can close this tab and return to the daemon.`,
        }),
        302,
      );
    } catch (error) {
      logError("oauth callback failed", {
        serverId,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.redirect(
        buildOAuthResultRedirect({
          status: "error",
          serverId,
          message:
            error instanceof Error
              ? error.message
              : "Meta MCP could not finish the OAuth exchange. Start the authorization flow again.",
        }),
        302,
      );
    }
  });

  app.all("/mcp", async (c) => {
    const requestedSessionId = c.req.header("mcp-session-id");

    try {
      if (requestedSessionId) {
        const session = sessions.get(requestedSessionId);
        if (!session) {
          logError("request referenced unknown session", {
            sessionId: requestedSessionId,
          });
          return c.json({ error: "session_not_found" }, 404);
        }

        logInfo("routing request to existing session", {
          sessionId: requestedSessionId,
        });
        return await session.transport.handleRequest(c);
      }

      const session = await createSession();
      try {
        logInfo("routing request to new session");
        return await session.transport.handleRequest(c);
      } finally {
        if (session.transport.sessionId === undefined) {
          logInfo("closing uninitialized session transport");
          await session.server.close().catch(() => undefined);
        }
      }
    } catch (error) {
      logError("request handling failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json(
        {
          error: "internal_error",
          message: error instanceof Error ? error.message : String(error),
        },
        500,
      );
    }
  });

  const nodeServer = serve({
    fetch: app.fetch,
    hostname: host,
    port,
  });

  logInfo("meta mcp service listening", {
    host,
    port,
    publicBaseUrl,
    configPath: fileStore.configPath,
    authPath: fileStore.authPath,
    environment: environment.kind,
  });

  return {
    nodeServer,
    app,
    stop: async () => {
      await Promise.all([...sessions.keys()].map((sessionId) => disposeSession(sessionId)));
      nodeServer.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startMetaMcpService().catch((error) => {
    logError("failed to start service", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  });
}

export type MetaMcpService = Awaited<ReturnType<typeof startMetaMcpService>>;
export type MetaMcpServiceServer = ServerType;
