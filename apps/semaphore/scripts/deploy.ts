/**
 * Deploy apps/semaphore to a deployed environment:
 *
 *   pnpm run deploy --env preview_3
 *   pnpm run deploy --env prd
 *
 * Runs the shared pipeline (scripts/lib/deploy-app.ts). Steps, all fail-fast:
 *   1. Verify the env's Doppler config carries every required secret and
 *      validate the exact runtime config with the worker's own zod schema —
 *      a config that would throw on every request fails HERE, not after
 *      shipping.
 *   2. Apply D1 migrations remotely (wrangler's d1_migrations table, which
 *      the alchemy deploys also used), then adopt the worker's Durable
 *      Object migration tag when the script predates wrangler-managed
 *      migrations (see deploy-helpers.ts adoptDoMigrationTag).
 *   3. `vite build` with CLOUDFLARE_ENV=<env>, so the build output's
 *      wrangler.json is flattened for that env (name, route, bindings).
 *   4. `wrangler deploy --config <built config> --secrets-file <doppler>` —
 *      secrets land atomically in the same version as the code.
 *   5. Smoke-probe the deployed health endpoint; exit nonzero unless the env
 *      is actually serving.
 *
 * CAUTION: semaphore-prd's ResourceCoordinator DO holds the LIVE preview-slot
 * lease state for the whole fleet. Always deploy over it — never delete the
 * worker or erase its Durable Object storage.
 */
import { fileURLToPath } from "node:url";
import { semaphoreEnvs } from "../../../envs.ts";
import { deployApp } from "../../../scripts/lib/deploy-app.ts";
import { run } from "../../../scripts/lib/deploy-helpers.ts";
import { parseConfig } from "../src/config.ts";
import {
  envShapedVars,
  REQUIRED_SECRETS,
  writeWranglerConfig,
} from "./generate-wrangler-config.ts";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));

await deployApp({
  appRoot: APP_ROOT,
  appLabel: "apps/semaphore",
  envs: semaphoreEnvs,
  dopplerProject: "semaphore",
  workerName: (env) => env.workerName,
  servingUrl: (env) => env.baseUrl,
  resources: (env) => env.resources,
  requiredSecrets: REQUIRED_SECRETS,
  prepare: (ctx, secretValues, credentials) => {
    // Parse the exact env the worker will see (secrets + generated vars) with
    // the worker's own schema — the strongest possible pre-flight.
    parseConfig({ ...secretValues, ...envShapedVars(ctx.env) });

    // The migrations step below reads wrangler.jsonc directly (and the vite
    // build regenerates it again on its own) — write a fresh one now.
    writeWranglerConfig();
    run(
      "pnpm",
      [
        "exec",
        "wrangler",
        "d1",
        "migrations",
        "apply",
        "DB",
        "--env",
        ctx.name,
        "--remote",
        "--config",
        "wrangler.jsonc",
      ],
      { cwd: APP_ROOT, env: credentials },
    );
  },
  smokes: (env) => [
    {
      url: `${env.baseUrl}/api/__internal/health`,
      ok: (status) => status === 200,
      label: "health",
    },
  ],
});
