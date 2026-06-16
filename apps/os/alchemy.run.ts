import * as Alchemy from "alchemy";
import { adopt } from "alchemy/AdoptPolicy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { z } from "zod";
import { compileRawAppConfigFromEnv } from "@iterate-com/shared/config";
import { slugify } from "@iterate-com/shared/slugify";
import { prepareLocalDevServer } from "@iterate-com/shared/alchemy/local-dev-server";
import { ensureLocalDevOAuthClient } from "./src/auth/dev-oauth-client-bootstrap.ts";
import { AppConfig } from "./src/config.ts";
import type { ItxDurableObject } from "./src/itx/itx-durable-object.ts";
import type { DebugAppendChainSubscriber } from "./src/durable-objects/debug-append-chain-subscriber.ts";
import type { ProjectDurableObject } from "./src/domains/projects/durable-objects/project-durable-object.ts";
import type { ProjectMcpServerConnection } from "./src/domains/inbound-mcp-server/durable-objects/project-mcp-server-connection.ts";
import type { AgentDurableObject } from "./src/domains/agents/durable-objects/agent-durable-object.ts";
import type { RepoDurableObject } from "./src/domains/repos/durable-objects/repo-durable-object.ts";
import type { SlackAgentDurableObject } from "./src/domains/slack/durable-objects/slack-agent-durable-object.ts";
import type { SlackIntegrationDurableObject } from "./src/domains/slack/durable-objects/slack-integration-durable-object.ts";
import type { WorkspaceDurableObject } from "./src/domains/workspaces/durable-objects/workspace-durable-object.ts";
import type { Stream } from "./src/domains/streams/engine/workers/durable-objects/stream.ts";

const ITERATE_WORKER_OBSERVABILITY = {
  enabled: true,
  headSamplingRate: 1,
  logs: { enabled: true, headSamplingRate: 1, persist: true, invocationLogs: true },
  traces: { enabled: true, persist: true, headSamplingRate: 1 },
} as const;

const resolvedAuthIssuer =
  process.env.APP_CONFIG_ITERATE_AUTH__ISSUER ?? process.env.ITERATE_OAUTH_ISSUER;

const AlchemyEnv = z.object({
  ALCHEMY_LOCAL: z.stringbool(),
  ALCHEMY_STAGE: z
    .string()
    .trim()
    .min(1, "ALCHEMY_STAGE is required")
    .regex(/^[\w-]+$/, "ALCHEMY_STAGE must contain only letters, numbers, underscores, or hyphens"),
  CLOUDFLARE_ACCOUNT_ID: z.string().trim().min(1, "CLOUDFLARE_ACCOUNT_ID is required"),
});

async function loadBootstrap() {
  const env: Record<string, string | undefined> = {
    ...process.env,
    APP_CONFIG_ITERATE_AUTH__ISSUER: resolvedAuthIssuer,
    APP_CONFIG_ITERATE_AUTH__CLIENT_ID:
      process.env.APP_CONFIG_ITERATE_AUTH__CLIENT_ID ?? process.env.ITERATE_OAUTH_CLIENT_ID,
    APP_CONFIG_ITERATE_AUTH__CLIENT_SECRET:
      process.env.APP_CONFIG_ITERATE_AUTH__CLIENT_SECRET ?? process.env.ITERATE_OAUTH_CLIENT_SECRET,
    APP_CONFIG_ITERATE_AUTH__JWKS: await resolveStaticAuthJwks(resolvedAuthIssuer),
    APP_CONFIG_ITERATE_AUTH__SERVICE_TOKEN:
      process.env.APP_CONFIG_ITERATE_AUTH__SERVICE_TOKEN ?? process.env.ITERATE_AUTH_SERVICE_TOKEN,
  };

  const localDevServer = await prepareLocalDevServer(env);
  if (localDevServer && !env.APP_CONFIG_PROJECT_HOSTNAME_BASES) {
    env.APP_CONFIG_PROJECT_HOSTNAME_BASES = JSON.stringify(["localhost"]);
  }
  if (localDevServer) {
    env.APP_CONFIG_ITERATE_AUTH__RESOURCE ||= `http://${new URL(localDevServer.baseUrl).hostname}`;
  }

  await ensureLocalDevOAuthClient(env);

  const rawRuntimeConfig = compileRawAppConfigFromEnv({
    configSchema: AppConfig,
    prefix: "APP_CONFIG_",
    env,
  }) as Record<string, unknown>;

  return {
    alchemyEnv: AlchemyEnv.parse(env),
    rawRuntimeConfig,
    runtimeConfig: AppConfig.parse(rawRuntimeConfig),
  };
}

