import { fileURLToPath } from "node:url";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { z } from "zod";
import { envManagerEnv } from "../../../envs.ts";
import { deployApp } from "../../../scripts/lib/deploy-app.ts";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const managerEnvs = { prd: envManagerEnv };
const AccessCredentials = z.object({
  CLOUDFLARE_ACCESS_CLIENT_ID: z.string().trim().min(1),
  CLOUDFLARE_ACCESS_CLIENT_SECRET: z.string().trim().min(1),
});

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
    // This is a singleton config, not a Wrangler named environment. The
    // shared deploy pipeline normally sets CLOUDFLARE_ENV from `--env`; an
    // empty override keeps Wrangler from suffixing the script with "-prd".
    buildEnv: () => ({ CLOUDFLARE_ENV: "" }),
    prepare: (ctx) => {
      AccessCredentials.parse(ctx.secrets);
    },
    smokes: (env, ctx) => {
      const credentials = AccessCredentials.parse(ctx.secrets);
      return [
        {
          url: `${env.baseUrl}/api/health`,
          ok: (status: number) => status === 200,
          label: "health",
          headers: {
            "CF-Access-Client-Id": credentials.CLOUDFLARE_ACCESS_CLIENT_ID,
            "CF-Access-Client-Secret": credentials.CLOUDFLARE_ACCESS_CLIENT_SECRET,
          },
        },
      ];
    },
  });
}

void createCli({ ...import.meta, name: "deploy" }).run({
  logger: yamlTableConsoleLogger,
  prompts: isAgent() ? undefined : createBuiltInPrompts(),
});
