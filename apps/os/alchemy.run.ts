import alchemy from "alchemy";
import {
  Ai,
  D1Database,
  DurableObjectNamespace,
  Queue,
  R2Bucket,
  WorkerLoader,
} from "alchemy/cloudflare";
import { Artifacts } from "@iterate-com/shared/alchemy/artifacts";
import { initAlchemy } from "@iterate-com/shared/alchemy/init";
import { IterateApp } from "@iterate-com/shared/alchemy/iterate-app";
import { prepareLocalDevServer } from "@iterate-com/shared/alchemy/local-dev-server";
import type { Stream } from "@iterate-com/streams/workers/durable-objects/stream";
import { ensureLocalDevOAuthClient } from "./src/auth/dev-oauth-client-bootstrap.ts";
import { AppConfig } from "./src/config.ts";
import type { ItxDurableObject } from "./src/itx/itx-durable-object.ts";
import type { DebugAppendChainSubscriber } from "./src/durable-objects/debug-append-chain-subscriber.ts";
import type { ProjectDurableObject } from "./src/domains/projects/durable-objects/project-durable-object.ts";
import type { ProjectMcpServerConnection } from "./src/domains/inbound-mcp-server/durable-objects/project-mcp-server-connection.ts";
import type { AgentDurableObject } from "./src/domains/agents/durable-objects/agent-durable-object.ts";
import type { DiscordGatewayDurableObject } from "./src/domains/integrations/durable-objects/discord-gateway-durable-object.ts";
import type { IntegrationDurableObject } from "./src/domains/integrations/durable-objects/integration-durable-object.ts";
import type { IntegrationIngressDurableObject } from "./src/domains/integrations/durable-objects/integration-ingress-durable-object.ts";
import type { SecretDurableObject } from "./src/domains/secrets/durable-objects/secret-durable-object.ts";
import type { RepoDurableObject } from "./src/domains/repos/durable-objects/repo-durable-object.ts";
import type { SlackAgentDurableObject } from "./src/domains/slack/durable-objects/slack-agent-durable-object.ts";
import type { WorkspaceDurableObject } from "./src/domains/workspaces/durable-objects/workspace-durable-object.ts";
import { eventDocsHostnameForAppBaseUrl } from "./src/lib/event-docs-host.ts";

const resolvedAuthIssuer =
  process.env.APP_CONFIG_ITERATE_AUTH__ISSUER ?? process.env.ITERATE_OAUTH_ISSUER;

// A static JWKS lets the worker verify auth JWTs without any runtime
// roundtrip to the auth worker, including on cold isolate starts. Fetch it
// from the issuer at deploy time; an explicit env value overrides. A static
// JWKS only verifies tokens from the issuer it was exported from, so a
// loopback issuer (local dev auth server with its own keys) never uses a
// Doppler-provided production JWKS. Key rotation in auth requires an OS
// redeploy. On fetch failure the worker falls back to remote JWKS at runtime.
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
    const response = await fetch(`${issuer.replace(/\/+$/, "")}/jwks`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const jwks = (await response.json()) as { keys?: unknown[] };
    if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) {
      throw new Error("JWKS response has no keys");
    }
    return withForgePublicKey(JSON.stringify(jwks));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A forge-enabled env (dev/preview) needs the forge pubkey in a baked
    // static JWKS — the runtime remote fetch only returns issuer keys, never
    // the forge key, so silently falling back would leave minting broken.
    // Fail the deploy loudly instead. (Loopback issuers — local auth dev —
    // legitimately may be down at deploy and use runtime fetch, so skip them.)
    if (process.env.AUTH_FORGE_PRIVATE_JWK?.trim() && !issuerIsLoopback) {
      throw new Error(
        `[alchemy.run] Forge key is set but the deploy-time JWKS fetch from ${issuer} failed ` +
          `(${message}). The forge pubkey can only be trusted via a baked static JWKS, so this ` +
          `would deploy a worker where minted tokens fail to verify. Aborting — retry the deploy.`,
      );
    }
    console.warn(
      `[alchemy.run] Could not fetch JWKS from ${issuer} at deploy time; ` +
        `the worker will fetch it at runtime instead.`,
      message,
    );
    return undefined;
  }
}

