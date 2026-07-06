/**
 * Generates apps/os/wrangler.jsonc (gitignored) from the root envs.ts.
 *
 * Nobody edits or commits the output: vite.config.ts regenerates it before
 * every dev/build, deploys therefore always see a fresh one, and
 * `pnpm gen:wrangler` refreshes it by hand for ad-hoc wrangler commands.
 *
 * The top-level config is local dev (no routes, containers off by default so
 * `pnpm dev` never needs Docker — opt in with OS_SANDBOX_CONTAINER_LOCAL_DEV);
 * each deployed environment gets an env block expanded
 * from its envs.ts entry. Wrangler env blocks do not inherit binding keys,
 * so the shared bindings are spelled out per env by this script — that
 * repetition is exactly why the file is generated instead of hand-written.
 *
 * Everything here is non-secret. Secret VALUES never appear: secrets ride
 * `wrangler deploy --secrets-file` (see deploy.ts), and `secrets.required`
 * below is just the list of names — which also makes the vite plugin load
 * exactly those keys from process.env under `doppler run -- vite dev`.
 */
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { envs, type DeployedEnv } from "../../../envs.ts";
import {
  OBSERVABILITY,
  writeGeneratedWranglerConfig,
} from "../../../scripts/lib/wrangler-config.ts";

/**
 * Secrets every deployment MUST have (deploy.ts fails before uploading when
 * the env's Doppler config is missing one). Keep this to what the product
 * genuinely can't run without — the zod parseConfig preflight in deploy.ts
 * is the real arbiter of shape.
 */
export const REQUIRED_SECRETS = [
  "APP_CONFIG_ADMIN_API_SECRET",
  "APP_CONFIG_ITERATE_AUTH__CLIENT_ID",
  "APP_CONFIG_ITERATE_AUTH__CLIENT_SECRET",
  "APP_CONFIG_OPEN_AI_API_KEY",
  "SECRET_ENCRYPTION_KEY",
];

/**
 * Optional-in-schema secrets: shipped when the env's Doppler config carries
 * them, silently skipped otherwise (e.g. preview slots have no Slack bot).
 * Not in the env blocks' `secrets.required` — wrangler would fail deploys
 * over them — but listed in the top-level (local dev) block so the vite
 * plugin loads whichever ones your Doppler config has.
 */
export const OPTIONAL_SECRETS = [
  "APP_CONFIG_CLOUDFLARE__API_TOKEN",
  "APP_CONFIG_GEMINI_API_KEY",
  "APP_CONFIG_INTEGRATIONS__GITHUB",
  "APP_CONFIG_INTEGRATIONS__GOOGLE",
  "APP_CONFIG_INTEGRATIONS__SLACK",
  "APP_CONFIG_ITERATE_AUTH__EMAIL_OTP_ENABLED",
  "APP_CONFIG_ITERATE_AUTH__SERVICE_TOKEN",
  "APP_CONFIG_LOGS",
  "APP_CONFIG_POSTHOG",
  "APP_CONFIG_SLACK_BOT_TOKEN",
  "APP_CONFIG_X_AI_API_KEY",
  // R2 S3-API credentials the Sandbox SDK uses to presign workspace-backup
  // transfers (exact names the SDK reads). Optional: an env without them
  // still runs sandboxes — backups fail loudly in logs and every container
  // start falls back to a fresh repo clone. Local dev never needs them
  // (SANDBOX_BACKUP_MODE=local streams through the local R2 binding).
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
];

/**
 * Env-shaping config that is NOT secret and already lives in envs.ts —
 * emitted as per-env `vars` so the worker's runtime hostnames can never
 * drift from the routes generated off the same entry. Local dev has no env
 * block, so the top-level `secrets.required` also lists these names and the
 * vite plugin loads them from the Doppler-provided process.env.
 */