const bootstrap = await loadBootstrap();

const workerName = slugify(`os-${bootstrap.alchemyEnv.ALCHEMY_STAGE}`);
const appConfigBinding = bootstrap.alchemyEnv.ALCHEMY_LOCAL
  ? JSON.stringify(bootstrap.rawRuntimeConfig, null, 2)
  : Redacted.make(JSON.stringify(bootstrap.rawRuntimeConfig, null, 2));
const slackBotToken = bootstrap.runtimeConfig.slackBotToken?.exposeSecret();
const artifactsAccountId = bootstrap.alchemyEnv.CLOUDFLARE_ACCOUNT_ID;
const artifactsNamespace = `${workerName}-repos`;
const globalStreamNamespace = `${workerName}-global`;

const workerNames = {
  agent: `${workerName}-agent`,
  app: `${workerName}-app`,
  debugSubscriber: `${workerName}-debug-subscriber`,
  ingress: workerName,
  itx: `${workerName}-itx`,
  mcp: `${workerName}-mcp`,
  project: `${workerName}-project`,
  repo: `${workerName}-repo`,
  slackAgent: `${workerName}-slack-agent`,
  slackIntegration: `${workerName}-slack-integration`,
  stream: `${workerName}-stream`,
  workspace: `${workerName}-workspace`,
} as const;

export const db = Cloudflare.D1Database("os-db", {
  name: `${workerName}-db`,
  migrationsDir: "./src/db/migrations",
}).pipe(adopt(true));

export const artifactEventsQueue = Cloudflare.Queue("artifact-events", {
  name: `${workerName}-artifact-events`,
}).pipe(adopt(true));

export const itxBuildCache = Cloudflare.R2Bucket("itx-build-cache", {
  name: `${workerName}-itx-build-cache`,
}).pipe(adopt(true));

const artifacts = Cloudflare.Artifacts("ARTIFACTS", {
  namespace: artifactsNamespace,
});
// Alchemy v2 beta does not currently expose the v1 native Workers AI marker.
// Its public AiGateway resource emits the same Worker binding shape, but also
// provisions/reads an AI Gateway. OS only needs runtime `env.AI.run(...)`, so
// the stack binds the raw native `ai` binding onto the concrete Workers below.
const loader = Cloudflare.DynamicWorkerLoader("LOADER");

