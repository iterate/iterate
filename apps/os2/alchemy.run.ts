import { D1Database, DurableObjectNamespace, Self, Worker, WorkerLoader } from "alchemy/cloudflare";
import { initAlchemy } from "@iterate-com/shared/alchemy/init";
import { IterateApp } from "@iterate-com/shared/alchemy/iterate-app";
import { selfToolProviderBindingName } from "@iterate-com/shared/codemode/self-callable";
import manifest, { AppConfig } from "./src/app.ts";
import type { IterateMcpServer } from "./src/durable-objects/iterate-mcp-server.ts";
import type { McpClientBridge } from "./src/rpc-targets/mcp-client-bridge.ts";

const ctx = await initAlchemy(manifest, AppConfig, process.env);

const db = await D1Database("os-db", {
  name: `${ctx.workerName}-db`,
  migrationsDir: "./src/db/migrations",
  adopt: true,
});

const iterateMcpServer = await Worker("iterate-mcp-server-do", {
  name: `${ctx.workerName}-iterate-mcp-server-do`,
  entrypoint: "./src/durable-objects/iterate-mcp-server.ts",
  adopt: true,
  compatibilityFlags: ["nodejs_compat"],
  bindings: {
    EVENTS_BASE_URL: ctx.compiledAppConfig.eventsBaseUrl,
    MCP_PROOF_SECRET: ctx.compiledAppConfig.mcpProofSecret.exposeSecret(),
    ITERATE_MCP_SERVER: DurableObjectNamespace<IterateMcpServer>("iterate-mcp-server", {
      className: "IterateMcpServer",
      sqlite: true,
    }),
    LOADER: WorkerLoader(),
  },
});

// os2 serves project subdomains at <slug>.iterate2.app (prod) or
// <slug>.iterate-dev-jonas.app (dev). These need both bare and wildcard routes.
const projectHostnameBases = ctx.compiledAppConfig.projectHostnameBases ?? [];
const openApiBridgeBindingName = selfToolProviderBindingName({
  workerScriptName: ctx.workerName,
  entrypoint: "OpenApiBridge",
});

const { worker, afterFinalize } = await IterateApp(ctx, {
  bindings: {
    CLERK_JWT_KEY: ctx.compiledAppConfig.clerk.jwtKey.exposeSecret(),
    CLERK_PUBLISHABLE_KEY: ctx.compiledAppConfig.clerk.publishableKey,
    CLERK_SECRET_KEY: ctx.compiledAppConfig.clerk.secretKey.exposeSecret(),
    ...(ctx.compiledAppConfig.clerk.oauthClientId
      ? { CLERK_OAUTH_CLIENT_ID: ctx.compiledAppConfig.clerk.oauthClientId }
      : {}),
    ...(ctx.compiledAppConfig.clerk.oauthClientSecret
      ? {
          CLERK_OAUTH_CLIENT_SECRET: ctx.compiledAppConfig.clerk.oauthClientSecret.exposeSecret(),
        }
      : {}),
    CLERK_SIGN_IN_URL: ctx.compiledAppConfig.clerk.signInUrl,
    CLERK_SIGN_UP_URL: ctx.compiledAppConfig.clerk.signUpUrl,
    DB: db,
    LOADER: WorkerLoader(),
    [openApiBridgeBindingName]: Worker.experimentalEntrypoint(Self, "OpenApiBridge"),
    ITERATE_MCP_SERVER: iterateMcpServer.bindings.ITERATE_MCP_SERVER,
    MCP_CLIENT_BRIDGE: DurableObjectNamespace<McpClientBridge>("mcp-client-bridge", {
      className: "McpClientBridge",
    }),
    PROJECT_HOSTNAME_BASES: projectHostnameBases.join(","),
  },
  extraRouteHostnames: [...projectHostnameBases, ...projectHostnameBases.map((h) => `*.${h}`)],
});

export { worker };

await ctx.app.finalize();
await afterFinalize();

if (!ctx.app.local) process.exit(0);