export function envShapedVars(env: DeployedEnv) {
  return {
    APP_CONFIG_BASE_URL: env.baseUrl,
    APP_CONFIG_MCP__BASE_URL: env.mcpBaseUrl,
    APP_CONFIG_PROJECT_HOSTNAME_BASES: JSON.stringify(env.projectHostnameBases),
    APP_CONFIG_ITERATE_AUTH__ISSUER: `${env.authBaseUrl}/api/auth`,
  };
}

const ENV_SHAPED_KEYS = Object.keys(envShapedVars(envs.prd));

// One compatibility date for the os worker AND the builder sidecar — a bump
// that misses one would be silent drift. (Deliberately distinct from
// WORKER_COMPATIBILITY_DATE in worker-loader.ts: dynamic-worker compat is
// hashed into build keys and moves on its own schedule.)
const COMPATIBILITY_DATE = "2026-06-17";

// The os worker (reader) and the builder (writer) must name the same
// miniflare namespace in local dev or cache reads never see builds.
const LOCAL_DEV_BUILD_CACHE_ID = "local-dev-worker-build-cache";

/** The builder sidecar's worker name, derived — never spelled out in envs.ts. */
function builderWorkerName(osWorkerName: string) {
  return `${osWorkerName}-builder`;
}

const DO_CLASSES = {
  AGENT: "AgentDurableObject",
  CAPABILITY_HOST: "CapabilityHostDurableObject",
  PROJECT: "ProjectDurableObject",
  REPO: "RepoDurableObject",
  SANDBOX: "CloudflareSandboxDurableObject",
  SECRET: "SecretDurableObject",
  STREAM: "StreamDurableObject",
  WORKER: "StatefulWorkerDurableObject",
} as const;

/** Binding config identical across local dev and every deployed env, apart from names/ids. */
function workerBindings(input: {
  workerName: string;
  accountId: string;
  kvId?: string;
  workerBuildCacheKvId?: string;
  /** Sandbox container instance cap. Preview slots get extra headroom: e2e
   * churn spins sandboxes faster than they idle out, and a saturated cap
   * 503s every sandbox exec (observed live at 10/10 on preview-3). */
  maxContainerInstances?: number;
  /** Local dev (the top-level config): sandbox workspace backups stream
   * through miniflare's local R2 binding instead of presigned
   * `*.r2.cloudflarestorage.com` URLs, which don't exist under `wrangler
   * dev`. */
  localDev?: boolean;
}) {
  return {
    vars: {
      WORKER_SELF: input.workerName,
      ARTIFACTS_ACCOUNT_ID: input.accountId,
      ARTIFACTS_NAMESPACE: `${input.workerName}-repos`,
      // Sandbox workspace backup config — names the Sandbox SDK reads from
      // the env verbatim (BACKUP_BUCKET_NAME, CLOUDFLARE_R2_ACCOUNT_ID);
      // the R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY presigning secrets ride in
      // from Doppler (OPTIONAL_SECRETS).
      BACKUP_BUCKET_NAME: `${input.workerName}-sandboxes`,
      CLOUDFLARE_R2_ACCOUNT_ID: input.accountId,
      SANDBOX_BACKUP_MODE: input.localDev ? "local" : "presigned",
    },
    durable_objects: {
      bindings: Object.entries(DO_CLASSES).map(([name, class_name]) => ({ name, class_name })),
    },
    kv_namespaces: [
      {
        binding: "PROJECT_DIRECTORY",
        // Local dev has no real namespace; miniflare only needs a stable id.
        id: input.kvId ?? "local-dev-project-directory",
      },
      {
        binding: "WORKER_BUILD_CACHE",
        id: input.workerBuildCacheKvId ?? LOCAL_DEV_BUILD_CACHE_ID,
      },
    ],
    services: [
      // The builder sidecar (src/builder.ts, wrangler.builder.jsonc): the one
      // script carrying the dynamic-worker bundler toolchain (esbuild-wasm,
      // ~14MB) so the product script stays small. Bound by name — deploy.ts
      // deploys the builder first.
      { binding: "BUILDER", service: builderWorkerName(input.workerName) },
    ],
    ai: { binding: "AI" },
    worker_loaders: [{ binding: "LOADER" }],
    artifacts: [{ binding: "ARTIFACTS", namespace: `${input.workerName}-repos` }],
    // Sandbox workspace backups (ensure-resources.ts creates the bucket; the
    // sandbox DO snapshots /workspace here on idle and restores on start).
    // The binding MUST be named BACKUP_BUCKET — the Sandbox SDK reads it from
    // the env by that exact name. Addressed by name, so — unlike KV/D1 — no
    // per-env id in envs.ts. In local dev miniflare provides it automatically.
    r2_buckets: [{ binding: "BACKUP_BUCKET", bucket_name: `${input.workerName}-sandboxes` }],
    containers: [
      {
        class_name: DO_CLASSES.SANDBOX,
        image: "./Dockerfile.sandbox",
        instance_type: "lite",
        // Sized for e2e churn: the preview lanes provision a fresh project
        // (and sandbox container) per test, and idle containers hold an
        // instance slot until sleepAfter (3m, see
        // CloudflareSandboxDurableObject). 10 wedged the sandbox-exec specs
        // after ~5 back-to-back runs; lite instances bill on usage, not
        // reservation, so headroom is free.
        max_instances: input.maxContainerInstances ?? 40,
      },
    ],
    secrets: { required: REQUIRED_SECRETS },
    observability: OBSERVABILITY,
  };
}