const stream = Cloudflare.DurableObjectNamespace<Stream>("stream", {
  className: "StreamDurableObject",
  scriptName: workerNames.stream,
});
const itxContext = Cloudflare.DurableObjectNamespace<ItxDurableObject>("itx-context", {
  className: "ItxDurableObject",
  scriptName: workerNames.itx,
});
const projectMcpServerConnection = Cloudflare.DurableObjectNamespace<ProjectMcpServerConnection>(
  "project-mcp-server-connection-local",
  {
    className: "ProjectMcpServerConnection",
    scriptName: workerNames.mcp,
  },
);
const project = Cloudflare.DurableObjectNamespace<ProjectDurableObject>("project", {
  className: "ProjectDurableObject",
  scriptName: workerNames.project,
});
const repo = Cloudflare.DurableObjectNamespace<RepoDurableObject>("repo", {
  className: "RepoDurableObject",
  scriptName: workerNames.repo,
});
const workspace = Cloudflare.DurableObjectNamespace<WorkspaceDurableObject>("workspace", {
  className: "WorkspaceDurableObject",
  scriptName: workerNames.workspace,
});
const agent = Cloudflare.DurableObjectNamespace<AgentDurableObject>("agent", {
  className: "AgentDurableObject",
  scriptName: workerNames.agent,
});
const slackIntegration = Cloudflare.DurableObjectNamespace<SlackIntegrationDurableObject>(
  "slack-integration",
  {
    className: "SlackIntegrationDurableObject",
    scriptName: workerNames.slackIntegration,
  },
);
const slackAgent = Cloudflare.DurableObjectNamespace<SlackAgentDurableObject>("slack-agent", {
  className: "SlackAgentDurableObject",
  scriptName: workerNames.slackAgent,
});
const debugAppendChainSubscriber = bootstrap.alchemyEnv.ALCHEMY_LOCAL
  ? Cloudflare.DurableObjectNamespace<DebugAppendChainSubscriber>("debug-append-chain-subscriber", {
      className: "DebugAppendChainSubscriber",
      scriptName: workerNames.debugSubscriber,
    })
  : undefined;

const missingScripts = bootstrap.alchemyEnv.ALCHEMY_LOCAL
  ? new Set<string>()
  : await findMissingWorkerScripts(
      Object.entries(workerNames)
        .filter(([id]) => id !== "debugSubscriber")
        .map(([, name]) => name),
    );
if (missingScripts.size > 0) {
  console.warn(
    `[alchemy.run] Bootstrap: ${[...missingScripts].join(", ")} not deployed yet; ` +
      "cross-script bindings to them are omitted until the next deploy.",
  );
}

function withoutBindingsToMissingScripts<const B extends Cloudflare.WorkerBindingProps>(
  owner: string,
  bindings: B,
): B {
  if (missingScripts.size === 0) return bindings;
  return Object.fromEntries(
    Object.entries(bindings).filter(([name, value]) => {
      const resolved = value as { scriptName?: string } | null | undefined;
      if (
        !resolved?.scriptName ||
        resolved.scriptName === owner ||
        !missingScripts.has(resolved.scriptName)
      ) {
        return true;
      }
      console.warn(`[alchemy.run]   ${owner}: omitting ${name} -> ${resolved.scriptName}`);
      return false;
    }),
  ) as B;
}

function osWorker<const Env extends Cloudflare.WorkerBindingProps>(
  id: keyof typeof workerNames,
  props: {
    compatibilityFlags?: string[];
    env: Env;
    main: string;
  },
) {
  const name = workerNames[id];
  return Cloudflare.Worker(id, {
    name,
    main: props.main,
    url: false,
    compatibility: { flags: props.compatibilityFlags },
    env: {
      ...withoutBindingsToMissingScripts(name, props.env),
      APP_CONFIG: appConfigBinding,
    },
    observability: ITERATE_WORKER_OBSERVABILITY,
  }).pipe(adopt(true));
}

const slackBotTokenBinding: Cloudflare.WorkerBindingProps =
  slackBotToken == null ? {} : { APP_CONFIG_SLACK_BOT_TOKEN: Redacted.make(slackBotToken) };

const loopbackUnionBindings = {
  AGENT: agent,
  DB: db,
  DO_CATALOG: db,
  ITX_BUILD_CACHE: itxBuildCache,
  ITX_CONTEXT: itxContext,
  LOADER: loader,
  PROJECT: project,
  REPO: repo,
  STREAM: stream,
  WORKSPACE: workspace,
  ...slackBotTokenBinding,
};

const workspaceWorker = osWorker("workspace", {
  main: "./src/workers/workspace.ts",
  compatibilityFlags: ["nodejs_compat"],
  env: { DO_CATALOG: db, WORKSPACE: workspace },
});

