import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import alchemy from "alchemy";
import {
  Ai,
  D1Database,
  DurableObjectNamespace,
  Queue,
  R2Bucket,
  Worker,
  WorkerLoader,
  WranglerJson,
  createCloudflareApi,
} from "alchemy/cloudflare";
import type { Bindings, WorkerProps } from "alchemy/cloudflare";
import { Artifacts } from "@iterate-com/shared/alchemy/artifacts";
import { initAlchemy } from "@iterate-com/shared/alchemy/init";
import {
  ITERATE_WORKER_OBSERVABILITY,
  IterateAppWorker,
  IterateRoutes,
} from "@iterate-com/shared/alchemy/iterate-app";
import { prepareLocalDevServer } from "@iterate-com/shared/alchemy/local-dev-server";
import { ensureLocalDevOAuthClient } from "./src/auth/dev-oauth-client-bootstrap.ts";
import { AppConfig } from "./src/config.ts";
import type { ItxDurableObject } from "./src/itx/itx-durable-object.ts";
import type { ProjectDurableObject } from "./src/domains/projects/durable-objects/project-durable-object.ts";
import type { AgentDurableObject } from "./src/domains/agents/durable-objects/agent-durable-object.ts";
import type { RepoDurableObject } from "./src/domains/repos/durable-objects/repo-durable-object.ts";
import type { SlackAgentDurableObject } from "./src/domains/slack/durable-objects/slack-agent-durable-object.ts";
import type { SlackIntegrationDurableObject } from "./src/domains/slack/durable-objects/slack-integration-durable-object.ts";
import type { WorkspaceDurableObject } from "./src/domains/workspaces/durable-objects/workspace-durable-object.ts";
import { eventDocsHostnameForAppBaseUrl } from "./src/lib/event-docs-host.ts";
import type { AgentDurableObject as NextAgentDurableObject } from "./src/next/domains/agents/agent-durable-object.ts";
import type { ItxDurableObject as NextItxDurableObject } from "./src/next/domains/itx/itx-durable-object.ts";
import type { ProjectDurableObject as NextProjectDurableObject } from "./src/next/domains/projects/project-durable-object.ts";
import type { RepoDurableObject as NextRepoDurableObject } from "./src/next/domains/repos/repo-durable-object.ts";
import type { SecretDurableObject as NextSecretDurableObject } from "./src/next/domains/secrets/secret-durable-object.ts";
import type { StreamDurableObject as NextStreamDurableObject } from "./src/next/domains/streams/stream-durable-object.ts";
import type { StatefulWorkerDurableObject as NextStatefulWorkerDurableObject } from "./src/next/domains/workers/stateful-worker-durable-object.ts";
import type { Stream } from "~/domains/streams/engine/workers/durable-objects/stream.ts";

const resolvedAuthIssuer =
  process.env.APP_CONFIG_ITERATE_AUTH__ISSUER ?? process.env.ITERATE_OAUTH_ISSUER;

// A static JWKS lets the worker verify auth JWTs without any runtime
// roundtrip to the auth worker, including on cold isolate starts. Fetch it
// from the issuer at deploy time; an explicit env value overrides. A static
// JWKS only verifies tokens from the issuer it was exported from, so a
// loopback issuer (local dev auth server with its own keys) never uses a
// Doppler-provided production JWKS. Key rotation in auth requires an OS
// redeploy. On fetch failure the worker falls back to remote JWKS at runtime.
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
    // Retried: this one fetch decides the whole deploy on forge-enabled
    // envs, and the auth worker may be cold (slot auths are hand-deployed) —
    // a single timeout aborted a preview deploy on 2026-06-12.
    const jwks = await fetchJwksWithRetry(`${issuer.replace(/\/+$/, "")}/jwks`);
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

