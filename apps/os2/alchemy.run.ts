import alchemy from "alchemy";
import { Ai, D1Database, DurableObjectNamespace, WorkerLoader } from "alchemy/cloudflare";
import { Artifacts } from "@iterate-com/shared/alchemy/artifacts";
import { initAlchemy } from "@iterate-com/shared/alchemy/init";
import { IterateApp } from "@iterate-com/shared/alchemy/iterate-app";
import type { StreamDurableObject } from "@iterate-com/shared/streams/stream-durable-object";
import manifest, { AppConfig } from "./src/app.ts";
import type { CodemodeSession } from "./src/domains/codemode/durable-objects/codemode-session.ts";
import type { DebugAppendChainSubscriber } from "./src/durable-objects/debug-append-chain-subscriber.ts";
import type { ProjectDurableObject } from "./src/domains/projects/durable-objects/project-durable-object.ts";
import type { ProjectMcpServerConnection } from "./src/domains/inbound-mcp-server/durable-objects/project-mcp-server-connection.ts";
import type { AgentDurableObject } from "./src/domains/agents/durable-objects/agent-durable-object.ts";
import type { RepoDurableObject } from "./src/domains/repos/durable-objects/repo-durable-object.ts";
import type { SlackAgentDurableObject } from "./src/domains/slack/durable-objects/slack-agent-durable-object.ts";
import type { SlackIntegrationDurableObject } from "./src/domains/slack/durable-objects/slack-integration-durable-object.ts";
import type { WorkspaceDurableObject } from "./src/domains/workspaces/durable-objects/workspace-durable-object.ts";
import type { OutboundMcpFromOurClientCapability } from "./src/domains/outbound-mcp-client/entrypoints/outbound-mcp-from-our-client-capability.ts";

const ctx = await initAlchemy(manifest, AppConfig, process.env);
const slackBotToken = ctx.runtimeConfig.slackBotToken?.exposeSecret();

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
const projectHostnameBases = ctx.runtimeConfig.projectHostnameBases ?? [];
const artifactsAccountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
const artifactsNamespace = `${ctx.workerName}-repos`;
const outboundMcpFromOurClientCapability =
  DurableObjectNamespace<OutboundMcpFromOurClientCapability>(
    "outbound-mcp-from-our-client-capability",
    {
      className: "OutboundMcpFromOurClientCapability",
    },
  );
const stream = DurableObjectNamespace<StreamDurableObject>("stream", {
  className: "StreamDurableObject",
  sqlite: true,
});
const codemodeSession = DurableObjectNamespace<CodemodeSession>("codemode-session-local", {
  className: "CodemodeSession",
  sqlite: true,
});
const projectMcpServerConnection = DurableObjectNamespace<ProjectMcpServerConnection>(
  "project-mcp-server-connection-local",
  {
    className: "ProjectMcpServerConnection",
    sqlite: true,
  },
);
const project = DurableObjectNamespace<ProjectDurableObject>("project", {
  className: "ProjectDurableObject",
  sqlite: true,
});
const repo = DurableObjectNamespace<RepoDurableObject>("repo", {
  className: "RepoDurableObject",
  sqlite: true,
});
const workspace = DurableObjectNamespace<WorkspaceDurableObject>("workspace", {
  className: "WorkspaceDurableObject",
  sqlite: true,
});
const agent = DurableObjectNamespace<AgentDurableObject>("agent", {
  className: "AgentDurableObject",
  sqlite: true,
});
const slackIntegration = DurableObjectNamespace<SlackIntegrationDurableObject>(
  "slack-integration",
  {
    className: "SlackIntegrationDurableObject",
    sqlite: true,
  },
);
const slackAgent = DurableObjectNamespace<SlackAgentDurableObject>("slack-agent", {
  className: "SlackAgentDurableObject",
  sqlite: true,
});
const debugAppendChainSubscriber = ctx.app.local
  ? DurableObjectNamespace<DebugAppendChainSubscriber>("debug-append-chain-subscriber", {
      className: "DebugAppendChainSubscriber",
      sqlite: true,
    })
  : undefined;

const { worker, afterFinalize } = await IterateApp(ctx, {
  bindings: {
    CLERK_JWT_KEY: ctx.runtimeConfig.clerk.jwtKey.exposeSecret(),
    CLERK_PUBLISHABLE_KEY: ctx.runtimeConfig.clerk.publishableKey,
    CLERK_SECRET_KEY: ctx.runtimeConfig.clerk.secretKey.exposeSecret(),
    CLERK_SIGN_IN_URL: ctx.runtimeConfig.clerk.signInUrl,
    CLERK_SIGN_UP_URL: ctx.runtimeConfig.clerk.signUpUrl,
    DB: db,
    DO_CATALOG: db,
    AI: Ai(),
    ARTIFACTS_ACCOUNT_ID: artifactsAccountId,
    ARTIFACTS_NAMESPACE: artifactsNamespace,
    LOADER: WorkerLoader(),
    CODEMODE_SESSION: codemodeSession,
    AGENT: agent,
    ARTIFACTS: Artifacts({ namespace: artifactsNamespace }),
    PROJECT: project,
    SLACK_AGENT: slackAgent,
    SLACK_INTEGRATION: slackIntegration,
    REPO: repo,
    PROJECT_MCP_SERVER_CONNECTION: projectMcpServerConnection,
    OUTBOUND_MCP_FROM_OUR_CLIENT_CAPABILITY: outboundMcpFromOurClientCapability,
    STREAM: stream,
    WORKSPACE: workspace,
    ...(debugAppendChainSubscriber == null
      ? {}
      : { DEBUG_APPEND_CHAIN_SUBSCRIBER: debugAppendChainSubscriber }),
    ...(slackBotToken == null ? {} : { APP_CONFIG_SLACK_BOT_TOKEN: alchemy.secret(slackBotToken) }),
  },
  // OS2 dispatches first-party capabilities through ctx.exports loopback
  // bindings. Local vitest config still uses Cloudflare's broad `experimental`
  // flag, but deployed Workers must request the concrete runtime flag.
  compatibilityFlags: ["enable_ctx_exports"],
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

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
