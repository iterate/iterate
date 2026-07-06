/**
 * Deploy apps/streams-example-app (the streams browser playground):
 *
 *   pnpm run deploy --env preview_3
 *   pnpm run deploy --env prd
 *
 * workers.dev only — no routes, no DNS, no resources, no secrets (the
 * pipeline's secrets file is an empty `{}`, which preserves any existing
 * secrets and sets none). Runs the shared pipeline (scripts/lib/deploy-app.ts):
 * `vite build` with CLOUDFLARE_ENV=<env> (vite.config.ts regenerates
 * wrangler.jsonc from envs.ts before the cloudflare plugin reads it — the
 * build always sees a fresh config), deploy, then smoke-probe the health
 * endpoint.
 */
import { fileURLToPath } from "node:url";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { streamsExampleEnvs } from "../../../envs.ts";
import { deployApp } from "../../../scripts/lib/deploy-app.ts";

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
