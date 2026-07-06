/**
 * Deploy apps/streams-example-app (the streams browser playground):
 *
 *   pnpm run deploy --env preview_3
 *   pnpm run deploy --env prd
 *
 * workers.dev only — no routes, no DNS, no resources. Secrets are the
 * iterate-auth relying-party credentials plus the JWKS baked in `prepare`
 * (admin-only access on deployed envs). Runs the shared pipeline
 * (scripts/lib/deploy-app.ts):
 * `vite build` with CLOUDFLARE_ENV=<env> (vite.config.ts regenerates
 * wrangler.jsonc from envs.ts before the cloudflare plugin reads it — the
 * build always sees a fresh config), deploy, then smoke-probe the health
 * endpoint.
 */
import { fileURLToPath } from "node:url";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { streamsExampleEnvs } from "../../../envs.ts";
import { bakeStaticAuthJwks } from "../../../scripts/lib/bake-auth-jwks.ts";
import { deployApp } from "../../../scripts/lib/deploy-app.ts";
import { parseConfig } from "../src/config.ts";
import { envShapedVars, REQUIRED_SECRETS } from "./generate-wrangler-config.ts";

/** Deploy apps/streams-example-app to a deployed environment (see scripts/lib/deploy-app.ts for the pipeline). */
export default async function deploy(
  options: {
    /** Target environment name from envs.ts (falls back to DOPPLER_CONFIG in CI). */
    env?: string;
  } = {},
) {
  await deployApp({
    appRoot: fileURLToPath(new URL("..", import.meta.url)),
    appLabel: "apps/streams-example-app",
    envs: streamsExampleEnvs,
    dopplerProject: "streams-example-app",
    env: options.env,
    workerName: (env) => env.workerName,
    servingUrl: (env) => env.baseUrl,
    requiredSecrets: REQUIRED_SECRETS,
    prepare: async (ctx, secretValues) => {
      // The playground verifies iterate sessions and bearer tokens against a
      // static JWKS baked at deploy time (issuer keys + forge public key) —
      // the same relying-party model as apps/os and apps/semaphore.
      secretValues.APP_CONFIG_ITERATE_AUTH__JWKS = await bakeStaticAuthJwks({
        authBaseUrl: ctx.env.authBaseUrl,
        envName: ctx.name,
        dopplerConfig: ctx.env.dopplerConfig,
        secrets: ctx.secrets,
      });

      // Parse the exact env the worker will see (secrets + generated vars)
      // with the worker's own schema — the strongest possible pre-flight.
      parseConfig({ ...secretValues, ...envShapedVars(ctx.env) });
    },
    smokes: (env) => [
      {
        url: `${env.baseUrl}/api/__internal/health`,
        ok: (status) => status === 200,
        label: "health",
      },
    ],
  });
}

if (process.argv[1]?.endsWith("deploy.ts")) {
  void createCli({ ...import.meta, name: "deploy" }).run({
    logger: yamlTableConsoleLogger,
    prompts: isAgent() ? undefined : createBuiltInPrompts(),
  });
}
