import { createHash } from "node:crypto";
import alchemy from "alchemy";
import {
  Ai,
  Container,
  D1Database,
  DurableObjectNamespace,
  R2Bucket,
  Worker,
  WorkerLoader,
} from "alchemy/cloudflare";
import { Artifacts } from "@iterate-com/shared/alchemy/artifacts";
import { initAlchemy } from "@iterate-com/shared/alchemy/init";
import { IterateApp } from "@iterate-com/shared/alchemy/iterate-app";
import type { Sandbox } from "@cloudflare/sandbox";
import type { StreamDurableObject } from "@iterate-com/shared/streams/stream-durable-object";
import manifest, { AppConfig } from "./src/app.ts";
import type { CodemodeSession } from "./src/domains/codemode/durable-objects/codemode-session.ts";
import type { DebugAppendChainSubscriber } from "./src/durable-objects/debug-append-chain-subscriber.ts";
import type { ProjectDurableObject } from "./src/domains/projects/durable-objects/project-durable-object.ts";
import type { ProjectMcpServerConnection } from "./src/domains/inbound-mcp-server/durable-objects/project-mcp-server-connection.ts";
import type { AgentDurableObject } from "./src/domains/agents/durable-objects/agent-durable-object.ts";
import type { RepoDurableObject } from "./src/domains/repos/durable-objects/repo-durable-object.ts";
import type { SandboxDurableObject } from "./src/domains/sandboxes/durable-objects/sandbox-durable-object.ts";
import type { SlackAgentDurableObject } from "./src/domains/slack/durable-objects/slack-agent-durable-object.ts";
import type { SlackIntegrationDurableObject } from "./src/domains/slack/durable-objects/slack-integration-durable-object.ts";
import type { WorkspaceDurableObject } from "./src/domains/workspaces/durable-objects/workspace-durable-object.ts";
import type { OutboundMcpFromOurClientCapability } from "./src/domains/outbound-mcp-client/entrypoints/outbound-mcp-from-our-client-capability.ts";

const ctx = await initAlchemy(manifest, AppConfig, process.env);
const slackBotToken = ctx.runtimeConfig.slackBotToken?.exposeSecret();
const r2Credentials = await getR2Credentials();

const db = await D1Database("os-db", {
  name: `${ctx.workerName}-db`,
  migrationsDir: "./src/db/migrations",
  adopt: true,
});