/**
 * Every hostname routed to the os worker: the app base URL, the MCP host,
 * and the project-host patterns. The zone is the hostname minus its first
 * label for app/MCP hosts; project bases are themselves zones.
 *
 * Project bases get three patterns: `base/*`, `*.base/*`, and `*base/*`.
 * The catch-all `*base/*` should subsume the others, but the live preview
 * zone only reliably invoked the worker for project hosts once all three
 * existed (observed 2026-06) — kept verbatim; collapse only with an edge
 * experiment proving it.
 */
function routes(env: DeployedEnv) {
  const appHost = new URL(env.baseUrl).hostname;
  const mcpHost = new URL(env.mcpBaseUrl).hostname;
  const zoneOf = (host: string) => host.split(".").slice(1).join(".");
  return [
    { pattern: `${appHost}/*`, zone_name: zoneOf(appHost) },
    { pattern: `${mcpHost}/*`, zone_name: zoneOf(mcpHost) },
    ...env.projectHostnameBases.flatMap((base) => [
      { pattern: `${base}/*`, zone_name: base },
      { pattern: `*.${base}/*`, zone_name: base },
      { pattern: `*${base}/*`, zone_name: base },
    ]),
  ];
}

function envBlock(env: DeployedEnv) {
  const bindings = workerBindings({
    workerName: env.osWorkerName,
    accountId: env.cloudflareAccountId,
    kvId: env.resources.projectDirectoryKvId,
    workerBuildCacheKvId: env.resources.workerBuildCacheKvId,
    maxContainerInstances: env.osWorkerName === "os-prd" ? 10 : 20,
  });
  return {
    name: env.osWorkerName,
    account_id: env.cloudflareAccountId,
    routes: routes(env),
    ...bindings,
    vars: { ...bindings.vars, ...envShapedVars(env) },
  };
}

