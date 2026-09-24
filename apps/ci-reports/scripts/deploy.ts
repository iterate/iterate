import { fileURLToPath } from "node:url";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { ciReportsEnvs } from "../../../envs.ts";
import { deployApp } from "../../../scripts/lib/deploy-app.ts";

/** vite build → wrangler deploy with Depot's token → the viewer answers (scripts/lib/deploy-app.ts). */
export default async function deploy(options: { env?: string } = {}) {
  await deployApp({
    appRoot: fileURLToPath(new URL("..", import.meta.url)),
    appLabel: "apps/ci-reports",
    envs: ciReportsEnvs,
    dopplerProject: "_shared",
    env: options.env,
    workerName: (env) => env.workerName,
    servingUrl: (env) => env.baseUrl,
    requiredSecrets: ["DEPOT_CI_TELEMETRY_TOKEN"],
    smokes: (env) => [
      { url: `${env.baseUrl}/`, ok: (status) => status === 200, label: "viewer index" },
    ],
  });
}

if (process.argv[1]?.endsWith("deploy.ts")) {
  void createCli({ ...import.meta, name: "deploy" }).run({
    logger: yamlTableConsoleLogger,
    prompts: isAgent() ? undefined : createBuiltInPrompts(),
  });
}