// Dev/preview identity forging: when the Doppler config carries the forge
// private JWK (`AUTH_FORGE_PRIVATE_JWK`, from `_shared/dev` / `_shared/preview`),
// its PUBLIC half joins the worker's trusted JWKS so locally-minted JWTs
// (scripts/auth/mint-session.ts) verify exactly like issuer-signed ones.
// Placement rule: the forge key must never exist in any prd config — enforced
// here as a hard error rather than a silent skip.
function withForgePublicKey(jwksJson: string) {
  const forgePrivateJwk = process.env.AUTH_FORGE_PRIVATE_JWK?.trim();
  if (!forgePrivateJwk) return jwksJson;
  // Two independent backstops so the forge pubkey can never reach a
  // production-serving worker: the stage name AND the issuer identity. A
  // prod-serving deploy under a non-"prd" stage name (hotfix stage, custom
  // hostname) is still caught by the issuer check.
  const isProdStage = process.env.ALCHEMY_STAGE?.trim() === "prd";
  const isProdIssuer = (resolvedAuthIssuer ?? "").includes("auth.iterate.com");
  if (isProdStage || isProdIssuer) {
    throw new Error(
      "AUTH_FORGE_PRIVATE_JWK must never be present in a production config " +
        `(stage=${process.env.ALCHEMY_STAGE}, issuer=${resolvedAuthIssuer}) — remove it from Doppler.`,
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

// Fully-local default dev (config `dev`): no tunnel, no per-user domain. Picks
// a free port, bakes APP_CONFIG_BASE_URL=http://os.localhost:<port>, and
// writes .alchemy/dev-server.json so CLIs can find the running server. No-op
// for configs that set APP_CONFIG_BASE_URL (tunnel-backed dev_<user>,
// dev_localhost, deploys).
const localDevServer = await prepareLocalDevServer(env, { appSlug: "os" });
if (localDevServer && !env.APP_CONFIG_PROJECT_HOSTNAME_BASES) {
  // Project hosts resolve as <proj-slug>.os.localhost:<port> in the browser.
  env.APP_CONFIG_PROJECT_HOSTNAME_BASES = JSON.stringify([
    new URL(localDevServer.baseUrl).hostname,
  ]);
}
if (localDevServer) {
  // The OAuth resource (RFC 8707) must be a registered audience at the auth
  // worker, which can't enumerate arbitrary local ports — use the stable
  // portless loopback origin (mirrored in auth's getOsResourceBases).
  env.APP_CONFIG_ITERATE_AUTH__RESOURCE ||= `http://${new URL(localDevServer.baseUrl).hostname}`;
}

await ensureLocalDevOAuthClient(env);

const ctx = await initAlchemy("os", AppConfig, env);
const slackBotToken = ctx.runtimeConfig.slackBotToken?.exposeSecret();

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
const mcpRouteHostname = routeHostnameForUrl(ctx.runtimeConfig.mcp?.baseUrl);
const eventDocsRouteHostname = eventDocsHostnameForAppBaseUrl(ctx.runtimeConfig.baseUrl);
const artifactsAccountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
const artifactsNamespace = `${ctx.workerName}-repos`;
// Stream namespace for worker-global (non-project-scoped) streams, such as the
// raw Cloudflare event capture stream at /cloudflare/events.
const globalStreamNamespace = `${ctx.workerName}-global`;
const stream = DurableObjectNamespace<Stream>("stream", {
  className: "StreamDurableObject",
  sqlite: true,
});
// itx generic context hosts: one instance per extended context, addressed
// by its journal coordinate (src/itx/journal.ts).
const itxContext = DurableObjectNamespace<ItxDurableObject>("itx-context", {
  className: "ItxDurableObject",
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
const slackAgent = DurableObjectNamespace<SlackAgentDurableObject>("slack-agent", {
  className: "SlackAgentDurableObject",
  sqlite: true,
});
// Integrations spike: generic per-(project, integration) lifecycle hosts, the
// per-integration global ingress router, journal-backed Secrets, and the
// Discord gateway connection holder.
const integration = DurableObjectNamespace<IntegrationDurableObject>("integration", {
  className: "IntegrationDurableObject",
  sqlite: true,
});
const integrationIngress = DurableObjectNamespace<IntegrationIngressDurableObject>(
  "integration-ingress",
  {
    className: "IntegrationIngressDurableObject",
    sqlite: true,
  },
);
const secret = DurableObjectNamespace<SecretDurableObject>("secret", {
  className: "SecretDurableObject",
  sqlite: true,
});
const discordGateway = DurableObjectNamespace<DiscordGatewayDurableObject>("discord-gateway", {
  className: "DiscordGatewayDurableObject",
  sqlite: true,
});
const secretsEncryptionKey = process.env.SECRETS_ENCRYPTION_KEY;
const discordPublicKey = process.env.DISCORD_PUBLIC_KEY;
const discordBotToken = process.env.APP_CONFIG_DISCORD_BOT_TOKEN;
const artifactEventsQueue = await Queue("artifact-events", {
  name: `${ctx.workerName}-artifact-events`,
  adopt: true,
});
// Build memo for repo-sourced itx workers (src/itx/source-build.ts):
// hash-keyed immutable bundles, reproducible from their keys — safe to wipe.
const itxBuildCache = await R2Bucket("itx-build-cache", {
  name: `${ctx.workerName}-itx-build-cache`,
  adopt: true,
  empty: true,
});

const debugAppendChainSubscriber = ctx.app.local
  ? DurableObjectNamespace<DebugAppendChainSubscriber>("debug-append-chain-subscriber", {
      className: "DebugAppendChainSubscriber",
      sqlite: true,
    })
  : undefined;

const { worker, afterFinalize } = await IterateApp(ctx, {
  main: "./src/worker.ts",
  eventSources: [artifactEventsQueue],
  bindings: {
    DB: db,
    DO_CATALOG: db,
    AI: Ai(),
    ARTIFACTS_ACCOUNT_ID: artifactsAccountId,
    ARTIFACTS_NAMESPACE: artifactsNamespace,
    GLOBAL_STREAM_NAMESPACE: globalStreamNamespace,
    LOADER: WorkerLoader(),
    ITX_BUILD_CACHE: itxBuildCache,
    ITX_CONTEXT: itxContext,
    AGENT: agent,
    ARTIFACTS: Artifacts({ namespace: artifactsNamespace }),
    PROJECT: project,
    SLACK_AGENT: slackAgent,
    INTEGRATION: integration,
    INTEGRATION_INGRESS: integrationIngress,
    SECRET: secret,
    DISCORD_GATEWAY: discordGateway,
    REPO: repo,
    PROJECT_MCP_SERVER_CONNECTION: projectMcpServerConnection,
    STREAM: stream,
    WORKSPACE: workspace,
    ...(debugAppendChainSubscriber == null
      ? {}
      : { DEBUG_APPEND_CHAIN_SUBSCRIBER: debugAppendChainSubscriber }),
    ...(slackBotToken == null ? {} : { APP_CONFIG_SLACK_BOT_TOKEN: alchemy.secret(slackBotToken) }),
    ...(secretsEncryptionKey == null
      ? {}
      : { SECRETS_ENCRYPTION_KEY: alchemy.secret(secretsEncryptionKey) }),
    ...(discordPublicKey == null ? {} : { DISCORD_PUBLIC_KEY: discordPublicKey }),
    ...(discordBotToken == null
      ? {}
      : { APP_CONFIG_DISCORD_BOT_TOKEN: alchemy.secret(discordBotToken) }),
  },
  // OAuth login/refresh/logout, and JWT verification when static JWKS is not
  // configured, can still talk to auth.iterate.com from inside the Worker.
  // Without this flag, same-zone subrequests bypass Worker routes and go to
  // origin, which breaks auth-worker discovery on production iterate.com
  // hostnames.
  compatibilityFlags: ["global_fetch_strictly_public"],
  extraRouteHostnames: [
    ...(eventDocsRouteHostname ? [eventDocsRouteHostname] : []),
    ...(mcpRouteHostname ? [mcpRouteHostname] : []),
    ...projectHostnameBases.flatMap(projectRouteHostnamesForBase),
  ],
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

function routeHostnameForUrl(url: string | undefined) {
  if (!url) return undefined;
  return new URL(url).hostname;
}

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