const slackAgentWorker = osWorker("slackAgent", {
  main: "./src/workers/slack-agent.ts",
  env: {
    AGENT: agent,
    DO_CATALOG: db,
    SLACK_AGENT: slackAgent,
    STREAM: stream,
    ...slackBotTokenBinding,
  },
});

const repoWorker = osWorker("repo", {
  main: "./src/workers/repo.ts",
  compatibilityFlags: ["nodejs_compat"],
  env: {
    ...(bootstrap.alchemyEnv.ALCHEMY_LOCAL ? {} : { ARTIFACTS: artifacts }),
    ARTIFACTS_ACCOUNT_ID: artifactsAccountId,
    ARTIFACTS_NAMESPACE: artifactsNamespace,
    DO_CATALOG: db,
    GLOBAL_STREAM_NAMESPACE: globalStreamNamespace,
    REPO: repo,
    STREAM: stream,
  },
});

const itxWorker = osWorker("itx", {
  main: "./src/workers/itx.ts",
  compatibilityFlags: ["global_fetch_strictly_public"],
  env: loopbackUnionBindings,
});

const agentWorker = osWorker("agent", {
  main: "./src/workers/agent.ts",
  compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
  env: loopbackUnionBindings,
});

const slackIntegrationWorker = osWorker("slackIntegration", {
  main: "./src/workers/slack-integration.ts",
  env: {
    AGENT: agent,
    DB: db,
    DO_CATALOG: db,
    SLACK_AGENT: slackAgent,
    SLACK_INTEGRATION: slackIntegration,
    STREAM: stream,
    ...slackBotTokenBinding,
  },
});

const mcpWorker = osWorker("mcp", {
  main: "./src/workers/mcp.ts",
  compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
  env: {
    ...loopbackUnionBindings,
    PROJECT_MCP_SERVER_CONNECTION: projectMcpServerConnection,
  },
});

const projectWorker = osWorker("project", {
  main: "./src/workers/project.ts",
  compatibilityFlags: ["nodejs_als", "global_fetch_strictly_public"],
  env: loopbackUnionBindings,
});

const debugSubscriberWorker = bootstrap.alchemyEnv.ALCHEMY_LOCAL
  ? osWorker("debugSubscriber", {
      main: "./src/workers/debug-append-chain-subscriber.ts",
      env: {
        DEBUG_APPEND_CHAIN_SUBSCRIBER: debugAppendChainSubscriber!,
        STREAM: stream,
      },
    })
  : undefined;

const streamWorker = osWorker("stream", {
  main: "./src/workers/stream.ts",
  env: {
    AGENT: agent,
    ITX_CONTEXT: itxContext,
    PROJECT: project,
    REPO: repo,
    SLACK_AGENT: slackAgent,
    SLACK_INTEGRATION: slackIntegration,
    STREAM: stream,
    ...(debugAppendChainSubscriber == null
      ? {}
      : { DEBUG_APPEND_CHAIN_SUBSCRIBER: debugAppendChainSubscriber }),
  },
});

const appWorker = Cloudflare.Vite("app", {
  name: workerNames.app,
  url: false,
  rootDir: process.cwd(),
  compatibility: { flags: ["nodejs_compat", "global_fetch_strictly_public"] },
  env: {
    ...loopbackUnionBindings,
    AGENT: agent,
    ARTIFACTS: artifacts,
    ARTIFACTS_ACCOUNT_ID: artifactsAccountId,
    ARTIFACTS_NAMESPACE: artifactsNamespace,
    GLOBAL_STREAM_NAMESPACE: globalStreamNamespace,
    MCP: mcpWorker,
    PROJECT_HOST: projectWorker,
    PROJECT_MCP_SERVER_CONNECTION: projectMcpServerConnection,
    SLACK_AGENT: slackAgent,
    SLACK_INTEGRATION: slackIntegration,
    ...(debugAppendChainSubscriber == null
      ? {}
      : { DEBUG_APPEND_CHAIN_SUBSCRIBER: debugAppendChainSubscriber }),
    APP_CONFIG: appConfigBinding,
  },
  dev: bootstrap.alchemyEnv.ALCHEMY_LOCAL
    ? {
        host: process.env.HOST ?? "127.0.0.1",
        port: Number(process.env.PORT ?? 5173),
        strictPort: true,
      }
    : undefined,
}).pipe(adopt(true));