export const config = {
  $schema: "node_modules/wrangler/config-schema.json",
  // The top-level name is BOTH the local dev worker name and the service
  // identity: wrangler tags every `--env` deploy with `cf:service=<top-level
  // name>` + `cf:environment=<env>`, so it must be the env-less service name
  // ("os", not "os-dev") or observability queries grouped by service
  // mis-bucket every environment under a fake "dev" service.
  name: "os",
  main: "./src/worker.ts",
  compatibility_date: COMPATIBILITY_DATE,
  // nodejs_compat: @cloudflare/shell (repo git) and the dynamic worker
  // loader need Node APIs. global_fetch_strictly_public: same-zone
  // subrequests (auth worker, worker-hosted e2e fixtures through project
  // egress) must traverse Worker routes instead of going to origin.
  compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
  // No `assets` here: the vite plugin injects the client build's assets
  // config into the OUTPUT wrangler.json (dist/…) that deploys actually use.
  // SSR + API paths reach the worker because no asset file matches them.
  migrations: [{ tag: "v1", new_sqlite_classes: Object.values(DO_CLASSES) }],
  // Local dev: containers off by default so `pnpm dev` never requires Docker —
  // sandbox Durable Objects fail at their constructor until you opt in with
  // `OS_SANDBOX_CONTAINER_LOCAL_DEV=true pnpm dev`, which builds the sandbox
  // image on Docker/OrbStack and pairs each container with a proxy-everything
  // egress sidecar (see docs/sandboxes.md). Deploys ignore the dev section.
  dev: { enable_containers: process.env.OS_SANDBOX_CONTAINER_LOCAL_DEV === "true" },
  ...workerBindings({ workerName: "os", accountId: "", localDev: true }),
  // Local dev loads optional secrets and the env-shaping keys from Doppler
  // too (deployed envs get the latter as generated vars — see envShapedVars).
  secrets: { required: [...REQUIRED_SECRETS, ...OPTIONAL_SECRETS, ...ENV_SHAPED_KEYS] },
  env: Object.fromEntries(Object.entries(envs).map(([name, env]) => [name, envBlock(env)])),
};

/**
 * The builder sidecar's config. The builder is deliberately the minimum
 * possible worker around the bundler toolchain: a pure build function
 * (files in, artifact out) whose only binding is the artifact-cache KV — no
 * DOs, no routes, no secrets, no service bindings. Wrangler bundles
 * src/builder.ts directly (no vite); local dev runs it as an auxiliary
 * worker in the same workerd (vite.config.ts). Slated for deletion when
 * builds move into the sandbox container (tasks/os-sandbox-worker-builds.md).
 */
function builderEnvBlock(env: DeployedEnv) {
  return {
    name: builderWorkerName(env.osWorkerName),
    account_id: env.cloudflareAccountId,
    kv_namespaces: [{ binding: "WORKER_BUILD_CACHE", id: env.resources.workerBuildCacheKvId }],
    observability: OBSERVABILITY,
  };
}

export const builderConfig = {
  $schema: "node_modules/wrangler/config-schema.json",
  // Env-less service name — see the note on `config.name` above.
  name: "os-builder",
  main: "./src/builder.ts",
  compatibility_date: COMPATIBILITY_DATE,
  compatibility_flags: ["nodejs_compat"],
  kv_namespaces: [{ binding: "WORKER_BUILD_CACHE", id: LOCAL_DEV_BUILD_CACHE_ID }],
  observability: OBSERVABILITY,
  env: Object.fromEntries(Object.entries(envs).map(([name, env]) => [name, builderEnvBlock(env)])),
};

/** Write wrangler.jsonc (gitignored) if changed — see writeGeneratedWranglerConfig. */
export const writeWranglerConfig = () => {
  writeGeneratedWranglerConfig({
    configUrl: new URL("../wrangler.builder.jsonc", import.meta.url),
    appLabel: "apps/os (builder sidecar)",
    config: builderConfig,
  });
  return writeGeneratedWranglerConfig({
    configUrl: new URL("../wrangler.jsonc", import.meta.url),
    appLabel: "apps/os",
    extraDocs: "apps/os/docs/worker-topology.md",
    config,
  });
};

/** Regenerate apps/os/wrangler{,.builder}.jsonc from the root envs.ts. */
export default function generateWranglerConfig() {
  console.log(`Wrote ${writeWranglerConfig()}`);
}

// The CLI runs only when invoked directly — deploy.ts and vite.config.ts
// import from this module without triggering a write.
if (process.argv[1]?.endsWith("generate-wrangler-config.ts")) {
  void createCli({ ...import.meta, name: "generate-wrangler-config" }).run({
    logger: yamlTableConsoleLogger,
    prompts: isAgent() ? undefined : createBuiltInPrompts(),
  });
}
