/**
 * Deploy apps/semaphore to a deployed environment:
 *
 *   pnpm run deploy --env preview_3
 *   pnpm run deploy --env prd
 *
 * Steps, all fail-fast:
 *   1. Verify the env's Doppler config carries every required secret and
 *      validate the exact runtime config with the worker's own zod schema —
 *      a config that would throw on every request fails HERE, not after
 *      shipping.
 *   2. Adopt the worker's Durable Object migration tag when the script
 *      predates wrangler-managed migrations (see deploy-helpers.ts
 *      adoptDoMigrationTag).
 *   3. Apply D1 migrations remotely (wrangler's d1_migrations table, which
 *      the alchemy deploys also used).
 *   4. `vite build` with CLOUDFLARE_ENV=<env>, so the build output's
 *      wrangler.json is flattened for that env (name, route, bindings).
 *   5. `wrangler deploy --config <built config> --secrets-file <doppler>` —
 *      secrets land atomically in the same version as the code.
 *   6. Smoke-probe the deployed health endpoint; exit nonzero unless the env
 *      is actually serving.
 *
 * CAUTION: semaphore-prd's ResourceCoordinator DO holds the LIVE preview-slot
 * lease state for the whole fleet. Always deploy over it — never delete the
 * worker or erase its Durable Object storage.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { semaphoreEnvs } from "../../../envs.ts";
import {
  adoptDoMigrationTag,
  collectSecrets,
  deployWithSecrets,
  findBuiltWranglerConfig,
  run,
  smoke,
} from "../../../scripts/lib/deploy-helpers.ts";
import { assertProvisioned, resolveEnvContext } from "../../../scripts/lib/env-context.ts";
import { parseConfig } from "../src/config.ts";
import {
  envShapedVars,
  REQUIRED_SECRETS,
  writeWranglerConfig,
} from "./generate-wrangler-config.ts";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));

const ctx = await resolveEnvContext({ envs: semaphoreEnvs, dopplerProject: "semaphore" });
assertProvisioned(ctx.name, ctx.env.resources);
console.log(
  `Deploying apps/semaphore to ${ctx.name} (worker ${ctx.env.workerName}, account ${ctx.env.cloudflareAccountId})`,
);

const cloudflareCredentials = {
  CLOUDFLARE_API_TOKEN: ctx.secrets.CLOUDFLARE_API_TOKEN,
  CLOUDFLARE_ACCOUNT_ID: ctx.env.cloudflareAccountId,
};

// ---- 1. Secrets + config validation -------------------------------------------
const secretValues = collectSecrets(ctx, REQUIRED_SECRETS);

// Parse the exact env the worker will see (secrets + generated vars) with
// the worker's own schema — the strongest possible pre-flight.
parseConfig({ ...secretValues, ...envShapedVars(ctx.env) });

// ---- 2. DO migration-tag adoption + D1 migrations ------------------------------
// The migrations step below reads wrangler.jsonc directly (and the vite
// build regenerates it again on its own) — write a fresh one now.
writeWranglerConfig();
await adoptDoMigrationTag(ctx, ctx.env.workerName);
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
  { cwd: APP_ROOT, env: cloudflareCredentials },
);

// ---- 3. Build ----------------------------------------------------------------
rmSync(join(APP_ROOT, "dist"), { recursive: true, force: true });
run("pnpm", ["exec", "vite", "build"], { cwd: APP_ROOT, env: { CLOUDFLARE_ENV: ctx.name } });

const builtConfig = findBuiltWranglerConfig(APP_ROOT);

// ---- 4. Deploy (code + secrets in one version) --------------------------------
await deployWithSecrets({
  cwd: APP_ROOT,
  builtConfig,
  secretValues,
  credentials: cloudflareCredentials,
  ensureClassesFor: { ctx, workerName: ctx.env.workerName },
});

// ---- 5. Smoke ------------------------------------------------------------------
await smoke(`${ctx.env.baseUrl}/api/__internal/health`, (status) => status === 200, "health");
console.log(`✅ ${ctx.name} deployed and serving at ${ctx.env.baseUrl}`);
