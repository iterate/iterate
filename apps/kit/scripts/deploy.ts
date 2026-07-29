import { fileURLToPath } from "node:url";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { kitEnvs } from "../../../envs.ts";
import { deployApp } from "../../../scripts/lib/deploy-app.ts";
import { DEFAULT_DEVICE_ID, DEFAULT_FIRMWARE_VERSION } from "../src/firmware/catalog.ts";
import { writeWranglerConfig } from "./generate-wrangler-config.ts";
import { syncFirmwareAssets } from "./sync-firmware-assets.ts";

export default async function deploy(options: { env?: string } = {}) {
  await deployApp({
    appRoot: fileURLToPath(new URL("..", import.meta.url)),
    appLabel: "apps/kit",
    envs: kitEnvs,
    dopplerProject: "kit",
    env: options.env,
    workerName: (env) => env.workerName,
    servingUrl: (env) => env.baseUrl,
    prepare: async () => {
      writeWranglerConfig();
      await syncFirmwareAssets();
    },
    smokes: (env) => [
      {
        url: `${env.baseUrl}/devices/${DEFAULT_DEVICE_ID}/firmware/${DEFAULT_FIRMWARE_VERSION}?host=os.iterate.com&project=`,
        ok: (status) => status === 200,
        label: "installer",
      },
    ],
  });
}

if (process.argv[1]?.endsWith("deploy.ts")) {
  void createCli({ ...import.meta, name: "deploy" }).run({
    logger: yamlTableConsoleLogger,
    prompts: isAgent() ? undefined : createBuiltInPrompts(),
  });
}