// os serves project hosts at <slug>.iterate.app (prod),
// <slug>.iterate-dev-jonas.app (dev), and <slug>.iterate-preview-N.app
// (preview). The preview app shell deliberately lives on the sibling
// iterate-preview-N.com zone (`os.iterate-preview-N.com`) so project/MCP hosts
// can own the iterate-preview-N.app zone cleanly.
const projectHostnameBases = ctx.runtimeConfig.projectHostnameBases ?? [];
const artifactsAccountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
const artifactsNamespace = `${ctx.workerName}-repos`;
const artifacts = Artifacts({ namespace: artifactsNamespace });
const sandboxStorageBucket = await R2Bucket("sandbox-storage", {
  name: `${ctx.workerName}-sandbox-storage`,
  adopt: true,
  empty: true,
  dev: {
    remote: false,
  },
});
const sandboxRuntime = await Container<Sandbox>("sandbox-runtime", {
  className: "Sandbox",
  build: {
    context: ".",
    dockerfile: "Dockerfile.sandbox",
  },
  instanceType: "lite",
  maxInstances: 10,
  adopt: true,
  dev: {
    remote: process.env.SANDBOX_RUNTIME_REMOTE_DEV === "true",
  },
});
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
const sandboxRepo = DurableObjectNamespace<RepoDurableObject>("sandbox-repo", {
  className: "RepoDurableObject",
  sqlite: true,
});
const projectSandbox = DurableObjectNamespace<SandboxDurableObject>("project-sandbox", {
  className: "SandboxDurableObject",
  sqlite: true,
});
const sandboxStream = DurableObjectNamespace<StreamDurableObject>("sandbox-stream", {
  className: "StreamDurableObject",
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

const sandboxStorageBindings = {
  SANDBOX_STORAGE_BUCKET_NAME: sandboxStorageBucket.name,
  SANDBOX_STORAGE_ENDPOINT:
    process.env.SANDBOX_STORAGE_ENDPOINT ??
    `https://${artifactsAccountId}.r2.cloudflarestorage.com`,
  SANDBOX_STORAGE_LOCAL_DEV: ctx.app.local ? "true" : "false",
  ...(r2Credentials == null
    ? {}
    : {
        R2_ACCESS_KEY_ID: alchemy.secret(r2Credentials.accessKeyId),
        R2_SECRET_ACCESS_KEY: alchemy.secret(r2Credentials.secretAccessKey),
      }),
};

const sandboxWorker = await Worker("sandboxes-worker", {
  name: `${ctx.workerName}-sandboxes`,
  entrypoint: "./src/domains/sandboxes/entrypoints/sandboxes-worker.ts",
  adopt: true,
  compatibilityFlags: ["nodejs_compat"],
  bindings: {
    ARTIFACTS_ACCOUNT_ID: artifactsAccountId,
    ARTIFACTS_NAMESPACE: artifactsNamespace,
    ARTIFACTS: artifacts,
    CLOUDFLARE_ACCOUNT_ID: artifactsAccountId,
    DO_CATALOG: db,
    PROJECT_SANDBOX: projectSandbox,
    REPO: sandboxRepo,
    SANDBOX_RUNTIME: sandboxRuntime,
    SANDBOX_STORAGE: sandboxStorageBucket,
    STREAM: sandboxStream,
    ...sandboxStorageBindings,
  },
});

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
    ARTIFACTS: artifacts,
    PROJECT: project,
    SLACK_AGENT: slackAgent,
    SLACK_INTEGRATION: slackIntegration,
    REPO: repo,
    PROJECT_MCP_SERVER_CONNECTION: projectMcpServerConnection,
    OUTBOUND_MCP_FROM_OUR_CLIENT_CAPABILITY: outboundMcpFromOurClientCapability,
    SANDBOXES: sandboxWorker,
    SANDBOXES_CAPABILITY: Worker.experimentalEntrypoint(sandboxWorker, "SandboxesCapability"),
    STREAM: stream,
    WORKSPACE: workspace,
    ...(debugAppendChainSubscriber == null
      ? {}
      : { DEBUG_APPEND_CHAIN_SUBSCRIBER: debugAppendChainSubscriber }),
    ...(slackBotToken == null ? {} : { APP_CONFIG_SLACK_BOT_TOKEN: alchemy.secret(slackBotToken) }),
  },
  extraRouteHostnames: projectHostnameBases.flatMap(projectRouteHostnamesForBase),
});

export { worker };

await ctx.app.finalize();
await afterFinalize();

if (!ctx.app.local) process.exit(0);

/**
 * Convert OS project-host bases into Cloudflare route host patterns.
 *
 * Normal bases use dotted project subdomains (`<slug>.<base>`). OS preview
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

async function getR2Credentials() {
  const explicitAccessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const explicitSecretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();

  if (explicitAccessKeyId || explicitSecretAccessKey) {
    if (!explicitAccessKeyId || !explicitSecretAccessKey) {
      throw new Error("R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must be provided together.");
    }
    return {
      accessKeyId: explicitAccessKeyId,
      secretAccessKey: explicitSecretAccessKey,
    };
  }

  if (ctx.app.local) return null;

  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!token) return null;

  const response = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Could not verify Cloudflare API token for R2 credentials: ${response.status}`);
  }

  const body = (await response.json()) as {
    result?: { id?: string };
    success?: boolean;
  };
  const accessKeyId = body.result?.id;
  if (body.success !== true || !accessKeyId) {
    throw new Error("Could not derive R2 access key id from Cloudflare API token.");
  }

  return {
    accessKeyId,
    secretAccessKey: createHash("sha256").update(token).digest("hex"),
  };
}