const ingressWorker = osWorker("ingress", {
  main: "./src/workers/ingress.ts",
  env: {
    APP: appWorker,
    DB: db,
    MCP: mcpWorker,
    PROJECT_HOST: projectWorker,
  },
});

export const workers = {
  agent: agentWorker,
  app: appWorker,
  debugSubscriber: debugSubscriberWorker,
  ingress: ingressWorker,
  itx: itxWorker,
  mcp: mcpWorker,
  project: projectWorker,
  repo: repoWorker,
  slackAgent: slackAgentWorker,
  slackIntegration: slackIntegrationWorker,
  stream: streamWorker,
  workspace: workspaceWorker,
};

const baseUrlHostname = bootstrap.runtimeConfig.baseUrl
  ? new URL(bootstrap.runtimeConfig.baseUrl).hostname
  : undefined;
const eventDocsRouteHostname = eventDocsHostnameForAppBaseUrl(bootstrap.runtimeConfig.baseUrl);
const mcpRouteHostname = routeHostnameForUrl(bootstrap.runtimeConfig.mcp?.baseUrl);
const routeHostnames = [
  ...new Set(
    [
      ...(baseUrlHostname ? [baseUrlHostname] : []),
      ...(eventDocsRouteHostname ? [eventDocsRouteHostname] : []),
      ...(mcpRouteHostname ? [mcpRouteHostname] : []),
      ...(bootstrap.runtimeConfig.projectHostnameBases ?? []).flatMap(projectRouteHostnamesForBase),
    ].filter((hostname) => !hostname.endsWith(".workers.dev")),
  ),
];
const localApplyConcurrency = bootstrap.alchemyEnv.ALCHEMY_LOCAL ? 1 : "unbounded";

export default Alchemy.Stack(
  "os",
  {
    providers: Cloudflare.providers(),
    state: bootstrap.alchemyEnv.ALCHEMY_LOCAL ? Alchemy.localState() : Cloudflare.state(),
  },
  Effect.gen(function* () {
    const deployed = yield* Effect.all(
      {
        agent: agentWorker,
        app: appWorker,
        ingress: ingressWorker,
        itx: itxWorker,
        mcp: mcpWorker,
        project: projectWorker,
        repo: repoWorker,
        slackAgent: slackAgentWorker,
        slackIntegration: slackIntegrationWorker,
        stream: streamWorker,
        workspace: workspaceWorker,
        ...(debugSubscriberWorker == null ? {} : { debugSubscriber: debugSubscriberWorker }),
      },
      { concurrency: localApplyConcurrency },
    );

    yield* Effect.all(
      [deployed.agent, deployed.app, deployed.itx, deployed.mcp, deployed.project].map(
        bindNativeWorkersAi,
      ),
      { concurrency: localApplyConcurrency },
    );

    yield* Cloudflare.QueueConsumer("artifact-events-consumer", {
      queueId: (yield* artifactEventsQueue).queueId,
      scriptName: deployed.repo.workerName,
    }).pipe(adopt(true));

    yield* EnsureWorkerRoutes({
      hostnames: routeHostnames,
      local: bootstrap.alchemyEnv.ALCHEMY_LOCAL,
      slug: "os",
      stage: bootstrap.alchemyEnv.ALCHEMY_STAGE,
      workerName: deployed.ingress.workerName,
    });

    return {
      baseUrl: bootstrap.runtimeConfig.baseUrl,
      local: bootstrap.alchemyEnv.ALCHEMY_LOCAL,
      workers: Object.fromEntries(
        Object.entries(deployed).map(([id, worker]) => [id, worker.workerName]),
      ),
    };
  }),
);

