/**
 * Deploy apps/streams-example-app (the streams browser playground):
 *
 *   pnpm run deploy --env preview_3
 *   pnpm run deploy --env prd
 *
 * workers.dev only — no routes, no DNS, no secrets. Steps, all fail-fast:
 *   1. Adopt the worker's Durable Object migration tag when the script
 *      predates wrangler-managed migrations (see deploy-helpers.ts
 *      adoptDoMigrationTag).
 *   2. `vite build` with CLOUDFLARE_ENV=<env>, so the build output's
 *      wrangler.json is flattened for that env (name, bindings).
 *   3. `wrangler deploy --config <built config>`.
 *   4. Smoke-probe the deployed health endpoint; exit nonzero unless the env
 *      is actually serving.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { streamsExampleEnvs } from "../../../envs.ts";
import {
  adoptDoMigrationTag,
  findBuiltWranglerConfig,
  run,
  smoke,
} from "../../../scripts/lib/deploy-helpers.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));

const ctx = await resolveEnvContext({
  envs: streamsExampleEnvs,
  dopplerProject: "streams-example-app",
});
console.log(
  `Deploying apps/streams-example-app to ${ctx.name} (worker ${ctx.env.workerName}, account ${ctx.env.cloudflareAccountId})`,
);

await adoptDoMigrationTag(ctx, ctx.env.workerName);

// vite.config.ts regenerates wrangler.jsonc from envs.ts before the
// cloudflare plugin reads it — the build below always sees a fresh config.
rmSync(join(APP_ROOT, "dist"), { recursive: true, force: true });
run("pnpm", ["exec", "vite", "build"], { cwd: APP_ROOT, env: { CLOUDFLARE_ENV: ctx.name } });

const builtConfig = findBuiltWranglerConfig(APP_ROOT);

run("pnpm", ["exec", "wrangler", "deploy", "--config", builtConfig], {
  cwd: APP_ROOT,
  env: {
    CLOUDFLARE_API_TOKEN: ctx.secrets.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: ctx.env.cloudflareAccountId,
  },
});

await smoke(`${ctx.env.baseUrl}/api/__internal/health`, (status) => status === 200, "health");
console.log(`✅ ${ctx.name} deployed and serving at ${ctx.env.baseUrl}`);
