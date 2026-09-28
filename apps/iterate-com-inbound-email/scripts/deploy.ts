import { fileURLToPath } from "node:url";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { iterateComInboundEmailEnvs } from "../../../envs.ts";
import { deployApp } from "../../../scripts/lib/deploy-app.ts";

/** vite build → wrangler deploy (scripts/lib/deploy-app.ts). The Worker answers no HTTP, so there is
 *  nothing to smoke: Email Routing's catch-all on iterate.com reaches it by name. */
export default async function deploy(options: { env?: string } = {}) {
  await deployApp({
    appRoot: fileURLToPath(new URL("..", import.meta.url)),
    appLabel: "apps/iterate-com-inbound-email",
    envs: iterateComInboundEmailEnvs,
    dopplerProject: "_shared",
    env: options.env,
    workerName: (env) => env.workerName,
    servingUrl: () => "Email Routing on iterate.com",
    smokes: () => [],
  });
}

if (process.argv[1]?.endsWith("deploy.ts")) {
  void createCli({ ...import.meta, name: "deploy" }).run({
    logger: yamlTableConsoleLogger,
    prompts: isAgent() ? undefined : createBuiltInPrompts(),
  });
}
