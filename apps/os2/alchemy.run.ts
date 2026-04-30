import { D1Database, DurableObjectNamespace, Self, Worker, WorkerLoader } from "alchemy/cloudflare";
import { initAlchemy } from "@iterate-com/shared/alchemy/init";
import { IterateApp } from "@iterate-com/shared/alchemy/iterate-app";
import { selfToolProviderBindingName } from "@iterate-com/shared/codemode/self-callable";
import manifest, { AppConfig } from "./src/app.ts";
import type { CodemodeSession } from "./src/durable-objects/codemode-session.ts";
import type { IterateMcpServer } from "./src/durable-objects/iterate-mcp-server.ts";
import type { McpClientBridge } from "./src/rpc-targets/mcp-client-bridge.ts";

const ctx = await initAlchemy(manifest, AppConfig, process.env);

const db = await D1Database("os-db", {
  name: `${ctx.workerName}-db`,
  migrationsDir: "./src/db/migrations",
  adopt: true,
});

// os2 serves project hosts at <slug>.iterate2.app (prod),
// <slug>.iterate-dev-jonas.app (dev), and <slug>.iterate-preview-N.app
// (preview). The preview app shell deliberately lives on the sibling
// iterate-preview-N.com zone (`os2.iterate-preview-N.com`) so project/MCP hosts
// can own the iterate-preview-N.app zone cleanly.
const projectHostnameBases = ctx.compiledAppConfig.projectHostnameBases ?? [];
const openApiBridgeBindingName = selfToolProviderBindingName({
  workerScriptName: ctx.workerName,
  entrypoint: "OpenApiBridge",
});
const mcpClientBridge = DurableObjectNamespace<McpClientBridge>("mcp-client-bridge", {
  className: "McpClientBridge",
});

const codemodeSessionWorker = await Worker("codemode-session-do", {
  name: `${ctx.workerName}-codemode-session-do`,
  entrypoint: "./src/durable-objects/codemode-session.ts",
  adopt: true,
  compatibilityFlags: ["nodejs_compat"],
  bindings: {
    CODEMODE_SESSION: DurableObjectNamespace<CodemodeSession>("codemode-session", {
      className: "CodemodeSession",
      sqlite: true,
    }),
    DO_CATALOG: db,
    EVENTS_BASE_URL: ctx.compiledAppConfig.eventsBaseUrl,
    LOADER: WorkerLoader(),
    MCP_CLIENT_BRIDGE: mcpClientBridge,
    [openApiBridgeBindingName]: Worker.experimentalEntrypoint(Self, "OpenApiBridge"),
  },
});

// The inbound MCP worker is declared after CodemodeSession because MCP tools run
// code by calling the same project/stream-scoped CodemodeSession DO that powers
// the web UI. This keeps the MCP and browser code paths behaviorally identical.
const iterateMcpServer = await Worker("iterate-mcp-server-do", {
  name: `${ctx.workerName}-iterate-mcp-server-do`,
  entrypoint: "./src/durable-objects/iterate-mcp-server.ts",
  adopt: true,
  compatibilityFlags: ["nodejs_compat"],
  bindings: {
    CODEMODE_SESSION: codemodeSessionWorker.bindings.CODEMODE_SESSION,
    EVENTS_BASE_URL: ctx.compiledAppConfig.eventsBaseUrl,
    MCP_PROOF_SECRET: ctx.compiledAppConfig.mcpProofSecret.exposeSecret(),
    ITERATE_MCP_SERVER: DurableObjectNamespace<IterateMcpServer>("iterate-mcp-server", {
      className: "IterateMcpServer",
      sqlite: true,
    }),
  },
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
    CODEMODE_SESSION: codemodeSessionWorker.bindings.CODEMODE_SESSION,
    [openApiBridgeBindingName]: Worker.experimentalEntrypoint(Self, "OpenApiBridge"),
    ITERATE_MCP_SERVER: iterateMcpServer.bindings.ITERATE_MCP_SERVER,
    MCP_CLIENT_BRIDGE: mcpClientBridge,
    PROJECT_HOSTNAME_BASES: projectHostnameBases.join(","),
  },
  extraRouteHostnames: projectHostnameBases.flatMap(projectRouteHostnamesForBase),
});

export { worker };

await ctx.app.finalize();
await afterFinalize();

if (!ctx.app.local) process.exit(0);

/**
 * Convert OS2 project-host bases into Cloudflare route host patterns.
 *
 * Normal bases use dotted project subdomains (`<slug>.<base>`). OS2 preview
 * project bases are normal bases too: `<slug>.iterate-preview-N.app`.
 */
function projectRouteHostnamesForBase(base: string) {
  return [base, `*.${base}`];
}
