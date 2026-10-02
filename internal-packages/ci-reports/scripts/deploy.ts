import { fileURLToPath } from "node:url";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { ciReportsEnvs, getEnv } from "../../../envs.ts";
import { deployApp } from "../../../scripts/lib/deploy-app.ts";

/** vite build → wrangler deploy with Depot's token → Cloudflare Access answers for the viewer
 *  (scripts/lib/deploy-app.ts): a visitor who isn't signed in is sent to Access's sign-in, never
 *  to a report. */
export default async function deploy(options: { env: string }) {
  const env = getEnv(options.env, ciReportsEnvs);
  await deployApp(env, {
    dopplerProject: "_shared",
    appRoot: fileURLToPath(new URL("..", import.meta.url)),
    appLabel: "internal-packages/ci-reports",
    requiredSecrets: ["DEPOT_CI_TELEMETRY_TOKEN"],
    smokes: [
      {
        url: "/",
        ok: (response) =>
          response.status === 302 &&
          (response.headers.get("location") || "").startsWith(`https://${env.accessTeamDomain}/`),
        label: "Access signs visitors in",
      },
    ],
  });
}

void createCli(import.meta).run({
  logger: yamlTableConsoleLogger,
  prompts: isAgent() ? undefined : createBuiltInPrompts(),
});
