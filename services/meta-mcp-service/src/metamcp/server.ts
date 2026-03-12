import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { serve } from "@hono/node-server";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createWorkerThreadCodeExecutor } from "../execution/worker-thread-execution-environment.ts";
import { UpstreamManager } from "../upstream-manager.ts";
import { AuthManager } from "../auth/auth-manager.ts";
import { serviceEnv } from "../env.ts";
import { readServersFile } from "../config/servers-file.ts";
import { createMetaMCPServer } from "./mcp-server.ts";
import { createMetaMcpTools } from "./tools.ts";

export const app = new Hono();
app.use(logger());

app.get("/health", (c) => c.json({ message: "Healthy!" }));

function buildAuthStartUrl(stateIdentifier: string) {
  return new URL(
    `/auth/start/${stateIdentifier}`,
    serviceEnv.META_MCP_SERVICE_PUBLIC_URL,
  ).toString();
}

const upstream = new UpstreamManager(
  serviceEnv.META_MCP_SERVICE_SERVERS_PATH,
  serviceEnv.META_MCP_SERVICE_PUBLIC_URL,
  undefined,
  serviceEnv.META_MCP_SERVICE_AUTH_PATH,
);
const authManager = new AuthManager();
const executionEnvironment = createWorkerThreadCodeExecutor();

const metaMcpServer = createMetaMCPServer({
  executionEnvironment,
  getRuntimeTools: () => createMetaMcpTools(upstream),
});

const transport = new StreamableHTTPTransport();

app.all("/mcp", async (c) => {
  if (!metaMcpServer.isConnected()) await metaMcpServer.connect(transport);
  return transport.handleRequest(c);
});

app.get("/api/status", async (c) => {
  const serversFile = readServersFile(serviceEnv.META_MCP_SERVICE_SERVERS_PATH);

  const servers = await Promise.all(
    serversFile.servers.map(async (server) => {
      const tokens = await authManager.getTokens(server.id);

      const connected = Boolean(tokens?.access_token);
      const oauthStartState =
        !connected && (server.auth.type === "oauth" || server.auth.type === "auto")
          ? await authManager.startOAuthAuthorization(server.id)
          : null;
      const waitingForOAuth = Boolean(oauthStartState);

      return {
        id: server.id,
        namespace: server.namespace ?? null,
        url: server.url,
        enabled: server.enabled,
        auth: {
          type: server.auth.type,
          connected,
          waitingForOAuth,
          startOAuthUrl: oauthStartState
            ? buildAuthStartUrl(oauthStartState.stateIdentifier)
            : null,
          pendingAuthUrl: oauthStartState?.authenticationUrl ?? null,
          callbackUrl: oauthStartState
            ? new URL("/auth/finish", serviceEnv.META_MCP_SERVICE_PUBLIC_URL).toString()
            : null,
          expiresAt: oauthStartState?.expiresAt ?? null,
        },
      };
    }),
  );

  return c.json({
    publicBaseUrl: serviceEnv.META_MCP_SERVICE_PUBLIC_URL,
    servers,
  });
});

app.get("/auth/start/:authState", async (c) => {
  const authState = c.req.param("authState");
  const savedInfo = await authManager.getOAuthSate(authState);
  if (!savedInfo)
    return c.text(
      "No saved info found to initiate this OAuth authorization, the link may have expired or already been used",
    );
  return c.redirect(savedInfo.authenticationUrl, 302);
});

app.get(
  "/auth/finish",
  zValidator(
    "query",
    z.object({
      state: z.string(),
      code: z.string(),
    }),
  ),
  async (c) => {
    const { state, code } = c.req.valid("query");
    const savedInfo = await authManager.getOAuthSate(state);
    if (!savedInfo)
      return c.text(
        "No saved info found to finish this OAuth authorization, the link may have expired or already been used. Please restart the authorization flow.",
      );
    const result = await authManager.finishOAuthAuthorization(state, code);
    const finalRedirectUrl = new URL("/mcp-auth/success", serviceEnv.META_MCP_SERVICE_PUBLIC_URL);

    if (!result.success) {
      finalRedirectUrl.searchParams.set("status", "false");
      finalRedirectUrl.searchParams.set("message", result.message);
    } else {
      finalRedirectUrl.searchParams.set("status", "true");
      finalRedirectUrl.searchParams.set("message", result.message);
    }

    return c.redirect(finalRedirectUrl.toString(), 302);
  },
);

export const startMetaMcpServer = (options?: { host?: string; port?: number }) => {
  return serve(
    {
      port: options?.port ?? serviceEnv.META_MCP_SERVICE_PORT,
      hostname: options?.host ?? serviceEnv.META_MCP_SERVICE_HOST,
      fetch: app.fetch,
    },
    () => {
      console.log(
        `[meta-mcp] Server running at http://${options?.host ?? serviceEnv.META_MCP_SERVICE_HOST}:${options?.port ?? serviceEnv.META_MCP_SERVICE_PORT}/mcp`,
      );
    },
  );
};
