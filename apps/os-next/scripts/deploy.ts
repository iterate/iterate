import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createCli } from "trpc-cli";
import { osNextEnvs } from "../../../envs.ts";
import { deployApp } from "../../../scripts/lib/deploy-app.ts";
import { removeWorkerSecrets } from "../../../scripts/lib/deploy-helpers.ts";
import { build } from "./build.ts";

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
    requiredSecrets: [
      "APP_CONFIG_ADMIN_API_SECRET",
      "APP_CONFIG_SESSION_SECRET",
      "APP_CONFIG_SECRETS_KEY",
    ],
    optionalSecrets: ["APP_CONFIG_GOOGLE_CLIENT_ID", "APP_CONFIG_GOOGLE_CLIENT_SECRET"],
    // wrangler bundles src/worker.ts itself: the deploy is `wrangler deploy --config wrangler.jsonc
    // --env <name>` on the generated config's env block; `prepare` writes that config, the generated
    // modules and the console bundle (scripts/build.ts) first.
    build: "checked-in-config",
    async prepare(ctx) {
      await build();
      const sql = readFileSync(new URL("../src/control-plane.sql", import.meta.url), "utf8");
      const query = (sql: string) =>
        ctx.cf(`/d1/database/${ctx.env.resources.directoryDbId}/query`, {
          method: "POST",
          body: JSON.stringify({ sql }),
        });
      await query(sql);
      // 2026-09-18: a project's id is minted (prj_<hex>) and its slug a column of its own. A
      // directory from before has slug-ids and no slug column; bring it over once — the old rows
      // keep their slugs and get new ids (their contexts start over: the id names the DO). Delete
      // this once every deployed directory (prd, the preview slots) has been through a deploy.
      await query("ALTER TABLE projects ADD COLUMN slug text").catch((error: unknown) => {
        if (!/duplicate column/.test(String(error))) throw error;
      });
      await query(
        `UPDATE projects SET slug = id WHERE slug IS NULL;
UPDATE projects SET id = 'prj_' || lower(hex(randomblob(16))) WHERE id NOT LIKE 'prj_%';
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_slug ON projects (slug);`,
      );
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
