/**
 * Generates apps/streams-example-app/wrangler.jsonc (gitignored) from the
 * root envs.ts.
 *
 * Nobody edits or commits the output: vite.config.ts regenerates it before
 * every dev/build, deploys therefore always see a fresh one, and
 * `pnpm gen:wrangler` refreshes it by hand for ad-hoc wrangler commands.
 *
 * The top-level config is local dev; each deployed environment gets an env
 * block expanded from its streamsExampleEnvs entry. Each env serves on its
 * custom domain (routes from the envs.ts baseUrl; deploy.ts ensures the DNS
 * record); workers.dev is off (see envs.ts for why). Its one binding is the
 * same-script STREAM Durable Object — the app re-exports apps/os's
 * StreamDurableObject from its own worker entry (src/worker.ts) via the `~`
 * alias, so the class lives in this script.
 */
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { streamsExampleEnvs, type StreamsExampleEnv } from "../../../envs.ts";
import {
  OBSERVABILITY,
  writeGeneratedWranglerConfig,
} from "../../../scripts/lib/wrangler-config.ts";

/**
 * Secrets every deployment needs, sourced from the env's Doppler config.
 * `deploy.ts` builds its --secrets-file from exactly this list and fails
 * before deploying when the Doppler config is missing one. The playground is
 * admin-only on deployed envs (see src/iterate-auth.ts); local dev carries
 * none of these and stays auth-less.
 */
export const REQUIRED_SECRETS = [
  "APP_CONFIG_ITERATE_AUTH__CLIENT_ID",
  "APP_CONFIG_ITERATE_AUTH__CLIENT_SECRET",
];

export const COMPATIBILITY_DATE = "2026-06-17";

/**
 * Env-shaping config that is NOT secret and already lives in envs.ts —
 * emitted as per-env `vars` so the worker's runtime base URL and auth issuer
 * can never drift from the envs.ts entry that names the worker.
 */
export function envShapedVars(env: StreamsExampleEnv) {
  return {
    APP_CONFIG_BASE_URL: env.baseUrl,
    APP_CONFIG_ITERATE_AUTH__ISSUER: `${env.authBaseUrl}/api/auth`,
  };
}

/** Binding config identical across local dev and every deployed env. */
function workerBindings() {
  return {
    durable_objects: {
      bindings: [{ name: "STREAM", class_name: "StreamDurableObject" }],
    },
    observability: OBSERVABILITY,
  };
}

function envBlock(env: StreamsExampleEnv) {
  return {
    name: env.workerName,
    account_id: env.cloudflareAccountId,
    routes: [
      {
        pattern: `${new URL(env.baseUrl).hostname}/*`,
        zone_name: new URL(env.baseUrl).hostname.split(".").slice(1).join("."),
      },
    ],
    workers_dev: false,
    ...workerBindings(),
    secrets: { required: REQUIRED_SECRETS },
    vars: envShapedVars(env),
  };
}

const config = {
  $schema: "node_modules/wrangler/config-schema.json",
  // Env-less service name: wrangler tags every `--env` deploy with
  // `cf:service=<top-level name>`, so a "-dev" suffix here would mis-bucket
  // deployed workers under a fake "dev" service in observability queries.
  name: "streams-example-app",
  main: "./src/worker.ts",
  compatibility_date: COMPATIBILITY_DATE,
  // global_fetch_strictly_public: the iterate-auth login handler fetches the
  // auth worker for OIDC discovery + token exchange; without the flag,
  // same-zone subrequests would go to the zone origin instead of through
  // Worker routes (~20s hang then 500 — same incident class as os/auth/
  // semaphore). workers.dev origins are cross-zone to auth today, but the
  // flag keeps this safe if the app ever gets a custom domain.
  compatibility_flags: [
    "nodejs_compat",
    "nodejs_compat_populate_process_env",
    "global_fetch_strictly_public",
  ],
  // No `assets` here: the vite plugin injects the client build's assets
  // config into the OUTPUT wrangler.json (dist/…) that deploys actually use.
  // Declarative DO lifecycle — the server reconciles this against live
  // namespaces per deploy, no tag history (see apps/os DO_EXPORTS).
  exports: { StreamDurableObject: { type: "durable-object", storage: "sqlite" } },
  ...workerBindings(),
  // Local dev loads the iterate-auth keys from process.env when present (the
  // vite plugin reads exactly `secrets.required`); absent keys leave the dev
  // playground auth-less, which is the intended local mode.
  secrets: {
    required: [
      ...REQUIRED_SECRETS,
      "APP_CONFIG_ITERATE_AUTH__ISSUER",
      "APP_CONFIG_ITERATE_AUTH__JWKS",
    ],
  },
  env: Object.fromEntries(
    Object.entries(streamsExampleEnvs).map(([name, env]) => [name, envBlock(env)]),
  ),
};

/** Write wrangler.jsonc (gitignored) if changed — see writeGeneratedWranglerConfig. */
export const writeWranglerConfig = () =>
  writeGeneratedWranglerConfig({
    configUrl: new URL("../wrangler.jsonc", import.meta.url),
    appLabel: "apps/streams-example-app",
    config,
  });

/** Regenerate apps/streams-example-app/wrangler.jsonc from the root envs.ts. */
export default function generateWranglerConfig() {
  console.log(`Wrote ${writeWranglerConfig()}`);
}

// The CLI runs only when invoked directly — deploy.ts and vite.config.ts
// import from this module without triggering a write.
void createCli({ ...import.meta, name: "generate-wrangler-config" }).run({
  logger: yamlTableConsoleLogger,
  prompts: isAgent() ? undefined : createBuiltInPrompts(),
});
