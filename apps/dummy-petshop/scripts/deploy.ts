import { fileURLToPath } from "node:url";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { dummyPetshopEnvs } from "../../../envs.ts";
import { deployApp } from "../../../scripts/lib/deploy-app.ts";

/** vite build → wrangler deploy → the shop's index answers (scripts/lib/deploy-app.ts). No secrets
 *  ship: PETSHOP_SEAL_KEY is already a worker secret, and a deploy keeps it. */
export default async function deploy(options: { env?: string } = {}) {
  await deployApp({
    appRoot: fileURLToPath(new URL("..", import.meta.url)),
    appLabel: "apps/dummy-petshop",
    envs: dummyPetshopEnvs,
    dopplerProject: "dummy-petshop",
    env: options.env,
    workerName: (env) => env.workerName,
    servingUrl: (env) => env.baseUrl,
    smokes: (env) => [
      { url: `${env.baseUrl}/`, ok: (status) => status === 200, label: "shop index" },
    ],
  });
}

if (process.argv[1]?.endsWith("deploy.ts")) {
  void createCli({ ...import.meta, name: "deploy" }).run({
    logger: yamlTableConsoleLogger,
    prompts: isAgent() ? undefined : createBuiltInPrompts(),
  });
}
