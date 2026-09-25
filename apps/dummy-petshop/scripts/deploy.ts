import { fileURLToPath } from "node:url";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { dummyPetshopEnvs } from "../../../envs.ts";
import { deployApp } from "../../../scripts/lib/deploy-app.ts";
import { envNamed } from "../../../scripts/lib/env-context.ts";

/** vite build → wrangler deploy → the shop's index answers (scripts/lib/deploy-app.ts). No secrets
 *  ship: PETSHOP_SEAL_KEY is already a worker secret, and a deploy keeps it. */
export default async function deploy(options: { env: string }) {
  const env = envNamed(dummyPetshopEnvs, options.env);
  await deployApp({
    appRoot: fileURLToPath(new URL("..", import.meta.url)),
    appLabel: "apps/dummy-petshop",
    name: options.env,
    env,
    dopplerProject: "dummy-petshop",
    workerName: env.workerName,
    servingUrl: env.baseUrl,
    smokes: [{ url: `${env.baseUrl}/`, ok: (status) => status === 200, label: "shop index" }],
  });
}

if (process.argv[1]?.endsWith("deploy.ts")) {
  void createCli({ ...import.meta, name: "deploy" }).run({
    logger: yamlTableConsoleLogger,
    prompts: isAgent() ? undefined : createBuiltInPrompts(),
  });
}