function bindNativeWorkersAi(worker: Cloudflare.Worker) {
  return worker.bind("AI", { bindings: [{ type: "ai", name: "AI" }] });
}

const EnsureWorkerRoutes = Alchemy.Action<
  "Iterate.WorkerRoutes",
  {
    hostnames: string[];
    local: boolean;
    slug: string;
    stage: string;
    workerName: string;
  },
  { hostnames: string[] }
>("Iterate.WorkerRoutes", (input) =>
  Effect.promise(async () => {
    if (input.local || input.hostnames.length === 0) return { hostnames: [] };

    const cloudflareApi = createCloudflareApi();
    await waitForCloudflareWorkerScript({
      cloudflareApi,
      workerName: input.workerName,
    });

    const routeZoneIds = new Map<string, string>();
    for (const hostname of input.hostnames) {
      const { zoneId } = await findActiveZoneForHostname(cloudflareApi, hostname);
      routeZoneIds.set(hostname, zoneId);
      await ensureCloudflareWorkerRoute({
        cloudflareApi,
        pattern: `${hostname}/*`,
        script: input.workerName,
        zoneId,
      });
    }

    await Promise.all(
      input.hostnames.filter(shouldCreateDnsRecordForRouteHostname).map(async (hostname) => {
        const zoneId =
          routeZoneIds.get(hostname) ??
          (await findActiveZoneForHostname(cloudflareApi, hostname)).zoneId;
        await ensureCloudflareDnsRecord({
          cloudflareApi,
          record: {
            type: "A",
            name: hostname,
            content: "192.0.2.1",
            proxied: true,
            ttl: 1,
            comment: `Managed by ${input.slug} alchemy (${input.stage}).`,
          },
          zoneId,
        });
      }),
    );

    return { hostnames: input.hostnames };
  }),
);

type CloudflareApi = ReturnType<typeof createCloudflareApi>;

function createCloudflareApi() {
  const token = requireEnv("CLOUDFLARE_API_TOKEN");
  const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
  const baseUrl = "https://api.cloudflare.com/client/v4";

  async function request(method: string, path: string, body?: unknown) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return response;
  }

  return {
    accountId,
    get: (path: string) => request("GET", path),
    post: (path: string, body: unknown) => request("POST", path, body),
    put: (path: string, body: unknown) => request("PUT", path, body),
  };
}

async function fetchJwksWithRetry(url: string): Promise<{ keys: unknown[] }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const jwks = (await response.json()) as { keys?: unknown[] };
      if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) {
        throw new Error("JWKS response has no keys");
      }
      return jwks as { keys: unknown[] };
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        console.warn(`[alchemy.run] JWKS fetch attempt ${attempt} failed, retrying:`, error);
        await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
      }
    }
  }
  throw lastError;
}

async function resolveStaticAuthJwks(issuer: string | undefined) {
  if (!issuer) return undefined;

  let issuerUrl: URL;
  try {
    issuerUrl = new URL(issuer);
  } catch {
    return undefined;
  }
  const issuerIsLoopback = ["localhost", "127.0.0.1", "::1"].includes(issuerUrl.hostname);

  const explicit = process.env.APP_CONFIG_ITERATE_AUTH__JWKS ?? process.env.ITERATE_AUTH_JWKS;
  if (explicit && !issuerIsLoopback) return withForgePublicKey(explicit);

  try {
    const jwks = await fetchJwksWithRetry(`${issuer.replace(/\/+$/, "")}/jwks`);
    return withForgePublicKey(JSON.stringify(jwks));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (process.env.AUTH_FORGE_PRIVATE_JWK?.trim() && !issuerIsLoopback) {
      throw new Error(
        `[alchemy.run] Forge key is set but the deploy-time JWKS fetch from ${issuer} failed ` +
          `(${message}). The forge pubkey can only be trusted via a baked static JWKS.`,
      );
    }
    console.warn(
      `[alchemy.run] Could not fetch JWKS from ${issuer} at deploy time; ` +
        "the worker will fetch it at runtime instead.",
      message,
    );
    return undefined;
  }
}

