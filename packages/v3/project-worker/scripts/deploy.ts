import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createCli } from "trpc-cli";
import { projectWorkerEnvs } from "../../../../envs.ts";
import { deployApp } from "../../../../scripts/lib/deploy-app.ts";

export default async function deploy(options: { env?: string } = {}) {
  await deployApp({
    appRoot: fileURLToPath(new URL("..", import.meta.url)),
    appLabel: "packages/v3/project-worker",
    envs: projectWorkerEnvs,
    dopplerProject: "project-worker",
    env: options.env,
    workerName: (env) => env.workerName,
    servingUrl: (env) => env.baseUrl,
    resources: (env) => env.resources,
    requiredSecrets: [
      "APP_CONFIG_ADMIN_API_SECRET",
      "APP_CONFIG_SESSION_SECRET",
      "APP_CONFIG_PROJECT_TOKEN_SECRET",
    ],
    optionalSecrets: ["APP_CONFIG_GOOGLE_CLIENT_ID", "APP_CONFIG_GOOGLE_CLIENT_SECRET"],
    async prepare(ctx) {
      const sql = readFileSync(new URL("../src/control-plane.sql", import.meta.url), "utf8");
      await ctx.cf(`/d1/database/${ctx.env.resources.directoryDbId}/query`, {
        method: "POST",
        body: JSON.stringify({ sql }),
      });
    },
    smokes: (env) => [
      { url: `${env.baseUrl}/version`, ok: (status) => status === 200, label: "version" },
      {
        url: `${env.baseUrl}/.well-known/oauth-authorization-server`,
        ok: (status) => status === 200,
        label: "OAuth discovery",
      },
      { url: `${env.mcpBaseUrl}/`, ok: (status) => status === 401, label: "MCP bearer challenge" },
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
