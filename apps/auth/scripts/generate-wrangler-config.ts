/**
 * Generates apps/auth/wrangler.jsonc (gitignored) from the root envs.ts.
 *
 * Nobody edits or commits the output: vite.config.ts regenerates it before
 * every dev/build, deploys therefore always see a fresh one, and
 * `pnpm gen:wrangler` refreshes it by hand for ad-hoc wrangler commands.
 *
 * The top-level config is local dev (no routes, a miniflare-only D1 id); each
 * deployed environment gets an env block expanded from its authEnvs entry.
 * Wrangler env blocks do not inherit binding keys, so the shared bindings are
 * spelled out per env by this script — that repetition is exactly why the
 * file is generated instead of hand-written.
 *
 * Everything here is non-secret. Secret VALUES never appear: secrets ride
 * `wrangler deploy --secrets-file` (see deploy.ts), and `secrets.required`
 * below is just the list of names — which also makes the vite plugin load
 * exactly those keys from process.env under `doppler run -- vite dev`.
 */
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { authEnvs, type AuthDeployedEnv } from "../../../envs.ts";
import {
  OBSERVABILITY,
  writeGeneratedWranglerConfig,
} from "../../../scripts/lib/wrangler-config.ts";

/**
 * Placeholder D1 database id for local dev — miniflare only needs a stable
 * id. sqlfu.config.ts imports it to open the exact database `pnpm dev`
 * serves.
 */
export const LOCAL_DEV_AUTH_DB_ID = "local-dev-auth-db";

/**
 * Secrets every deployment needs, sourced verbatim from the env's Doppler
 * config (project `auth`). The names match Doppler reality — the
 * `APP_CONFIG_*` keys PR #1594's AppConfig port established — and are the
 * worker's runtime binding names, so there is no mapping layer anywhere.
 * `deploy.ts` fails before deploying when the Doppler config is missing one.
 */
export const REQUIRED_SECRETS = [
  "APP_CONFIG_BETTER_AUTH_SECRET",
  "APP_CONFIG_EMAIL_SENDER_DOMAIN",
  "APP_CONFIG_GOOGLE_CLIENT_ID",
  "APP_CONFIG_GOOGLE_CLIENT_SECRET",
  "APP_CONFIG_SERVICE_AUTH_TOKEN",
  "APP_CONFIG_SIGNUP_ALLOWLIST",
];

/**
 * Runtime bindings deploy.ts computes rather than requires: an explicit
 * Doppler value wins, otherwise a default (admin allowlist `*@nustom.com`;
 * email OTP on in every env, prd included — setting the Doppler key to
 * "false" is the rollback switch). Still shipped via --secrets-file so
 * they land atomically with the code.
 */
export const DERIVED_SECRETS = ["APP_CONFIG_ADMIN_ALLOWLIST", "APP_CONFIG_EMAIL_OTP_ENABLED"];

/**
 * The Email Service send binding for the email-OTP lane. Sends are restricted
 * to the env's own `noreply+auth@` sender at runtime (the address is built
 * from APP_CONFIG_EMAIL_SENDER_DOMAIN in src/server/email.ts); local dev gets
 * the same binding, where miniflare simulates sends instead of delivering.
 */
const sendEmailBindings = [{ name: "EMAIL" }];

/**
 * Env-shaping config that is NOT secret and already lives in envs.ts —
 * emitted as per-env `vars` so the worker's runtime origin can never drift
 * from the route generated off the same entry. The names are the same
 * `APP_CONFIG_*` keys src/config.ts parses at runtime; deploy.ts also passes
 * them into the `vite build` environment because vite.config.ts inlines the
 * origin into the client bundle (`__AUTH_APP_ORIGIN__`). Local dev has no env
 * block; the key loads from process.env under `doppler run -- vite dev`.
 */
export function envShapedVars(env: AuthDeployedEnv) {
  return {
    APP_CONFIG_AUTH_APP_ORIGIN: env.authBaseUrl,
    APP_CONFIG_PUBLIC_URL: env.authBaseUrl,
  };
}

// Deliberately omits APP_CONFIG_PUBLIC_URL: optional in src/config.ts, where
// it defaults to authAppOrigin at runtime — local dev needn't supply it.
const ENV_SHAPED_KEYS = ["APP_CONFIG_AUTH_APP_ORIGIN"];

/** The auth D1 binding; `migrations_dir` feeds `wrangler d1 migrations apply` in deploy.ts. */
function d1Bindings(input: { workerName: string; databaseId: string }) {
  return [
    {
      binding: "DB",
      database_name: `${input.workerName}-auth-db`,
      database_id: input.databaseId,
      migrations_dir: "./src/server/db/migrations",
    },
  ];
}

function envBlock(env: AuthDeployedEnv) {
  const authHost = new URL(env.authBaseUrl).hostname;
  return {
    name: env.authWorkerName,
    account_id: env.cloudflareAccountId,
    routes: [{ pattern: `${authHost}/*`, zone_name: authHost.split(".").slice(1).join(".") }],
    d1_databases: d1Bindings({
      workerName: env.authWorkerName,
      databaseId: env.resources.authDbId,
    }),
    send_email: sendEmailBindings,
    vars: envShapedVars(env),
    secrets: { required: [...REQUIRED_SECRETS, ...DERIVED_SECRETS] },
    observability: OBSERVABILITY,
  };
}

const config = {
  $schema: "node_modules/wrangler/config-schema.json",
  // Env-less service name: wrangler tags every `--env` deploy with
  // `cf:service=<top-level name>`, so a "-dev" suffix here would mis-bucket
  // deployed workers under a fake "dev" service in observability queries.
  name: "auth",
  main: "./src/server/worker.ts",
  compatibility_date: "2026-06-17",
  // nodejs_compat(+populate_process_env): hono's contextStorage needs
  // node:async_hooks (the worker runs under the "node" preset).
  // global_fetch_strictly_public: same-zone subrequests (e.g. SSR calling our
  // own /api/auth/get-session via the public hostname) must traverse Worker
  // routes instead of hanging against the originless zone for ~20s.
  compatibility_flags: [
    "nodejs_compat",
    "nodejs_compat_populate_process_env",
    "global_fetch_strictly_public",
  ],
  // `assets` is inheritable, so declaring it once here covers every env; the
  // vite plugin injects the client build's directory into the OUTPUT
  // wrangler.json that deploys actually use.
  assets: {
    not_found_handling: "single-page-application",
    run_worker_first: ["/api/*"],
  },
  // Local dev has no real database; miniflare only needs a stable id.
  d1_databases: d1Bindings({ workerName: "auth-dev", databaseId: LOCAL_DEV_AUTH_DB_ID }),
  send_email: sendEmailBindings,
  // Local dev loads the env-shaping keys from process.env like any other
  // secret (deployed envs get them as generated vars instead).
  secrets: { required: [...REQUIRED_SECRETS, ...DERIVED_SECRETS, ...ENV_SHAPED_KEYS] },
  observability: OBSERVABILITY,
  env: Object.fromEntries(Object.entries(authEnvs).map(([name, env]) => [name, envBlock(env)])),
};

/** Write wrangler.jsonc (gitignored) if changed — see writeGeneratedWranglerConfig. */
export const writeWranglerConfig = () =>
  writeGeneratedWranglerConfig({
    configUrl: new URL("../wrangler.jsonc", import.meta.url),
    appLabel: "apps/auth",
    config,
  });

/** Regenerate apps/auth/wrangler.jsonc from the root envs.ts. */
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
