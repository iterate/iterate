import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { serve } from "@hono/node-server";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createWorkerThreadCodeExecutor } from "../execution/worker-thread-execution-environment.ts";
import { UpstreamManager } from "../upstream-manager.ts";
import { AuthManager, supportsOAuth } from "../auth/auth-manager.ts";
import { serviceEnv } from "../env.ts";
import { readServersFile } from "../config/servers-file.ts";
import { createMetaMCPServer } from "./mcp-server.ts";
import { createMetaMcpTools } from "./tools.ts";

function oauthResultPage(success: boolean, message: string): string {
  const title = success ? "Connected" : "Connection Failed";
  const icon = success
    ? '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>'
    : '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
  const escaped = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} - Meta MCP</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#0a0a0a;color:#fafafa}
.card{text-align:center;max-width:400px;padding:48px 32px;border:1px solid #262626;border-radius:12px;background:#111}
.icon{margin-bottom:20px}
h1{font-size:20px;font-weight:600;margin-bottom:8px}
p{font-size:14px;color:#a1a1aa;line-height:1.5;margin-bottom:24px}
button{background:#fafafa;color:#0a0a0a;border:none;padding:10px 24px;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer}
button:hover{background:#d4d4d8}
</style>
</head>
<body>
<div class="card">
<div class="icon">${icon}</div>
<h1>${title}</h1>
<p>${escaped}</p>
<button onclick="window.close()">Close this tab</button>
</div>
</body>
</html>`;
}

export const app = new Hono();
app.use(logger());

app.get("/health", (c) => c.json({ message: "Healthy!" }));

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

      return {
        id: server.id,
        namespace: server.namespace ?? null,
        url: server.url,
        enabled: server.enabled,
        auth: {
          type: server.auth.type,
          connected,
        },
      };
    }),
  );

  return c.json({
    publicBaseUrl: serviceEnv.META_MCP_SERVICE_PUBLIC_URL,
    servers,
  });
});

app.post("/api/oauth/start/:serverId", async (c) => {
  const serverId = c.req.param("serverId");
  const state = await authManager.startOAuthAuthorization(serverId);
  return c.json(state);
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
      return c.html(
        oauthResultPage(
          false,
          "This OAuth link has expired or was already used. Please start the flow again from the dashboard.",
        ),
      );
    const result = await authManager.finishOAuthAuthorization(state, code);
    return c.html(oauthResultPage(result.success, result.message));
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
