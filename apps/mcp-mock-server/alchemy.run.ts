import alchemy, { type Scope } from "alchemy";
import { Worker, DurableObjectNamespace, KVNamespace } from "alchemy/cloudflare";
import { CloudflareStateStore, SQLiteStateStore } from "alchemy/state";
import type { MockMCPAgent, MockOAuthMCPAgent } from "./src/index.ts";

const stateStore = (scope: Scope) =>
  scope.local ? new SQLiteStateStore(scope, { engine: "libsql" }) : new CloudflareStateStore(scope);

const app = await alchemy("mcp-mock", {
  password: process.env.ALCHEMY_PASSWORD,
  stateStore,
});

const isProduction = app.stage === "prd";
const isStaging = app.stage === "stg";

const MCP_OBJECT = DurableObjectNamespace<MockMCPAgent>("mcp-mock-agent", {
  className: "MockMCPAgent",
  sqlite: true,
});

const MCP_OAUTH_OBJECT = DurableObjectNamespace<MockOAuthMCPAgent>("mcp-oauth-mock-agent", {
  className: "MockOAuthMCPAgent",
  sqlite: true,
});

const OAUTH_KV = await KVNamespace("oauth-provider-storage");

const worker = await Worker("mcp-mock-server", {
  name: isProduction ? "mcp-mock-server" : isStaging ? "mcp-mock-server-staging" : undefined,
  entrypoint: "./src/index.ts",
  compatibilityFlags: ["nodejs_compat"],
  bindings: {
    MCP_OBJECT,
    MCP_OAUTH_OBJECT,
    // env.OAUTH_PROVIDER comes by magic from https://github.com/cloudflare/workers-oauth-provider
    OAUTH_KV,
  },
  domains: isProduction ? ["mock.iterate.com"] : isStaging ? ["mock-staging.iterate.com"] : [],
  adopt: true,
  dev: {
    port: 8789,
  },
});

await app.finalize();

export { worker };
