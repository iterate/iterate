import { fileURLToPath } from "node:url";
import { createCli } from "trpc-cli";
import { notesEnvs } from "../../../envs.ts";
import { deployApp } from "../../../scripts/lib/deploy-app.ts";

export default async function deploy(options: { env?: string } = {}) {
  await deployApp({
    appRoot: fileURLToPath(new URL("..", import.meta.url)),
    appLabel: "apps/notes",
    envs: notesEnvs,
    dopplerProject: "notes",
    env: options.env,
    workerName: (env) => env.workerName,
    servingUrl: (env) => env.baseUrl,
    smokes: (env) => [
      { url: `${env.baseUrl}/healthz`, ok: (status) => status === 200, label: "health" },
    ],
  });
}
if (process.argv[1]?.endsWith("deploy.ts"))
  void createCli({ ...import.meta, name: "deploy" }).run();
