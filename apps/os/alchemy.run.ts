import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import alchemy from "alchemy";
import {
  Ai,
  DurableObjectNamespace,
  KVNamespace,
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
import type { AgentDurableObject } from "./src/domains/agents/agent-durable-object.ts";
import type { ItxDurableObject } from "./src/domains/itx/itx-durable-object.ts";
import type { ProjectDurableObject } from "./src/domains/projects/project-durable-object.ts";
import type { RepoDurableObject } from "./src/domains/repos/repo-durable-object.ts";
import type { SecretDurableObject } from "./src/domains/secrets/secret-durable-object.ts";
import type { StreamDurableObject } from "./src/domains/streams/stream-durable-object.ts";
import type { StatefulWorkerDurableObject } from "./src/domains/workers/stateful-worker-durable-object.ts";

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
  // Deadline, not attempt-count: preview deploys OS and auth concurrently, so
  // on a fresh slot this poll is what waits out the auth deploy (~40s). On an
  // existing slot the first fetch succeeds immediately.
  const deadline = Date.now() + 120_000;
  let attempt = 0;
  let lastError: unknown;
  while (true) {
    attempt += 1;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(4_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const jwks = (await response.json()) as { keys?: unknown[] };
      if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) {
        throw new Error("JWKS response has no keys");
      }
      return jwks as { keys: unknown[] };
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) throw lastError;
      console.warn(`[alchemy.run] JWKS fetch attempt ${attempt} failed, retrying:`, error);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
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

// ---------------------------------------------------------------------------
// Worker topology
//
// OS deploys as MANY small workers instead of one big one, so every cold
// Durable Object isolate loads only the code it runs (apps/os/docs/
// worker-topology.md). `${ctx.workerName}` (os-prd, os-preview-N,
// os-dev-<user>) is the tiny ingress router that owns all routes; the
// dashboard app, itx API worker, and each Durable Object class get
// their own worker. Durable Object classes exported from one worker are
// bound as cross-script namespaces (`scriptName`) in every worker that
// dials them.
// ---------------------------------------------------------------------------

const workerNames = {
  agent: `${ctx.workerName}-agent`,
  api: `${ctx.workerName}-api`,
  app: `${ctx.workerName}-app`,
  ingress: ctx.workerName,
  itx: `${ctx.workerName}-itx`,
  project: `${ctx.workerName}-project`,
  repo: `${ctx.workerName}-repo`,
  secret: `${ctx.workerName}-secret`,
  stream: `${ctx.workerName}-stream`,
  worker: `${ctx.workerName}-worker`,
};

// os serves project hosts at <slug>.iterate.app (prod), <slug>.localhost:<port>
// (local dev), and <slug>.iterate-preview-N.app (preview).
// The preview app shell deliberately lives on the sibling
// iterate-preview-N.com zone (`os.iterate-preview-N.com`) so project/MCP hosts
// can own the iterate-preview-N.app zone cleanly.
const projectHostnameBases = ctx.runtimeConfig.projectHostnameBases ?? [];
const mcpRouteHostname = routeHostnameForUrl(ctx.runtimeConfig.mcp?.baseUrl);
const artifactsAccountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
const artifactsNamespace = `${ctx.workerName}-repos`;

// Slug -> project id (+ small metadata records) cache in front of the auth
// worker's project directory: ingress resolves every project-host request
// through it, so positive lookups must not pay an auth-worker roundtrip
// (src/project-directory.ts).
const projectDirectory = await KVNamespace("project-directory", {
  title: `${ctx.workerName}-project-directory`,
  adopt: true,
});

// ---- Durable Object namespaces ---------------------------------------------
// One declaration per class, `scriptName` = the OWNING worker. Alchemy strips
// `script_name` (and runs class migrations) when the namespace is bound on its
// owner, and emits a cross-script binding everywhere else — so the same
// object is passed to owner and consumers alike.

const stream = DurableObjectNamespace<StreamDurableObject>("stream", {
  className: "StreamDurableObject",
  scriptName: workerNames.stream,
  sqlite: true,
});
const itx = DurableObjectNamespace<ItxDurableObject>("itx", {
  className: "ItxDurableObject",
  scriptName: workerNames.itx,
  sqlite: true,
});
const project = DurableObjectNamespace<ProjectDurableObject>("project", {
  className: "ProjectDurableObject",
  scriptName: workerNames.project,
  sqlite: true,
});
const agent = DurableObjectNamespace<AgentDurableObject>("agent", {
  className: "AgentDurableObject",
  scriptName: workerNames.agent,
  sqlite: true,
});
const repo = DurableObjectNamespace<RepoDurableObject>("repo", {
  className: "RepoDurableObject",
  scriptName: workerNames.repo,
  sqlite: true,
});
const secret = DurableObjectNamespace<SecretDurableObject>("secret", {
  className: "SecretDurableObject",
  scriptName: workerNames.secret,
  sqlite: true,
});
const statefulWorker = DurableObjectNamespace<StatefulWorkerDurableObject>("worker", {
  className: "StatefulWorkerDurableObject",
  scriptName: workerNames.worker,
  sqlite: true,
});

// ---- Fresh-stage bootstrap --------------------------------------------------
// Cloudflare rejects a cross-script DO binding whose target script does not
// exist yet (error 10061), and the itx workers reference each other — a
// legitimate cycle once everything is deployed, but unsatisfiable on the
// FIRST deploy of a fresh stage. So: bindings whose target script is missing
// are omitted this pass, and the run re-executes itself once at the end to
// wire them up. Steady-state deploys (all scripts exist) never take this
// path. Local dev resolves bindings lazily through miniflare's dev registry,
// so it never needs it either.
const durableObjectWorkerNames = [
  workerNames.agent,
  workerNames.itx,
  workerNames.project,
  workerNames.repo,
  workerNames.secret,
  workerNames.stream,
  workerNames.worker,
];
const missingScripts = ctx.app.local
  ? new Set<string>()
  : await findMissingWorkerScripts(durableObjectWorkerNames);
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

// Bindings every itx worker carries — src/env.ts is the matching
// contract. All itx workers get the full set so any of them can host any
// capability, exactly like the single-worker original itx came from.
const itxBindings = {
  AI: Ai(),
  AGENT: agent,
  ARTIFACTS: Artifacts({ namespace: artifactsNamespace }),
  ARTIFACTS_ACCOUNT_ID: artifactsAccountId,
  ARTIFACTS_NAMESPACE: artifactsNamespace,
  ITX: itx,
  LOADER: WorkerLoader(),
  PROJECT: project,
  PROJECT_DIRECTORY: projectDirectory,
  REPO: repo,
  SECRET: secret,
  SECRET_ENCRYPTION_KEY: alchemy.secret(
    process.env.SECRET_ENCRYPTION_KEY ?? "os-dev-secret-encryption-key",
  ),
  STREAM: stream,
  WORKER: statefulWorker,
};
// @cloudflare/shell (repo git) and the dynamic worker loader need Node APIs —
// itx originally ran its whole worker with nodejs_compat.
// global_fetch_strictly_public: same-zone subrequests (auth worker on previews,
// worker-hosted e2e fixtures through project egress) must traverse Worker
// routes instead of going to origin — same reason as the app worker.
const engineCompatibilityFlags = ["nodejs_compat", "global_fetch_strictly_public"];

function engineWorker(id: keyof typeof workerNames, entrypoint: string) {
  return osWorker(id, {
    entrypoint,
    compatibilityFlags: engineCompatibilityFlags,
    bindings: itxBindings,
  });
}

// The Durable Object workers deploy CONCURRENTLY: cross-script DO bindings
// are name-strings (no resource ordering), and the bootstrap filter works
// off the missing-set computed above, so ordering between them never
// matters. Only the app worker and the ingress worker (service bindings)
// order after them.
const [
  streamWorker,
  itxWorker,
  projectWorker,
  agentWorker,
  repoWorker,
  secretWorker,
  workerWorker,
  apiWorker,
] = await Promise.all([
  engineWorker("stream", "./src/workers/stream.ts"),
  engineWorker("itx", "./src/workers/itx.ts"),
  engineWorker("project", "./src/workers/project.ts"),
  engineWorker("agent", "./src/workers/agent.ts"),
  engineWorker("repo", "./src/workers/repo.ts"),
  engineWorker("secret", "./src/workers/secret.ts"),
  engineWorker("worker", "./src/workers/worker.ts"),
  engineWorker("api", "./src/workers/api.ts"),
]);

// Second bootstrap pass (fresh stages only): the cross-script Durable Object
// target workers now exist, so re-running wires the bindings omitted above.
// Do this before the dashboard app, ingress, and routes so a fresh preview
// builds/routes them once instead of once per bootstrap pass.
if (missingScripts.size > 0 && !process.env.OS_BOOTSTRAP_SECOND_PASS) {
  await ctx.app.finalize();
  await runBootstrapSecondPass();
}

// ---- The app worker (TanStack Start dashboard) -------------------------------

// Hand vite the auxiliary worker list BEFORE TanStackStart spawns it. The
// ingress worker is deliberately absent: it is created after the app worker
// (it service-binds it), and in dev the browser talks to vite directly — the
// app worker runs the same shared routing decision, so the ingress hop adds
// nothing.
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
    ITX_API: apiWorker,
    // Server-side project reads share the ingress directory cache.
    PROJECT_DIRECTORY: projectDirectory,
  },
  // OAuth login/refresh/logout, and JWT verification when static JWKS is not
  // configured, can still talk to auth.iterate.com from inside the Worker.
  // Without this flag, same-zone subrequests bypass Worker routes and go to
  // origin, which breaks auth-worker discovery on production iterate.com
  // hostnames.
  compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
  // No workers.dev URL: the app worker is reachable only through the ingress
  // worker's service binding.
  url: false,
});

// ---- The ingress router -------------------------------------------------------
// The ONLY worker with routes. Tiny on purpose: one config parse, then a
// service-binding forward (workers/ingress.ts).

const ingressWorker = await osWorker("ingress", {
  entrypoint: "./src/workers/ingress.ts",
  bindings: {
    APP: appWorker,
    ITX_API: apiWorker,
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
        ...(mcpRouteHostname ? [mcpRouteHostname] : []),
        ...projectHostnameBases.flatMap(projectRouteHostnamesForBase),
      ].filter((hostname) => !hostname.endsWith(".workers.dev")),
    ),
  ],
});

/** Per-worker Env types for src/lib/worker-env.d.ts. */
export const workers = {
  agent: agentWorker,
  api: apiWorker,
  app: appWorker,
  ingress: ingressWorker,
  itx: itxWorker,
  project: projectWorker,
  repo: repoWorker,
  secret: secretWorker,
  stream: streamWorker,
  worker: workerWorker,
};

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
