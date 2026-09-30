import { fileURLToPath } from "node:url";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { getEnv, telemetryEnvs } from "../../../envs.ts";
import { deployApp } from "../../../scripts/lib/deploy-app.ts";

/** vite build → wrangler deploy with the OTLP secret from Doppler → the Worker answers
 *  (scripts/lib/deploy-app.ts). ensure-resources.ts runs it too, after rotating the secret. */
export default async function deploy(options: { env: string }) {
  const env = getEnv(options.env, telemetryEnvs);
  await deployApp(env, {
    dopplerProject: env.dopplerProject,
    appRoot: fileURLToPath(new URL("..", import.meta.url)),
    appLabel: "apps/telemetry",
    requiredSecrets: ["TELEMETRY_OTLP_SECRET"],
    smokes: [{ url: "/", ok: (response) => response.status === 200, label: "index" }],
  });
}

void createCli({ ...import.meta, name: "deploy" }).run({
  logger: yamlTableConsoleLogger,
  prompts: isAgent() ? undefined : createBuiltInPrompts(),
});
