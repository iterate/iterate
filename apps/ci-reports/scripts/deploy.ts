import { fileURLToPath } from "node:url";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { ciReportsEnvs } from "../../../envs.ts";
import { deployApp } from "../../../scripts/lib/deploy-app.ts";
import { envNamed } from "../../../scripts/lib/env-context.ts";

/** vite build → wrangler deploy with Depot's token → the viewer answers (scripts/lib/deploy-app.ts). */
export default async function deploy(options: { env: string }) {
  const env = envNamed(ciReportsEnvs, options.env);
  await deployApp({
    appRoot: fileURLToPath(new URL("..", import.meta.url)),
    appLabel: "apps/ci-reports",
    name: options.env,
    env,
    dopplerProject: "_shared",
    workerName: env.workerName,
    servingUrl: env.baseUrl,
    requiredSecrets: ["DEPOT_CI_TELEMETRY_TOKEN"],
    smokes: [{ url: `${env.baseUrl}/`, ok: (status) => status === 200, label: "viewer index" }],
  });
}

if (process.argv[1]?.endsWith("deploy.ts")) {
  void createCli({ ...import.meta, name: "deploy" }).run({
    logger: yamlTableConsoleLogger,
    prompts: isAgent() ? undefined : createBuiltInPrompts(),
  });
}
