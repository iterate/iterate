import { fileURLToPath } from "node:url";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { ciReportsEnvs, getEnv } from "../../../envs.ts";
import { deployApp } from "../../../scripts/lib/deploy-app.ts";

/** vite build → wrangler deploy with Depot's token → the viewer answers (scripts/lib/deploy-app.ts). */
export default async function deploy(options: { env: string }) {
  await deployApp(getEnv(options.env, ciReportsEnvs), {
    dopplerProject: "_shared",
    appRoot: fileURLToPath(new URL("..", import.meta.url)),
    appLabel: "apps/ci-reports",
    requiredSecrets: ["DEPOT_CI_TELEMETRY_TOKEN"],
    smokes: [{ url: "/", ok: (response) => response.status === 200, label: "viewer index" }],
  });
}

void createCli({ ...import.meta, name: "deploy" }).run({
  logger: yamlTableConsoleLogger,
  prompts: isAgent() ? undefined : createBuiltInPrompts(),
});
