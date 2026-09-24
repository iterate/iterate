import { fileURLToPath } from "node:url";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { tunnelsEnvs } from "../../../envs.ts";
import { deployApp } from "../../../scripts/lib/deploy-app.ts";

/** Deploy the Captun gateway over its existing Worker and Durable Object namespace. */
export default async function deploy(options: { env?: string } = {}) {
  await deployApp({
    appRoot: fileURLToPath(new URL("..", import.meta.url)),
    appLabel: "apps/tunnels",
    envs: tunnelsEnvs,
    dopplerProject: "tunnels",
    env: options.env,
    workerName: (env) => env.workerName,
    servingUrl: (env) => `https://${env.hostname}`,
    requiredSecrets: ["CAPTUN_TOKEN"],
    smokes: (env) => [
      { url: `https://${env.hostname}/`, ok: (status) => status < 500, label: "gateway" },
    ],
  });
}

if (process.argv[1]?.endsWith("deploy.ts")) {
  void createCli({ ...import.meta, name: "deploy" }).run({
    logger: yamlTableConsoleLogger,
    prompts: isAgent() ? undefined : createBuiltInPrompts(),
  });
}
