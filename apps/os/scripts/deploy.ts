/**
 * Deploy apps/os to a deployed environment:
 *
 *   pnpm run deploy --env preview_3
 *   pnpm run deploy --env prd
 *
 * Runs the shared pipeline (scripts/lib/deploy-app.ts). Steps, all fail-fast:
 *   1. Verify the env's Doppler config carries every required secret, bake
 *      the static auth JWKS (issuer keys + forge public key), and validate
 *      the exact runtime config with the worker's own zod schema — a config
 *      that would throw on every request fails HERE, not after shipping.
 *   2. `vite build` with CLOUDFLARE_ENV=<env>, so the build output's
 *      wrangler.json is flattened for that env (name, routes, bindings).
 *      vite.config.ts regenerates wrangler.jsonc from envs.ts before the
 *      cloudflare plugin reads it — the build always sees a fresh config.
 *   3. `wrangler deploy --config <built config> --secrets-file <doppler>` —
 *      secrets land atomically in the same version as the code (with a plain
 *      deploy first when the worker has no DO classes yet, i.e. a brand-new
 *      env's first upload — see deploy-helpers.ts).
 *   4. Smoke-probe the deployed base URL; exit nonzero unless the env is
 *      actually serving.
 *
 * The worker script is never deleted and routes are ensure-only, so a deploy
 * can never strand the env's hostnames (the old zombie-route/522 class).
 */
import { fileURLToPath } from "node:url";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { envs } from "../../../envs.ts";
import { bakeStaticAuthJwks } from "../../../scripts/lib/bake-auth-jwks.ts";
import { deployApp } from "../../../scripts/lib/deploy-app.ts";
import { run } from "../../../scripts/lib/deploy-helpers.ts";
import { parseConfig } from "../src/config.ts";
import {
  envShapedVars,
  OPTIONAL_SECRETS,
  REQUIRED_SECRETS,
  writeWranglerConfig,
} from "./generate-wrangler-config.ts";

/** Deploy apps/os to a deployed environment (see scripts/lib/deploy-app.ts for the pipeline). */
export default async function deploy(
  options: {
    /** Target environment name from envs.ts (falls back to DOPPLER_CONFIG in CI). */
    env?: string;
  } = {},
) {
  await deployApp({
    appRoot: fileURLToPath(new URL("..", import.meta.url)),
    appLabel: "apps/os",
    envs,
    dopplerProject: "os",
    env: options.env,
    workerName: (env) => env.osWorkerName,
    servingUrl: (env) => env.baseUrl,
    resources: (env) => env.resources,
    requiredSecrets: REQUIRED_SECRETS,
    optionalSecrets: OPTIONAL_SECRETS,
    prepare: async (ctx, secretValues, credentials) => {
      // Baked at deploy time, so it's the one secret not in secrets.required.
      secretValues.APP_CONFIG_ITERATE_AUTH__JWKS = await bakeStaticAuthJwks({
        authBaseUrl: ctx.env.authBaseUrl,
        envName: ctx.name,
        dopplerConfig: ctx.env.dopplerConfig,
        secrets: ctx.secrets,
      });

      // Parse the exact env the worker will see (secrets + generated vars) with
      // the worker's own schema — the strongest possible pre-flight.
      parseConfig({ ...secretValues, ...envShapedVars(ctx.env) });

      // The builder sidecar deploys FIRST: the os worker's BUILDER service
      // binding is by name, and a binding to a not-yet-existing script fails
      // the deploy. The builder has no secrets and no vite build — wrangler
      // bundles src/builder.ts (esbuild-wasm rides as a wasm module).
      // Skew window: between this deploy and the os deploy (or if the os
      // deploy fails), a bundler/schema-version bump means the os worker
      // hashes the OLD key prefix while the builder writes the new one — the
      // cache runs cold (correct output via by-value returns, every request
      // rebuilds) until the os deploy lands. If "cache never hits" appears
      // mid-rollout, finish the deploy.
      writeWranglerConfig();
      run(
        "pnpm",
        ["exec", "wrangler", "deploy", "--config", "wrangler.builder.jsonc", "--env", ctx.name],
        { cwd: fileURLToPath(new URL("..", import.meta.url)), env: credentials },
      );
    },
    smokes: (env) => [
      {
        url: `${env.baseUrl}/`,
        ok: (status) => status === 200 || (status >= 300 && status < 400),
        label: "dashboard",
      },
      { url: `${env.eventDocsBaseUrl}/`, ok: (status) => status === 200, label: "event docs" },
      { url: `${env.baseUrl}/api`, ok: (status) => status < 500, label: "os api" },
    ],
  });
}

if (process.argv[1]?.endsWith("deploy.ts")) {
  void createCli({ ...import.meta, name: "deploy" }).run({
    logger: yamlTableConsoleLogger,
    prompts: isAgent() ? undefined : createBuiltInPrompts(),
  });
}
