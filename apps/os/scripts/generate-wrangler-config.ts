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
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { envs, type DeployedEnv } from "../../../envs.ts";

const CONFIG_PATH = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));

/**
 * Secrets every deployment needs, sourced from the env's Doppler config.
 * `deploy.ts` builds its --secrets-file from exactly this list (plus the
 * deploy-time-baked APP_CONFIG_ITERATE_AUTH__JWKS) and fails before
 * deploying when the Doppler config is missing one.
 */
export const REQUIRED_SECRETS = [
  "APP_CONFIG_ADMIN_API_SECRET",
  "APP_CONFIG_CLOUDFLARE__API_TOKEN",
  "APP_CONFIG_GEMINI_API_KEY",
  "APP_CONFIG_INTEGRATIONS__GITHUB",
  "APP_CONFIG_INTEGRATIONS__GOOGLE",
  "APP_CONFIG_INTEGRATIONS__SLACK",
  "APP_CONFIG_ITERATE_AUTH__CLIENT_ID",
  "APP_CONFIG_ITERATE_AUTH__CLIENT_SECRET",
  "APP_CONFIG_ITERATE_AUTH__SERVICE_TOKEN",
  "APP_CONFIG_LOGS",
  "APP_CONFIG_OPEN_AI_API_KEY",
  "APP_CONFIG_POSTHOG",
  "APP_CONFIG_SLACK_BOT_TOKEN",
  "APP_CONFIG_X_AI_API_KEY",
  "SECRET_ENCRYPTION_KEY",
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

const ENV_SHAPED_KEYS = [
  "APP_CONFIG_BASE_URL",
  "APP_CONFIG_MCP__BASE_URL",
  "APP_CONFIG_PROJECT_HOSTNAME_BASES",
  "APP_CONFIG_ITERATE_AUTH__ISSUER",
];

const DO_CLASSES = {
  AGENT: "AgentDurableObject",
  ITX: "ItxDurableObject",
  PROJECT: "ProjectDurableObject",
  REPO: "RepoDurableObject",
  SANDBOX: "CloudflareSandboxDurableObject",
  SECRET: "SecretDurableObject",
  STREAM: "StreamDurableObject",
  WORKER: "StatefulWorkerDurableObject",
} as const;

const OBSERVABILITY = {
  enabled: true,
  head_sampling_rate: 1,
  logs: { enabled: true, head_sampling_rate: 1, persist: true, invocation_logs: true },
  traces: { enabled: true, persist: true, head_sampling_rate: 1 },
};

/** Binding config identical across local dev and every deployed env, apart from names/ids. */
function workerBindings(input: { workerName: string; accountId: string; kvId?: string }) {
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
    ],
    ai: { binding: "AI" },
    worker_loaders: [{ binding: "LOADER" }],
    artifacts: [{ binding: "ARTIFACTS", namespace: `${input.workerName}-repos` }],
    containers: [
      {
        class_name: DO_CLASSES.SANDBOX,
        image: "./Dockerfile.sandbox",
        instance_type: "lite",
        max_instances: 10,
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
  });
  return {
    name: env.osWorkerName,
    account_id: env.cloudflareAccountId,
    routes: routes(env),
    ...bindings,
    vars: { ...bindings.vars, ...envShapedVars(env) },
  };
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
  // Local dev loads the env-shaping keys from Doppler like any other secret
  // (deployed envs get them as generated vars instead — see envShapedVars).
  secrets: { required: [...REQUIRED_SECRETS, ...ENV_SHAPED_KEYS] },
  env: Object.fromEntries(Object.entries(envs).map(([name, env]) => [name, envBlock(env)])),
};

/**
 * Write wrangler.jsonc (gitignored) if its content changed. Called by
 * vite.config.ts before the cloudflare plugin reads the file — so `vite dev`
 * and `vite build` can never see a stale config — and runnable directly via
 * `pnpm gen:wrangler` for ad-hoc wrangler commands (d1, kv, types).
 */
export function writeWranglerConfig() {
  const header = `// GENERATED by scripts/generate-wrangler-config.ts — gitignored, do not edit.
//
// This is apps/os's wrangler config, expanded from the root envs.ts (the
// typed map of every deployed environment). The top-level block is local
// dev; each "env" block below is one deployed environment, selected at
// build time via CLOUDFLARE_ENV (deploy.ts does this for you). The blocks
// repeat the same bindings because wrangler env blocks don't inherit them.
//
// Regenerate:      pnpm gen:wrangler   (vite dev/build do it automatically)
// Change an env:   edit envs.ts, not this file
// How it all fits: docs/devops-cloudflare-doppler.md, apps/os/docs/worker-topology.md
`;
  const rendered = header + JSON.stringify(config, null, 2) + "\n";
  const current = (() => {
    try {
      return readFileSync(CONFIG_PATH, "utf8");
    } catch {
      return null;
    }
  })();
  if (current !== rendered) writeFileSync(CONFIG_PATH, rendered);
  return CONFIG_PATH;
}

// Runs only when invoked directly — deploy.ts and vite.config.ts import
// from this module without triggering a write.
if (process.argv[1]?.endsWith("generate-wrangler-config.ts")) {
  console.log(`Wrote ${writeWranglerConfig()}`);
}
