import { fileURLToPath } from "node:url";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { envManagerEnv } from "../../../envs.ts";
import { deployApp } from "../../../scripts/lib/deploy-app.ts";
import { parseConfig } from "../src/config.ts";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const managerEnvs = { prd: envManagerEnv };
const REQUIRED_SECRETS = [
  "APP_CONFIG_ITERATE_AUTH__CLIENT_ID",
  "APP_CONFIG_ITERATE_AUTH__CLIENT_SECRET",
  "APP_CONFIG_ITERATE_AUTH__JWKS",
];

/** Deploy the one env-manager Worker. Its `prd` Doppler config targets the preview account. */
export default async function deploy(options: { env?: "prd" } = {}) {
  await deployApp({
    appRoot: APP_ROOT,
    appLabel: "apps/env-manager",
    envs: managerEnvs,
    dopplerProject: "env-manager",
    env: options.env,
    workerName: (env) => env.workerName,
    servingUrl: (env) => env.baseUrl,
    requiredSecrets: REQUIRED_SECRETS,
    // This is a singleton config, not a Wrangler named environment. The
    // shared deploy pipeline normally sets CLOUDFLARE_ENV from `--env`; an
    // empty override keeps Wrangler from suffixing the script with "-prd".
    buildEnv: () => ({ CLOUDFLARE_ENV: "" }),
    prepare: (_ctx, secrets) => {
      parseConfig({
        APP_CONFIG_BASE_URL: envManagerEnv.baseUrl,
        APP_CONFIG_ITERATE_AUTH__ISSUER: `${envManagerEnv.authBaseUrl}/api/auth`,
        APP_CONFIG_ITERATE_AUTH__RESOURCE: envManagerEnv.baseUrl,
        ...secrets,
      });
    },
    smokes: (env) => [
      {
        url: `${env.baseUrl}/api/health`,
        ok: (status) => status === 200,
        label: "health",
      },
    ],
  });
}

void createCli({ ...import.meta, name: "deploy" }).run({
  logger: yamlTableConsoleLogger,
  prompts: isAgent() ? undefined : createBuiltInPrompts(),
});
