import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createCli } from "trpc-cli";
import { osNextEnvs } from "../../../envs.ts";
import { deployApp } from "../../../scripts/lib/deploy-app.ts";
import { removeWorkerSecrets } from "../../../scripts/lib/deploy-helpers.ts";

/** Worker secrets earlier deploys wrote that this code no longer reads. `wrangler deploy
 *  --secrets-file` preserves a secret it does not name, so a deploy removes these from the live
 *  Worker (deploy-helpers.ts `removeWorkerSecrets`) — AFTER the upload and its smokes, never before:
 *  the code being replaced may still REQUIRE the secret (it did — removing it ahead of an upload
 *  that then failed left the old code booting without it, 1101 on every request, 2026-09-14),
 *  while the new code only warns about a straggler (src/app-config.ts). So the order is: upload
 *  code that tolerates the secret, prove it serves, then retire the secret.
 *  APP_CONFIG_PROJECT_TOKEN_SECRET signed the deleted project tokens — OAuth grants are the one
 *  credential now. */
const RETIRED_WORKER_SECRETS = ["APP_CONFIG_PROJECT_TOKEN_SECRET"] as const;

export default async function deploy(options: { env?: string } = {}) {
  await deployApp({
    appRoot: fileURLToPath(new URL("..", import.meta.url)),
    appLabel: "apps/os-next",
    envs: osNextEnvs,
    dopplerProject: "project-worker",
    env: options.env,
    workerName: (env) => env.workerName,
    servingUrl: (env) => env.baseUrl,
    resources: (env) => env.resources,
    requiredSecrets: ["APP_CONFIG_ADMIN_API_SECRET", "APP_CONFIG_SESSION_SECRET"],
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
      { url: env.mcpBaseUrl, ok: (status) => status === 401, label: "MCP bearer challenge" },
      {
        url: `${env.baseUrl}/api`,
        ok: (status) => status === 401,
        label: "Cap’n Web bearer challenge",
      },
    ],
    async afterDeploy(ctx) {
      await removeWorkerSecrets({
        cf: ctx.cf,
        workerName: ctx.env.workerName,
        secretNames: RETIRED_WORKER_SECRETS,
      });
    },
  });
}
if (process.argv[1]?.endsWith("deploy.ts"))
  void createCli({ ...import.meta, name: "deploy" }).run();
