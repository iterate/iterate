import { fileURLToPath } from "node:url";
import { createCli } from "trpc-cli";
import { OS_DOPPLER_PROJECT, osEnvs } from "../../../envs.ts";
import { deployApp } from "../../../scripts/lib/deploy-app.ts";
import { build } from "./build.ts";
import { applyD1Migrations } from "./d1.ts";

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
    // The control plane's D1 is migrated before the code that reads it uploads, so a migration that
    // fails leaves the running version serving; a migration must keep that version working for the
    // minute until the upload (scripts/d1.ts).
    async prepare(ctx, _secretValues, credentials) {
      await build();
      await applyD1Migrations(ctx.cf, {
        databaseName: `${ctx.env.resourceNamePrefix}-db`,
        databaseId: ctx.env.resources.dbId,
        credentials: {
          CLOUDFLARE_API_TOKEN: credentials.CLOUDFLARE_API_TOKEN!,
          CLOUDFLARE_ACCOUNT_ID: credentials.CLOUDFLARE_ACCOUNT_ID!,
        },
      });
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