// Identity forging: when the Doppler config carries the forge private JWK
// (`AUTH_FORGE_PRIVATE_JWK`, from `_shared/dev` / `_shared/preview`, and `os/prd`),
// its PUBLIC half joins the worker's trusted JWKS so minted JWTs
// (scripts/auth/mint-session.ts) verify exactly like issuer-signed ones.
//
// The forge key is a master key: whoever holds it can mint a session as any
// user, including admins. In dev/preview that's the whole point. In PRODUCTION
// it is also allowed (you can `pnpm auth:mint` against os.iterate.com to poke
// around as any user) but is gated behind an explicit opt-in so a forge key
// that *accidentally* lands in a prod config still fails the deploy loudly
// instead of silently arming god-mode. Enabling prod minting takes two
// deliberate Doppler values in `os/prd`: AUTH_FORGE_PRIVATE_JWK *and*
// AUTH_FORGE_ALLOW_PRODUCTION=true. (TODO: replace with an audited mint
// endpoint on the auth worker — see docs/dev-environments.md.)
function withForgePublicKey(jwksJson: string) {
  const forgePrivateJwk = process.env.AUTH_FORGE_PRIVATE_JWK?.trim();
  if (!forgePrivateJwk) return jwksJson;
  // Detect a production-serving deploy two independent ways — stage name AND
  // issuer identity — so a prod deploy under a non-"prd" stage (hotfix stage,
  // custom hostname) is still caught by the issuer check.
  const isProdStage = process.env.ALCHEMY_STAGE?.trim() === "prd";
  const isProdIssuer = (resolvedAuthIssuer ?? "").includes("auth.iterate.com");
  const allowProduction = /^(1|true|yes)$/i.test(
    process.env.AUTH_FORGE_ALLOW_PRODUCTION?.trim() ?? "",
  );
  if ((isProdStage || isProdIssuer) && !allowProduction) {
    throw new Error(
      "AUTH_FORGE_PRIVATE_JWK is present in a production config " +
        `(stage=${process.env.ALCHEMY_STAGE}, issuer=${resolvedAuthIssuer}) without ` +
        "AUTH_FORGE_ALLOW_PRODUCTION=true. Set that flag in the same config to deliberately " +
        "enable production minting, or remove the forge key if it landed there by accident.",
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
  APP_CONFIG_ITERATE_AUTH__EMAIL_OTP_ENABLED:
    process.env.APP_CONFIG_ITERATE_AUTH__EMAIL_OTP_ENABLED ??
    process.env.VITE_ENABLE_EMAIL_OTP_SIGNIN ??
    (process.env.ALCHEMY_STAGE?.startsWith("dev") ? "true" : undefined),
  APP_CONFIG_ITERATE_AUTH__JWKS: await resolveStaticAuthJwks(resolvedAuthIssuer),
  APP_CONFIG_ITERATE_AUTH__SERVICE_TOKEN:
    process.env.APP_CONFIG_ITERATE_AUTH__SERVICE_TOKEN ?? process.env.ITERATE_AUTH_SERVICE_TOKEN,
};

// Fully-local dev: no Cloudflare resources. Picks a free port and writes
// .alchemy/dev-server.json so CLIs can find the running server. If Doppler
// provides APP_CONFIG.baseUrl (for example a captun URL), runtime config keeps
// that public URL and the discovery file remains the local target.
const localDevServer = await prepareLocalDevServer(env);
if (localDevServer && !env.APP_CONFIG_PROJECT_HOSTNAME_BASES) {
  // Project hosts resolve as <proj-slug>.localhost:<port> in browsers. The app
  // base URL stays plain localhost so curl/Node clients work without local DNS.
  env.APP_CONFIG_PROJECT_HOSTNAME_BASES = JSON.stringify(["localhost"]);
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

// ---------------------------------------------------------------------------
// Worker topology
//
// OS deploys as MANY small workers instead of one big one, so every cold
// Durable Object isolate loads only the code it runs (apps/os/docs/
// worker-topology.md). `${ctx.workerName}` (os-prd, os-preview-N,
// os-dev-<user>) is the tiny ingress router that owns all routes; the
// dashboard app and each Durable Object class get their own worker. Durable
// Object classes exported from one worker are bound as cross-script
// namespaces (`scriptName`) in every worker that dials them.
// ---------------------------------------------------------------------------

const workerNames = {
  agent: `${ctx.workerName}-agent`,
  app: `${ctx.workerName}-app`,
  ingress: ctx.workerName,
  itx: `${ctx.workerName}-itx`,
  project: `${ctx.workerName}-project`,
  repo: `${ctx.workerName}-repo`,
  slackAgent: `${ctx.workerName}-slack-agent`,
  slackIntegration: `${ctx.workerName}-slack-integration`,
  stream: `${ctx.workerName}-stream`,
  workspace: `${ctx.workerName}-workspace`,
  // Next-engine workers (coexistence): the itx-v4 engine deploys alongside the
  // legacy stack under -next-* names; at cutover the stage is destroyed and
  // redeployed with the canonical roster.
  nextAgent: `${ctx.workerName}-next-agent`,
  nextApi: `${ctx.workerName}-next-api`,
  nextItx: `${ctx.workerName}-next-itx`,
  nextProject: `${ctx.workerName}-next-project`,
  nextRepo: `${ctx.workerName}-next-repo`,
  nextSecret: `${ctx.workerName}-next-secret`,
  nextStream: `${ctx.workerName}-next-stream`,
  nextWorker: `${ctx.workerName}-next-worker`,
};

const db = await D1Database("os-db", {
  name: `${ctx.workerName}-db`,
  migrationsDir: "./src/db/migrations",
  adopt: true,
});

// os serves project hosts at <slug>.iterate.app (prod), <slug>.localhost:<port>
// (local dev), and <slug>.iterate-preview-N.app (preview).
// The preview app shell deliberately lives on the sibling
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

// ---- Durable Object namespaces ---------------------------------------------
// One declaration per class, `scriptName` = the OWNING worker. Alchemy strips
// `script_name` (and runs class migrations) when the namespace is bound on its
// owner, and emits a cross-script binding everywhere else — so the same
// object is passed to owner and consumers alike.

const stream = DurableObjectNamespace<Stream>("stream", {
  className: "StreamDurableObject",
  scriptName: workerNames.stream,
  sqlite: true,
});
// itx generic context hosts: one instance per extended context, addressed
// by its journal coordinate (src/itx/journal.ts).
const itxContext = DurableObjectNamespace<ItxDurableObject>("itx-context", {
  className: "ItxDurableObject",
  scriptName: workerNames.itx,
  sqlite: true,
});
const project = DurableObjectNamespace<ProjectDurableObject>("project", {
  className: "ProjectDurableObject",
  scriptName: workerNames.project,
  sqlite: true,
});
const repo = DurableObjectNamespace<RepoDurableObject>("repo", {
  className: "RepoDurableObject",
  scriptName: workerNames.repo,
  sqlite: true,
});
const workspace = DurableObjectNamespace<WorkspaceDurableObject>("workspace", {
  className: "WorkspaceDurableObject",
  scriptName: workerNames.workspace,
  sqlite: true,
});
const agent = DurableObjectNamespace<AgentDurableObject>("agent", {
  className: "AgentDurableObject",
  scriptName: workerNames.agent,
  sqlite: true,
});
const slackIntegration = DurableObjectNamespace<SlackIntegrationDurableObject>(
  "slack-integration",
  {
    className: "SlackIntegrationDurableObject",
    scriptName: workerNames.slackIntegration,
    sqlite: true,
  },
);
const slackAgent = DurableObjectNamespace<SlackAgentDurableObject>("slack-agent", {
  className: "SlackAgentDurableObject",
  scriptName: workerNames.slackAgent,
  sqlite: true,
});

// ---- Next-engine Durable Object namespaces (coexistence) ---------------------
// Same declaration pattern as above; class names intentionally match the
// legacy classes where they collide (StreamDurableObject etc.) — namespaces
// are keyed by (scriptName, className), and the scripts differ.
const nextStream = DurableObjectNamespace<NextStreamDurableObject>("next-stream", {
  className: "StreamDurableObject",
  scriptName: workerNames.nextStream,
  sqlite: true,
});
const nextItx = DurableObjectNamespace<NextItxDurableObject>("next-itx", {
  className: "ItxDurableObject",
  scriptName: workerNames.nextItx,
  sqlite: true,
});
const nextProject = DurableObjectNamespace<NextProjectDurableObject>("next-project", {
  className: "ProjectDurableObject",
  scriptName: workerNames.nextProject,
  sqlite: true,
});
const nextAgent = DurableObjectNamespace<NextAgentDurableObject>("next-agent", {
  className: "AgentDurableObject",
  scriptName: workerNames.nextAgent,
  sqlite: true,
});
const nextRepo = DurableObjectNamespace<NextRepoDurableObject>("next-repo", {
  className: "RepoDurableObject",
  scriptName: workerNames.nextRepo,
  sqlite: true,
});
const nextSecret = DurableObjectNamespace<NextSecretDurableObject>("next-secret", {
  className: "SecretDurableObject",
  scriptName: workerNames.nextSecret,
  sqlite: true,
});
const nextWorker = DurableObjectNamespace<NextStatefulWorkerDurableObject>("next-worker", {
  className: "StatefulWorkerDurableObject",
  scriptName: workerNames.nextWorker,
  sqlite: true,
});

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

// ---- Fresh-stage bootstrap --------------------------------------------------
// Cloudflare rejects a cross-script DO binding whose target script does not
// exist yet (error 10061), and the stream worker and its subscriber workers
// reference each other — a legitimate cycle once everything is deployed, but
// unsatisfiable on the FIRST deploy of a fresh stage. So: bindings whose
// target script is missing are omitted this pass, and the run re-executes
// itself once at the end to wire them up. Steady-state deploys (all scripts
// exist) never take this path. Local dev resolves bindings lazily through
// miniflare's dev registry, so it never needs it either.
const missingScripts = ctx.app.local
  ? new Set<string>()
  : await findMissingWorkerScripts(
      // Only cross-script Durable Object target workers need bootstrap
      // probing. app/ingress are service-bound downstream workers, and
      // debugSubscriber is local-only; counting any of them here makes a fresh
      // stage do app/route work in a throwaway first pass.
      Object.entries(workerNames)
        .filter(
          ([id]) =>
            id !== "app" && id !== "debugSubscriber" && id !== "ingress" && id !== "nextApi",
        )
        .map(([, name]) => name),
    );
if (missingScripts.size > 0) {
  console.warn(
    `[alchemy.run] Bootstrap: ${[...missingScripts].join(", ")} not deployed yet — ` +
      `cross-script bindings to them are omitted this pass and wired by a second pass.`,
  );
}

function withoutBindingsToMissingScripts<B extends Bindings>(owner: string, bindings: B): B {
  if (missingScripts.size === 0) return bindings;
  return Object.fromEntries(
    Object.entries(bindings).filter(([name, value]) => {
      const scriptName = (value as { scriptName?: string } | null | undefined)?.scriptName;
      if (!scriptName || scriptName === owner || !missingScripts.has(scriptName)) return true;
      console.warn(`[alchemy.run]   ${owner}: omitting ${name} -> ${scriptName}`);
      return false;
    }),
  ) as B;
}

// ---- The workers -------------------------------------------------------------

// Local dev hosts EVERY worker inside vite's single workerd as auxiliary
// workers (@cloudflare/vite-plugin `auxiliaryWorkers`): osWorker writes a
// wrangler config per worker, the manifest below hands the list to
// vite.config.ts, and the Worker resources skip alchemy's own miniflare via
// `dev.url`. One workerd means cross-script DO bindings resolve in-process —
// the wrangler dev-registry proxy dials remote objects by hex id, which
// loses `ctx.id.name`, and Stream/itx DOs derive their identity from it.
const LOCAL_AUX_WORKERS_MANIFEST = ".alchemy/local/aux-workers.json";
const localAuxWorkerConfigPaths: string[] = [];

/** A small non-app OS worker: esbuild-bundled, no routes, no workers.dev URL,
 * standard observability, APP_CONFIG injected. */
async function osWorker<B extends Bindings>(
  id: keyof typeof workerNames,
  props: {
    bindings: B;
    compatibilityFlags?: string[];
    entrypoint: string;
    eventSources?: WorkerProps["eventSources"];
  },
) {
  const name = workerNames[id];
  const eventSources = ctx.app.local ? props.eventSources : undefined;
  const worker = await Worker(id, {
    name,
    adopt: true,
    entrypoint: props.entrypoint,
    bundle: { minify: true },
    compatibilityFlags: props.compatibilityFlags,
    eventSources,
    bindings: {
      ...withoutBindingsToMissingScripts(name, props.bindings),
      APP_CONFIG: ctx.app.local
        ? JSON.stringify(ctx.rawRuntimeConfig, null, 2)
        : alchemy.secret(JSON.stringify(ctx.rawRuntimeConfig, null, 2)),
    },
    observability: ITERATE_WORKER_OBSERVABILITY,
    url: false,
    // Local: vite hosts this worker (see LOCAL_AUX_WORKERS_MANIFEST); a dev
    // url makes alchemy skip starting it in its own miniflare.
    ...(ctx.app.local ? { dev: { url: ctx.runtimeConfig.baseUrl ?? "http://localhost:0" } } : {}),
  });
  if (ctx.app.local) {
    const configPath = `.alchemy/local/workers/${name}.wrangler.jsonc`;
    await WranglerJson({ worker, path: configPath, secrets: true });
    localAuxWorkerConfigPaths.push(configPath);
  }
  return worker;
}

// Bindings needed by the loopback capability surface (workers/shared/
// loopback-exports.ts) — every itx-hosting worker (project, agent, itx, app)
// carries these so any capability can be provided on any context.
const loopbackUnionBindings = {
  AI: Ai(),
  AGENT: agent,
  DB: db,
  DO_CATALOG: db,
  ITX_BUILD_CACHE: itxBuildCache,
  ITX_CONTEXT: itxContext,
  LOADER: WorkerLoader(),
  PROJECT: project,
  REPO: repo,
  STREAM: stream,
  WORKSPACE: workspace,
  ...(slackBotToken == null ? {} : { APP_CONFIG_SLACK_BOT_TOKEN: alchemy.secret(slackBotToken) }),
};

// Bindings every next-engine worker carries — mirrors the minimal-itx-v4
// single-worker env (src/next/env.ts is the matching contract). All next
// workers get the full set so any of them can host any next capability,
// exactly like the single-worker original.
const nextEngineBindings = {
  AI: Ai(),
  AGENT: nextAgent,
  ARTIFACTS: Artifacts({ namespace: artifactsNamespace }),
  ARTIFACTS_ACCOUNT_ID: artifactsAccountId,
  ARTIFACTS_NAMESPACE: artifactsNamespace,
  ITX: nextItx,
  LOADER: WorkerLoader(),
  PROJECT: nextProject,
  REPO: nextRepo,
  SECRET: nextSecret,
  SECRET_ENCRYPTION_KEY: alchemy.secret(
    process.env.SECRET_ENCRYPTION_KEY ?? "os-next-dev-secret-encryption-key",
  ),
  STREAM: nextStream,
  WORKER: nextWorker,
};
// @cloudflare/shell (repo git) and the dynamic worker loader need Node APIs —
// the minimal-itx-v4 original ran its whole worker with nodejs_compat.
const nextEngineCompatibilityFlags = ["nodejs_compat"];

function nextEngineWorker(id: keyof typeof workerNames, entrypoint: string) {
  return osWorker(id, {
    entrypoint,
    compatibilityFlags: nextEngineCompatibilityFlags,
    bindings: nextEngineBindings,
  });
}

// The Durable Object workers deploy CONCURRENTLY: cross-script DO bindings
// are name-strings (no resource ordering), and the bootstrap filter works
// off the missing-set computed above, so ordering between them never
// matters. Only the app worker (service-binds project for local dev) and the
// ingress worker (service-binds the app) order after them.
const [
  workspaceWorker,
  slackAgentWorker,
  repoWorker,
  itxWorker,
  agentWorker,
  slackIntegrationWorker,
  projectWorker,
  streamWorker,
  nextStreamWorker,
  nextItxWorker,
  nextProjectWorker,
  nextAgentWorker,
  nextRepoWorker,
  nextSecretWorker,
  nextWorkerWorker,
  nextApiWorker,
] = await Promise.all([
  osWorker("workspace", {
    entrypoint: "./src/workers/workspace.ts",
    // @cloudflare/shell needs Node APIs.
    compatibilityFlags: ["nodejs_compat"],
    bindings: { DO_CATALOG: db, STREAM: stream, WORKSPACE: workspace },
  }),
  osWorker("slackAgent", {
    entrypoint: "./src/workers/slack-agent.ts",
    bindings: {
      AGENT: agent,
      DB: db,
      DO_CATALOG: db,
      SLACK_AGENT: slackAgent,
      STREAM: stream,
      ...(slackBotToken == null
        ? {}
        : { APP_CONFIG_SLACK_BOT_TOKEN: alchemy.secret(slackBotToken) }),
    },
  }),
  osWorker("repo", {
    entrypoint: "./src/workers/repo.ts",
    // isomorphic-git + @cloudflare/shell need Node APIs.
    compatibilityFlags: ["nodejs_compat"],
    eventSources: [artifactEventsQueue],
    bindings: {
      // The artifacts binding type only exists on deployed workers (the local
      // dev pipeline has no Cloudflare Artifacts emulation); repo code
      // feature-checks env.ARTIFACTS, same as before the worker split.
      ...(ctx.app.local ? {} : { ARTIFACTS: Artifacts({ namespace: artifactsNamespace }) }),
      ARTIFACTS_ACCOUNT_ID: artifactsAccountId,
      ARTIFACTS_NAMESPACE: artifactsNamespace,
      DO_CATALOG: db,
      GLOBAL_STREAM_NAMESPACE: globalStreamNamespace,
      REPO: repo,
      STREAM: stream,
    },
  }),
  osWorker("itx", {
    entrypoint: "./src/workers/itx.ts",
    // Own-zone fetches (EgressPipe dialing project hosts) must go
    // through Worker routes, not origin — same reason as the app worker.
    compatibilityFlags: ["global_fetch_strictly_public"],
    bindings: loopbackUnionBindings,
  }),
  osWorker("agent", {
    entrypoint: "./src/workers/agent.ts",
    // Own-zone fetches must route through Worker routes, same as app/project/itx hosts.
    compatibilityFlags: ["global_fetch_strictly_public"],
    bindings: loopbackUnionBindings,
  }),
  osWorker("slackIntegration", {
    entrypoint: "./src/workers/slack-integration.ts",
    bindings: {
      AGENT: agent,
      DB: db,
      DO_CATALOG: db,
      SLACK_AGENT: slackAgent,
      SLACK_INTEGRATION: slackIntegration,
      STREAM: stream,
      ...(slackBotToken == null
        ? {}
        : { APP_CONFIG_SLACK_BOT_TOKEN: alchemy.secret(slackBotToken) }),
    },
  }),
  osWorker("project", {
    entrypoint: "./src/workers/project.ts",
    // nodejs_als for evlog's AsyncLocalStorage — full nodejs_compat not needed.
    compatibilityFlags: ["nodejs_als", "global_fetch_strictly_public"],
    bindings: loopbackUnionBindings,
  }),
  osWorker("stream", {
    entrypoint: "./src/workers/stream.ts",
    bindings: {
      AGENT: agent,
      // Context streams dial their ItxDurableObject subscriber through this
      // binding (itx/coordinates.ts createContext).
      ITX_CONTEXT: itxContext,
      PROJECT: project,
      REPO: repo,
      SLACK_AGENT: slackAgent,
      SLACK_INTEGRATION: slackIntegration,
      STREAM: stream,
    },
  }),
  nextEngineWorker("nextStream", "./src/next/workers/stream.ts"),
  nextEngineWorker("nextItx", "./src/next/workers/itx.ts"),
  nextEngineWorker("nextProject", "./src/next/workers/project.ts"),
  nextEngineWorker("nextAgent", "./src/next/workers/agent.ts"),
  nextEngineWorker("nextRepo", "./src/next/workers/repo.ts"),
  nextEngineWorker("nextSecret", "./src/next/workers/secret.ts"),
  nextEngineWorker("nextWorker", "./src/next/workers/worker.ts"),
  nextEngineWorker("nextApi", "./src/next/workers/api.ts"),
]);
// Referenced for completeness; only nextApiWorker is service-bound below.
void [
  nextStreamWorker,
  nextItxWorker,
  nextProjectWorker,
  nextAgentWorker,
  nextRepoWorker,
  nextSecretWorker,
  nextWorkerWorker,
];

const artifactEventsQueueConsumerReady = ctx.app.local
  ? Promise.resolve()
  : (async () => {
      const cloudflareApi = await createCloudflareApi({});
      await waitForCloudflareWorkerScript({ cloudflareApi, workerName: workerNames.repo });
      await ensureCloudflareQueueConsumer({
        cloudflareApi,
        queueId: artifactEventsQueue.id,
        scriptName: workerNames.repo,
      });
    })();
void artifactEventsQueueConsumerReady.catch(() => {});

// Second bootstrap pass (fresh stages only): the cross-script Durable Object
// target workers now exist, so re-running wires the bindings omitted above.
// Do this before the dashboard app, ingress, and routes so a fresh preview
// builds/routes them once instead of once per bootstrap pass.
if (missingScripts.size > 0 && !process.env.OS_BOOTSTRAP_SECOND_PASS) {
  await artifactEventsQueueConsumerReady;
  await ctx.app.finalize();
  await runBootstrapSecondPass();
}

// ---- The app worker (TanStack Start dashboard) -------------------------------

// Hand vite the auxiliary worker list BEFORE TanStackStart spawns it. The
// ingress worker is deliberately absent: it is created after the app worker
// (it service-binds it), and in dev the browser talks to vite directly — the
// app worker runs the same shared router, so the ingress hop adds nothing.
if (ctx.app.local) {
  await mkdir(new URL("./.alchemy/local", import.meta.url), { recursive: true });
  await writeFile(
    new URL(`./${LOCAL_AUX_WORKERS_MANIFEST}`, import.meta.url),
    `${JSON.stringify(localAuxWorkerConfigPaths, null, 2)}\n`,
  );
}

const appWorker = await IterateAppWorker(ctx, {
  // `${ctx.workerName}` itself is the ingress router (it owns the routes);
  // the dashboard app deploys under its own name.
  name: workerNames.app,
  main: "./src/workers/app.ts",
  bindings: {
    ...loopbackUnionBindings,
    // The artifacts debug route (admin-gated base-repo seeding) lives on the
    // app worker; everything else artifacts-related is the repo worker's.
    ARTIFACTS: Artifacts({ namespace: artifactsNamespace }),
    ARTIFACTS_ACCOUNT_ID: artifactsAccountId,
    ARTIFACTS_NAMESPACE: artifactsNamespace,
    GLOBAL_STREAM_NAMESPACE: globalStreamNamespace,
    NEXT_API: nextApiWorker,
    PROJECT_HOST: projectWorker,
    SLACK_AGENT: slackAgent,
    SLACK_INTEGRATION: slackIntegration,
  },
  // OAuth login/refresh/logout, and JWT verification when static JWKS is not
  // configured, can still talk to auth.iterate.com from inside the Worker.
  // Without this flag, same-zone subrequests bypass Worker routes and go to
  // origin, which breaks auth-worker discovery on production iterate.com
  // hostnames.
  compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
  // No workers.dev URL: the app worker is reachable only through the ingress
  // worker's service binding, which is what makes the internal routing
  // headers (workers/shared/router.ts) trustworthy.
  url: false,
});

// ---- The ingress router -------------------------------------------------------
// The ONLY worker with routes. Tiny on purpose: one config parse, at most one
// D1 lookup, then a service-binding forward (workers/ingress.ts).

const ingressWorker = await osWorker("ingress", {
  entrypoint: "./src/workers/ingress.ts",
  bindings: {
    APP: appWorker,
    DB: db,
    NEXT_API: nextApiWorker,
    PROJECT_HOST: projectWorker,
  },
});

const baseUrlHostname = ctx.runtimeConfig.baseUrl
  ? new URL(ctx.runtimeConfig.baseUrl).hostname
  : undefined;
await IterateRoutes(ctx, {
  worker: ingressWorker,
  hostnames: [
    ...new Set(
      [
        ...(baseUrlHostname ? [baseUrlHostname] : []),
        ...(eventDocsRouteHostname ? [eventDocsRouteHostname] : []),
        ...(mcpRouteHostname ? [mcpRouteHostname] : []),
        ...projectHostnameBases.flatMap(projectRouteHostnamesForBase),
      ].filter((hostname) => !hostname.endsWith(".workers.dev")),
    ),
  ],
});

/** Per-worker Env types for src/lib/worker-env.d.ts. */
export const workers = {
  agent: agentWorker,
  app: appWorker,
  ingress: ingressWorker,
  itx: itxWorker,
  project: projectWorker,
  repo: repoWorker,
  slackAgent: slackAgentWorker,
  slackIntegration: slackIntegrationWorker,
  stream: streamWorker,
  workspace: workspaceWorker,
};

await artifactEventsQueueConsumerReady;
await ctx.app.finalize();

if (!ctx.app.local) process.exit(0);

/**
 * Convert OS project-host bases into Cloudflare route host patterns.
 *
 * Normal bases use dotted project subdomains (`<slug>.<base>`). OS preview
 * project bases are normal bases too: `<slug>.iterate-preview-N.app`.
 */
function projectRouteHostnamesForBase(base: string) {
  // Cloudflare accepts `*.base`, but the live preview zone only invoked the
  // worker for project hosts after the broader catch-all `*base` route existed.
  return [base, `*.${base}`, `*${base}`];
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

function runBootstrapSecondPass(): never {
  console.warn("[alchemy.run] Bootstrap: re-running to wire deferred cross-script bindings…");
  const result = spawnSync("pnpm", ["exec", "tsx", fileURLToPath(import.meta.url)], {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    env: { ...process.env, OS_BOOTSTRAP_SECOND_PASS: "1" },
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

/** Which of the given worker scripts do not exist on the account yet. */
async function findMissingWorkerScripts(names: string[]) {
  const api = await createCloudflareApi({});
  const missing = new Set<string>();
  await Promise.all(
    names.map(async (name) => {
      const response = await api.get(
        `/accounts/${api.accountId}/workers/scripts/${encodeURIComponent(name)}/settings`,
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
  cloudflareApi: Awaited<ReturnType<typeof createCloudflareApi>>;
  workerName: string;
}) {
  const deadline = Date.now() + 120_000;
  let visibleChecks = 0;
  let lastStatus = 0;
  let lastBody = "";

  while (Date.now() < deadline) {
    const response = await input.cloudflareApi.get(
      `/accounts/${input.cloudflareApi.accountId}/workers/scripts/${encodeURIComponent(input.workerName)}`,
    );

    if (response.ok) {
      visibleChecks += 1;
      if (visibleChecks >= 2) return;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      continue;
    }

    lastStatus = response.status;
    lastBody = await response.text();

    if (response.status !== 404) {
      throw new Error(
        `Failed to check worker script ${input.workerName}: ${response.status} ${lastBody}`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(
    `Worker script ${input.workerName} was not visible before queue consumer creation. Last status: ${lastStatus}. Last body: ${lastBody}`,
  );
}

async function ensureCloudflareQueueConsumer(input: {
  cloudflareApi: Awaited<ReturnType<typeof createCloudflareApi>>;
  queueId: string;
  scriptName: string;
}) {
  const deadline = Date.now() + 120_000;
  let lastError = "";

  while (Date.now() < deadline) {
    const existing = await findCloudflareQueueConsumer(input);
    if (existing) {
      const updated = await updateCloudflareQueueConsumer({ ...input, consumerId: existing.id });
      if (updated) return;
      lastError = `consumer ${existing.id} disappeared before it could be updated`;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      continue;
    }

    const response = await input.cloudflareApi.post(
      `/accounts/${input.cloudflareApi.accountId}/queues/${input.queueId}/consumers`,
      { script_name: input.scriptName, type: "worker" },
    );

    if (response.ok) return;

    const body = await response.text();
    lastError = `${response.status} ${body}`;

    if (response.status !== 400 || !body.includes("already has a consumer")) {
      throw new Error(
        `Failed to create queue consumer for ${input.queueId}: ${response.status} ${body}`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  throw new Error(
    `Queue consumer for ${input.queueId} was not configurable before timeout. Last error: ${lastError}`,
  );
}

async function updateCloudflareQueueConsumer(input: {
  cloudflareApi: Awaited<ReturnType<typeof createCloudflareApi>>;
  queueId: string;
  consumerId: string;
  scriptName: string;
}) {
  const response = await input.cloudflareApi.put(
    `/accounts/${input.cloudflareApi.accountId}/queues/${input.queueId}/consumers/${input.consumerId}`,
    { script_name: input.scriptName, type: "worker" },
  );

  if (response.ok) return true;
  if (response.status === 404) return false;

  throw new Error(
    `Failed to update queue consumer ${input.consumerId}: ${response.status} ${await response.text()}`,
  );
}

async function findCloudflareQueueConsumer(input: {
  cloudflareApi: Awaited<ReturnType<typeof createCloudflareApi>>;
  queueId: string;
}) {
  const response = await input.cloudflareApi.get(
    `/accounts/${input.cloudflareApi.accountId}/queues/${input.queueId}/consumers`,
  );

  if (!response.ok) {
    throw new Error(
      `Failed to list queue consumers for ${input.queueId}: ${response.status} ${await response.text()}`,
    );
  }

  const data = (await response.json()) as {
    result?: Array<{ consumer_id?: string; id?: string }>;
  };
  const consumer = data.result?.find((candidate) => candidate.consumer_id ?? candidate.id);
  const id = consumer?.consumer_id ?? consumer?.id;
  return id ? { id } : undefined;
}
