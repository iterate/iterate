/**
 * Generates apps/os/wrangler.jsonc from the root envs.ts.
 *
 *   pnpm gen:wrangler        # rewrite wrangler.jsonc
 *   pnpm gen:wrangler --check # exit 1 if the checked-in file is stale (CI)
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
 * `deploy.ts` builds its --secrets-file from exactly this list and fails
 * before deploying when the Doppler config is missing one; the vite plugin
 * loads exactly these keys from process.env in local dev.
 */
const REQUIRED_SECRETS = [
  "APP_CONFIG_ADMIN_API_SECRET",
  "APP_CONFIG_BASE_URL",
  "APP_CONFIG_CLOUDFLARE__API_TOKEN",
  "APP_CONFIG_GEMINI_API_KEY",
  "APP_CONFIG_INTEGRATIONS__GITHUB",
  "APP_CONFIG_INTEGRATIONS__GOOGLE",
  "APP_CONFIG_INTEGRATIONS__SLACK",
  "APP_CONFIG_ITERATE_AUTH__CLIENT_ID",
  "APP_CONFIG_ITERATE_AUTH__CLIENT_SECRET",
  "APP_CONFIG_ITERATE_AUTH__ISSUER",
  "APP_CONFIG_ITERATE_AUTH__SERVICE_TOKEN",
  "APP_CONFIG_LOGS",
  "APP_CONFIG_MCP__BASE_URL",
  "APP_CONFIG_OPEN_AI_API_KEY",
  "APP_CONFIG_POSTHOG",
  "APP_CONFIG_PROJECT_HOSTNAME_BASES",
  "APP_CONFIG_SLACK_BOT_TOKEN",
  "APP_CONFIG_X_AI_API_KEY",
  "SECRET_ENCRYPTION_KEY",
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
 * and the project-host patterns (`base`, `*.base` and the broad `*base` —
 * the last because the preview zone only reliably invoked the worker for
 * project hosts once the catch-all existed). The zone is the hostname minus
 * its first label for app/MCP hosts; project bases are themselves zones.
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
  return {
    name: env.osWorkerName,
    account_id: env.cloudflareAccountId,
    routes: routes(env),
    ...workerBindings({
      workerName: env.osWorkerName,
      accountId: env.cloudflareAccountId,
      kvId: env.resources.projectDirectoryKvId,
    }),
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
  env: Object.fromEntries(Object.entries(envs).map(([name, env]) => [name, envBlock(env)])),
};

const header = `// GENERATED by scripts/generate-wrangler-config.ts from the root envs.ts — do not edit.
// Regenerate: pnpm gen:wrangler   (CI fails when stale)
`;
const rendered = header + JSON.stringify(config, null, 2) + "\n";

if (process.argv.includes("--check")) {
  const current = readFileSync(CONFIG_PATH, "utf8");
  if (current !== rendered) {
    console.error("wrangler.jsonc is stale — run `pnpm gen:wrangler` and commit the result.");
    process.exit(1);
  }
  console.log("wrangler.jsonc is up to date.");
} else {
  writeFileSync(CONFIG_PATH, rendered);
  console.log(`Wrote ${CONFIG_PATH}`);
}
