/**
 * Generates apps/os/wrangler.jsonc (gitignored) from the root envs.ts.
 *
 * Nobody edits or commits the output: vite.config.ts regenerates it before
 * every dev/build, deploys therefore always see a fresh one, and
 * `pnpm gen:wrangler` refreshes it by hand for ad-hoc wrangler commands.
 *
 * The top-level config is local dev (no routes, containers off so `pnpm dev`
 * never needs Docker); each deployed environment gets an env block expanded
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
}) {
  return {
    vars: {
      WORKER_SELF: input.workerName,
      ARTIFACTS_ACCOUNT_ID: input.accountId,
      ARTIFACTS_NAMESPACE: `${input.workerName}-repos`,
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
        id: input.workerBuildCacheKvId ?? "local-dev-worker-build-cache",
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
    containers: [
      {
        class_name: DO_CLASSES.SANDBOX,
        image: "./Dockerfile.sandbox",
        instance_type: "lite",
        max_instances: input.maxContainerInstances ?? 10,
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

/** The builder sidecar's worker name, derived — never spelled out in envs.ts. */
function builderWorkerName(osWorkerName: string) {
  return `${osWorkerName}-builder`;
}

const config = {
  $schema: "node_modules/wrangler/config-schema.json",
  name: "os-dev",
  main: "./src/worker.ts",
  compatibility_date: "2026-06-17",
  // nodejs_compat: @cloudflare/shell (repo git) and the dynamic worker
  // loader need Node APIs. global_fetch_strictly_public: same-zone
  // subrequests (auth worker, worker-hosted e2e fixtures through project
  // egress) must traverse Worker routes instead of going to origin.
  compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
  // No `assets` here: the vite plugin injects the client build's assets
  // config into the OUTPUT wrangler.json (dist/…) that deploys actually use.
  // SSR + API paths reach the worker because no asset file matches them.
  migrations: [{ tag: "v1", new_sqlite_classes: Object.values(DO_CLASSES) }],
  // Local dev: containers off so `pnpm dev` never requires Docker — sandbox
  // Durable Objects fail at their constructor until you opt in by flipping
  // this (deploys ignore the dev section entirely).
  dev: { enable_containers: false },
  ...workerBindings({ workerName: "os-dev", accountId: "" }),
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

const builderConfig = {
  $schema: "node_modules/wrangler/config-schema.json",
  name: "os-dev-builder",
  main: "./src/builder.ts",
  compatibility_date: "2026-06-17",
  compatibility_flags: ["nodejs_compat"],
  kv_namespaces: [{ binding: "WORKER_BUILD_CACHE", id: "local-dev-worker-build-cache" }],
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
