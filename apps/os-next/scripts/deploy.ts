import { fileURLToPath } from "node:url";
import { createCli } from "trpc-cli";
import { osNextEnvs } from "../../../envs.ts";
import { deployApp } from "../../../scripts/lib/deploy-app.ts";
import { build } from "./build.ts";

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
    // THE TWO SECRETS a deployment holds (src/app-config.ts): the `APP_CONFIG` object — its `login`
    // and `secrets` halves; the `urls` half is the generated config's vars — and the at-rest key
    // alone, so it can rotate with `previousKey` beside it. Both from Doppler.
    requiredSecrets: ["APP_CONFIG", "APP_CONFIG_SECRETS__KEY"],
    // wrangler bundles src/worker.ts itself: the deploy is `wrangler deploy --config wrangler.jsonc
    // --env <name>` on the generated config's env block; `prepare` writes that config and the
    // generated modules (scripts/build.ts) first. There is no schema step: the catalog is the
    // `control-plane` facet's own SQLite (src/control-plane/), migrated by the facet itself.
    build: "checked-in-config",
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
