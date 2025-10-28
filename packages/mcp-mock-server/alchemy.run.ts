import alchemy, { type Scope } from "alchemy";
import { Worker, DurableObjectNamespace, KVNamespace } from "alchemy/cloudflare";
import { CloudflareStateStore, SQLiteStateStore } from "alchemy/state";

const stateStore = (scope: Scope) =>
  scope.local ? new SQLiteStateStore(scope, { engine: "libsql" }) : new CloudflareStateStore(scope);

const app = await alchemy("mcp-mock", {
  password: process.env.ALCHEMY_PASSWORD,
  stateStore,
});

const isProduction = app.stage === "prd";
const isStaging = app.stage === "stg";

// Create Durable Objects for MCP agent state
const MCP_OBJECT = DurableObjectNamespace<import("./src/index.ts").MockMCPAgent>("mcp-mock-agent", {
  className: "MockMCPAgent",
  sqlite: true,
});

const MCP_OAUTH_OBJECT = DurableObjectNamespace<import("./src/index.ts").MockOAuthMCPAgent>(
  "mcp-oauth-mock-agent",
  {
    className: "MockOAuthMCPAgent",
    sqlite: true,
  },
);

// KV namespace for storing OAuth sessions
const MOCK_OAUTH_SESSIONS = await KVNamespace("mock-oauth-sessions");

// KV namespace for OAuth provider (stores client registrations, grants, tokens)
const OAUTH_KV = await KVNamespace("oauth-provider-storage");

const worker = await Worker("mcp-mock-server", {
  name: isProduction ? "mcp-mock-server" : isStaging ? "mcp-mock-server-staging" : undefined,
  entrypoint: "./src/index.ts",
  compatibilityFlags: ["nodejs_compat"],
  bindings: {
    MCP_OBJECT,
    MCP_OAUTH_OBJECT,
    MOCK_OAUTH_SESSIONS,
    OAUTH_KV,
  },
  domains: isProduction ? ["mock.iterate.com"] : isStaging ? ["mock-staging.iterate.com"] : [],
  adopt: true,
  dev: {
    port: 8789, // Different port from main app
  },
});

await app.finalize();

// Log the deployed URL
if (!app.local) {
  const workerUrl = await worker.url;
  console.log("\n🚀 Mock MCP Server deployed!");
  console.log(`📍 Health endpoint: ${workerUrl}/health`);
  console.log(`📍 MCP endpoint:    ${workerUrl}/mcp`);
  console.log("\nTest with MCP Inspector:");
  console.log(`  npx @modelcontextprotocol/inspector@latest`);
  console.log(`  Transport: HTTP`);
  console.log(`  URL: ${workerUrl}/mcp\n`);
}

export { worker };
