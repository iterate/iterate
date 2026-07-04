/**
 * Generates apps/semaphore/wrangler.jsonc (gitignored) from the root envs.ts.
 *
 * Nobody edits or commits the output: vite.config.ts regenerates it before
 * every dev/build, deploys therefore always see a fresh one, and
 * `pnpm gen:wrangler` refreshes it by hand for ad-hoc wrangler commands.
 *
 * The top-level config is local dev (no routes, a placeholder D1 id for
 * miniflare); each deployed environment gets an env block expanded from its
 * semaphoreEnvs entry. Wrangler env blocks do not inherit binding keys, so
 * the shared bindings are spelled out per env by this script — that
 * repetition is exactly why the file is generated instead of hand-written.
 *
 * Everything here is non-secret. Secret VALUES never appear: secrets ride
 * `wrangler deploy --secrets-file` (see deploy.ts), and `secrets.required`
 * below is just the list of names — which also makes the vite plugin load
 * exactly those keys from process.env under `doppler run -- vite dev`.
 */
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { semaphoreEnvs, type SemaphoreEnv } from "../../../envs.ts";
import {
  OBSERVABILITY,
  writeGeneratedWranglerConfig,
} from "../../../scripts/lib/wrangler-config.ts";

/**
 * Placeholder D1 database id for local dev — miniflare only needs a stable
 * id. sqlfu.config.ts imports it to open the exact database `pnpm dev`
 * serves.
 */
export const LOCAL_DEV_RESOURCES_DB_ID = "local-dev-resources-db";

/**
 * Secrets every deployment needs, sourced from the env's Doppler config.
 * `deploy.ts` builds its --secrets-file from exactly this list and fails
 * before deploying when the Doppler config is missing one.
 */
export const REQUIRED_SECRETS = [
  "APP_CONFIG_LOGS",
  "APP_CONFIG_POSTHOG",
  "APP_CONFIG_ITERATE_AUTH__CLIENT_ID",
  "APP_CONFIG_ITERATE_AUTH__CLIENT_SECRET",
];

/**
 * Env-shaping config that is NOT secret and already lives in envs.ts —
 * emitted as per-env `vars` so the worker's runtime base URL and auth issuer
 * can never drift from the route generated off the same entry. Local dev has
 * no base URL (the config schema keeps it optional), so these are
 * deliberately absent from the top-level `secrets.required` — except the
 * issuer, which local dev loads from Doppler to sign in via the shared dev
 * auth deployment.
 */
export function envShapedVars(env: SemaphoreEnv) {
  return {
    APP_CONFIG_BASE_URL: env.baseUrl,
    APP_CONFIG_ITERATE_AUTH__ISSUER: `${env.authBaseUrl}/api/auth`,
  };
}

/** Binding config identical across local dev and every deployed env, apart from the D1 id. */
function workerBindings(input: { resourcesDbId: string }) {
  return {
    d1_databases: [
      {
        binding: "DB",
        database_id: input.resourcesDbId,
        migrations_dir: "./migrations",
      },
    ],
    durable_objects: {
      bindings: [{ name: "RESOURCE_COORDINATOR", class_name: "ResourceCoordinator" }],
    },
    secrets: { required: REQUIRED_SECRETS },
    observability: OBSERVABILITY,
  };
}

function envBlock(env: SemaphoreEnv) {
  const host = new URL(env.baseUrl).hostname;
  return {
    name: env.workerName,
    account_id: env.cloudflareAccountId,
    routes: [{ pattern: `${host}/*`, zone_name: host.split(".").slice(1).join(".") }],
    ...workerBindings({ resourcesDbId: env.resources.resourcesDbId }),
    vars: envShapedVars(env),
  };
}

const config = {
  $schema: "node_modules/wrangler/config-schema.json",
  name: "semaphore-dev",
  main: "./src/worker.ts",
  compatibility_date: "2026-06-17",
  compatibility_flags: ["nodejs_compat", "nodejs_compat_populate_process_env"],
  // No `assets` here: the vite plugin injects the client build's assets
  // config into the OUTPUT wrangler.json (dist/…) that deploys actually use.
  migrations: [{ tag: "v1", new_sqlite_classes: ["ResourceCoordinator"] }],
  // Local dev has no real database; miniflare only needs a stable id
  // (sqlfu.config.ts opens the same id for local migrations/queries).
  ...workerBindings({ resourcesDbId: LOCAL_DEV_RESOURCES_DB_ID }),
  // Local dev also loads the iterate-auth env-shaping/baked keys from Doppler
  // when present (deployed envs get the issuer as a generated var and the
  // JWKS baked at deploy — see deploy.ts).
  secrets: {
    required: [
      ...REQUIRED_SECRETS,
      "APP_CONFIG_ITERATE_AUTH__ISSUER",
      "APP_CONFIG_ITERATE_AUTH__JWKS",
    ],
  },
  env: Object.fromEntries(
    Object.entries(semaphoreEnvs).map(([name, env]) => [name, envBlock(env)]),
  ),
};

/** Write wrangler.jsonc (gitignored) if changed — see writeGeneratedWranglerConfig. */
export const writeWranglerConfig = () =>
  writeGeneratedWranglerConfig({
    configUrl: new URL("../wrangler.jsonc", import.meta.url),
    appLabel: "apps/semaphore",
    config,
  });

/** Regenerate apps/semaphore/wrangler.jsonc from the root envs.ts. */
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