function withForgePublicKey(jwksJson: string) {
  const forgePrivateJwk = process.env.AUTH_FORGE_PRIVATE_JWK?.trim();
  if (!forgePrivateJwk) return jwksJson;
  const isProdStage = process.env.ALCHEMY_STAGE?.trim() === "prd";
  const isProdIssuer = (resolvedAuthIssuer ?? "").includes("auth.iterate.com");
  const allowProduction = /^(1|true|yes)$/i.test(
    process.env.AUTH_FORGE_ALLOW_PRODUCTION?.trim() ?? "",
  );
  if ((isProdStage || isProdIssuer) && !allowProduction) {
    throw new Error(
      "AUTH_FORGE_PRIVATE_JWK is present in a production config " +
        `(stage=${process.env.ALCHEMY_STAGE}, issuer=${resolvedAuthIssuer}) without ` +
        "AUTH_FORGE_ALLOW_PRODUCTION=true.",
    );
  }
  try {
    const jwks = JSON.parse(jwksJson) as { keys: Record<string, unknown>[] };
    const { d: _privateKey, ...publicJwk } = JSON.parse(forgePrivateJwk) as Record<
      string,
      unknown
    > & { d?: string };
    if (!publicJwk.kid || !publicJwk.kty) {
      throw new Error("AUTH_FORGE_PRIVATE_JWK must be a JWK with kid and kty");
    }
    if (!jwks.keys.some((key) => key.kid === publicJwk.kid)) {
      jwks.keys.push(publicJwk);
    }
    return JSON.stringify(jwks);
  } catch (error) {
    throw new Error(`Invalid AUTH_FORGE_PRIVATE_JWK: ${error}`);
  }
}

function projectRouteHostnamesForBase(base: string) {
  return [base, `*.${base}`];
}

function routeHostnameForUrl(url: string | undefined) {
  if (!url) return undefined;
  return new URL(url).hostname;
}

function eventDocsHostnameForAppBaseUrl(baseUrl: string | undefined) {
  if (!baseUrl) return null;

  const hostname = new URL(baseUrl).hostname.toLowerCase().replace(/\.$/, "");
  if (hostname.startsWith("localhost") || hostname === "127.0.0.1" || hostname === "::1") {
    return null;
  }

  if (hostname === "os.iterate.com") return "events.iterate.com";
  if (hostname.startsWith("os.")) return `events.${hostname.slice("os.".length)}`;
  return null;
}

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function findMissingWorkerScripts(names: string[]) {
  const cloudflareApi = createCloudflareApi();
  const missing = new Set<string>();
  await Promise.all(
    names.map(async (name) => {
      const response = await cloudflareApi.get(
        `/accounts/${cloudflareApi.accountId}/workers/scripts/${encodeURIComponent(name)}/settings`,
      );
      if (response.status === 404) {
        missing.add(name);
        return;
      }
      if (!response.ok) {
        throw new Error(
          `Failed to check worker script ${name}: ${response.status} ${await response.text()}`,
        );
      }
    }),
  );
  return missing;
}

async function waitForCloudflareWorkerScript(input: {
  cloudflareApi: CloudflareApi;
  workerName: string;
}) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const response = await input.cloudflareApi.get(
      `/accounts/${input.cloudflareApi.accountId}/workers/scripts/${encodeURIComponent(input.workerName)}/settings`,
    );
    if (response.ok) return;
    if (response.status !== 404) {
      throw new Error(
        `Failed to check worker script ${input.workerName}: ${response.status} ${await response.text()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Worker script ${input.workerName} was not visible after deploy.`);
}

