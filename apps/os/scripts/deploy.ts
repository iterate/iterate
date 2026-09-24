import { fileURLToPath } from "node:url";
import { createCli } from "trpc-cli";
import { OS_DOPPLER_PROJECT, osEnvs } from "../../../envs.ts";
import { deployApp } from "../../../scripts/lib/deploy-app.ts";
import { build } from "./build.ts";

export default async function deploy(
  options: {
    env?: string;
    /** Deploy with no routes, beside the Worker its hostnames still reach (deployApp
     *  `withoutRoutes`): the first step of moving a deployment to a new Worker. */
    withoutRoutes?: boolean;
  } = {},
) {
  await deployApp({
    withoutRoutes: options.withoutRoutes,
    appRoot: fileURLToPath(new URL("..", import.meta.url)),
    appLabel: "apps/os",
    envs: osEnvs,
    dopplerProject: OS_DOPPLER_PROJECT,
    env: options.env,
    workerName: (env) => env.workerName,
    servingUrl: (env) => env.baseUrl,
    resources: (env) => env.resources,
    // The private login settings and at-rest key come from Doppler. Public URLs come from envs.ts.
    requiredSecrets: ["APP_CONFIG", "APP_CONFIG_SECRETS__KEY"],
    async prepare() {
      await build();
    },
    smokes: (env) => [
      { url: `${env.baseUrl}/version`, ok: (status) => status === 200, label: "version" },
      {
        url: `${env.baseUrl}/.well-known/oauth-authorization-server`,
        ok: (status) => status === 200,
        label: "OAuth discovery",
      },
      { url: env.mcpBaseUrl, ok: (status) => status === 401, label: "MCP bearer challenge" },
      {
        url: `${env.baseUrl}/api`,
        ok: (status) => status === 401,
        label: "Cap’n Web bearer challenge",
      },
    ],
  });
}
if (process.argv[1]?.endsWith("deploy.ts"))
  void createCli({ ...import.meta, name: "deploy" }).run();
