/**
 * Deploy apps/mobile/website (mobile.iterate.com):
 *
 *   pnpm run deploy --env prd
 *
 * Runs the shared pipeline (scripts/lib/deploy-app.ts). No build step:
 * wrangler bundles the TypeScript entry itself. Secrets ride
 * `wrangler deploy --secrets-file`, so code + secrets land in one version.
 * Secrets come from doppler project `os` (the CI snapshot writers already
 * authenticate with os's admin bearer — one secret, one rotation).
 */
import { fileURLToPath } from "node:url";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { mobileWebsiteEnvs } from "../../../../envs.ts";
import { deployApp } from "../../../../scripts/lib/deploy-app.ts";

/** Deploy apps/mobile/website — see scripts/lib/deploy-app.ts for the pipeline. */
export default async function deploy(
  options: {
    /** Target environment name from envs.ts (falls back to DOPPLER_CONFIG in CI). */
    env?: string;
  } = {},
) {
  await deployApp({
    appRoot: fileURLToPath(new URL("..", import.meta.url)),
    appLabel: "apps/mobile/website",
    envs: mobileWebsiteEnvs,
    dopplerProject: "os",
    env: options.env,
    workerName: (env) => env.workerName,
    servingUrl: (env) => env.baseUrl,
    requiredSecrets: ["APP_CONFIG_ADMIN_API_SECRET"],
    // The checked-in wrangler.jsonc carries the env blocks, so deploy selects
    // one with --env instead of a built per-env config.
    build: "checked-in-config",
    smokes: (env) => [
      // The install page renders its honest fallback even with an empty
      // bucket, so anything under 500 proves the worker + R2 binding serve.
      { url: `${env.baseUrl}/m/install/preview`, ok: (status) => status < 500, label: "install" },
      { url: `${env.baseUrl}/`, ok: (status) => status < 500, label: "root" },
    ],
  });
}

void createCli({ ...import.meta, name: "deploy" }).run({
  logger: yamlTableConsoleLogger,
  prompts: isAgent() ? undefined : createBuiltInPrompts(),
});