async function ensureCloudflareWorkerRoute(input: {
  cloudflareApi: CloudflareApi;
  pattern: string;
  script: string;
  zoneId: string;
}) {
  const response = await input.cloudflareApi.post(`/zones/${input.zoneId}/workers/routes`, {
    pattern: input.pattern,
    script: input.script,
  });
  if (response.ok) return;

  const body = await response.text();
  if (!body.includes("already exists") && !body.includes("workers.api.error.route_found")) {
    throw new Error(`Failed to create route ${input.pattern}: ${response.status} ${body}`);
  }

  const listResponse = await input.cloudflareApi.get(`/zones/${input.zoneId}/workers/routes`);
  if (!listResponse.ok) {
    throw new Error(
      `Failed to list routes for ${input.pattern}: ${listResponse.status} ${await listResponse.text()}`,
    );
  }
  const listResult = (await listResponse.json()) as {
    result?: Array<{ id: string; pattern?: string }>;
  };
  const existing = listResult.result?.find((route) => route.pattern === input.pattern);
  if (!existing) return;

  const updateResponse = await input.cloudflareApi.put(
    `/zones/${input.zoneId}/workers/routes/${existing.id}`,
    {
      pattern: input.pattern,
      script: input.script,
    },
  );
  if (!updateResponse.ok) {
    throw new Error(
      `Failed to update route ${input.pattern}: ${updateResponse.status} ${await updateResponse.text()}`,
    );
  }
}

function shouldCreateDnsRecordForRouteHostname(hostname: string) {
  return !hostname.startsWith("*") || hostname.startsWith("*.");
}

async function ensureCloudflareDnsRecord(input: {
  cloudflareApi: CloudflareApi;
  record: {
    comment: string;
    content: string;
    name: string;
    proxied: boolean;
    ttl: number;
    type: "A";
  };
  zoneId: string;
}) {
  const params = new URLSearchParams({ name: input.record.name });
  const listResponse = await input.cloudflareApi.get(
    `/zones/${input.zoneId}/dns_records?${params.toString()}`,
  );
  if (!listResponse.ok) {
    throw new Error(
      `Failed to check DNS record ${input.record.name}: ${listResponse.status} ${await listResponse.text()}`,
    );
  }

  const listResult = (await listResponse.json()) as {
    result?: Array<{ id: string; name?: string; proxied?: boolean; type?: string }>;
  };
  const existingProxiedRecord = listResult.result?.find(
    (record) => record.name === input.record.name && record.proxied,
  );
  if (existingProxiedRecord) return;

  const existingRecordId = listResult.result?.find(
    (record) => record.name === input.record.name && record.type === input.record.type,
  )?.id;
  const response = existingRecordId
    ? await input.cloudflareApi.put(
        `/zones/${input.zoneId}/dns_records/${existingRecordId}`,
        input.record,
      )
    : await input.cloudflareApi.post(`/zones/${input.zoneId}/dns_records`, input.record);

  if (!response.ok) {
    throw new Error(
      `Failed to upsert DNS record ${input.record.name}: ${response.status} ${await response.text()}`,
    );
  }
}

async function findActiveZoneForHostname(
  cloudflareApi: CloudflareApi,
  hostname: string,
): Promise<{ zoneId: string; zoneName: string }> {
  const normalized = hostname.replace(/^\*\./, "");
  const labels = normalized.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const zoneName = labels.slice(i).join(".");
    const params = new URLSearchParams({ name: zoneName, status: "active" });
    const response = await cloudflareApi.get(`/zones?${params.toString()}`);
    if (!response.ok) {
      throw new Error(
        `Failed to find Cloudflare zone for ${hostname}: ${response.status} ${await response.text()}`,
      );
    }
    const body = (await response.json()) as { result?: Array<{ id: string; name: string }> };
    const zone = body.result?.find((candidate) => candidate.name === zoneName);
    if (zone) return { zoneId: zone.id, zoneName: zone.name };
  }
  throw new Error(`No active Cloudflare zone found for hostname ${hostname}.`);
}
